/**
 * 位移监测纯计算：累计位移、超限判定、批量校验、存量数据识别规则都在这里，
 * 不碰 localStorage、不碰 DOM，方便用 node 直接验证。
 */
import type {
  DisplacementPoint,
  MissingReason,
  Observation,
  PointVerdict,
  RoundStatus,
  SubmitResult,
} from './types'

const round = (value: number): number => Math.round(value * 1000) / 1000

/** 严格数值解析：空串、null、非法文本一律视为「无取值」，绝不退化成 0。 */
export function parseNullableNumber(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null
  return Number(text)
}

export function isValidDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) return false
  const date = new Date(`${text.trim()}T00:00:00`)
  return !Number.isNaN(date.getTime())
}

/** 数值保留两位小数的字符串展示。 */
export function fmt(value: number | null): string {
  return value === null ? '' : String(round(value))
}

/**
 * 累计位移：只累加 status='ok' 的测次增量。
 * 缺测/中断（horizontal/vertical 为 null）直接跳过，不当 0 加，
 * 这样「缺一次观测」不会污染累计值，也不会触发越限标记乱亮。
 */
export function cumulative(observations: Observation[]): { h: number; v: number } {
  let h = 0
  let v = 0
  for (const obs of observations) {
    if (obs.status !== 'ok') continue
    if (obs.horizontal !== null) h = round(h + obs.horizontal)
    if (obs.vertical !== null) v = round(v + obs.vertical)
  }
  return { h, v }
}

export function magnitude(h: number, v: number): number {
  return round(Math.sqrt(h * h + v * v))
}

/** 同一测点的测次按观测日期升序排列（同日期按入库先后）。 */
export function sortRounds(observations: Observation[]): Observation[] {
  return [...observations].sort((a, b) =>
    a.date === b.date ? a.receivedAt - b.receivedAt : a.date < b.date ? -1 : 1,
  )
}

/**
 * 测点判定（列表与超限清单的唯一数据源）：
 * - 一条正常测次都没有（含从未首测的空态）→ 暂不可判定；
 * - 最新测次缺测/中断（观测中断）→ 暂不可判定，不沿用旧值判超限；
 * - 其余按累计合成位移与允许位移比较，缺测测次只展示、不参与计算。
 */
export function judgePoint(point: DisplacementPoint, all: Observation[]): PointVerdict {
  const rounds = sortRounds(all.filter((o) => o.pointCode === point.code))
  const missingRounds = rounds.filter((o) => o.status !== 'ok')
  const common = {
    point,
    limitMm: point.limitMm,
    latest: rounds[rounds.length - 1] ?? null,
    rounds: rounds.length,
    missingRounds,
    missingCount: missingRounds.length,
  }

  const okRounds = rounds.filter((o) => o.status === 'ok')
  if (okRounds.length === 0) {
    const reason =
      rounds.length === 0
        ? '尚未取得任何有效观测（空态），暂不可判定'
        : `尚无正常测次，已有 ${missingRounds.length} 次缺测/中断，暂不可判定`
    return { ...common, judgement: 'unknown', cumulativeHorizontal: null, cumulativeVertical: null, magnitude: null, unknownReason: reason }
  }

  const latest = rounds[rounds.length - 1]
  if (latest.status !== 'ok') {
    const label = latest.status === 'missing' ? '缺测' : '观测中断'
    return {
      ...common,
      latest,
      judgement: 'unknown',
      cumulativeHorizontal: null,
      cumulativeVertical: null,
      magnitude: null,
      unknownReason: `最新测次（${latest.date}）${label}：${latest.reason || '未注明原因'}，暂不可判定`,
    }
  }

  const { h, v } = cumulative(rounds)
  const mag = magnitude(h, v)
  return {
    ...common,
    latest,
    judgement: mag > point.limitMm ? 'overLimit' : 'normal',
    cumulativeHorizontal: h,
    cumulativeVertical: v,
    magnitude: mag,
  }
}

export function judgeAll(points: DisplacementPoint[], observations: Observation[]): PointVerdict[] {
  return points.map((point) => judgePoint(point, observations))
}

/** 测点业务状态：超限 / 观测中 / 待观测（暂不可判定也归入待观测并单独列示）。 */
export function pointStatus(verdict: PointVerdict): string {
  if (verdict.judgement === 'overLimit') return '超限'
  if (verdict.judgement === 'unknown' && verdict.rounds === 0) return '待观测'
  return verdict.judgement === 'normal' ? '观测中' : '待观测'
}

export type ParsedRound = {
  pointCode: string
  date: string
  status: RoundStatus
  horizontal: number | null
  vertical: number | null
  measuredElevation: number | null
  reason: MissingReason | ''
  note: string
}

const STATUS_TOKENS: Record<string, RoundStatus> = {
  正常: 'ok',
  观测: 'ok',
  缺测: 'missing',
  中断: 'interrupted',
}

/**
 * 解析整套观测提交（TSV/CSV：测点编号 观测日期 状态 水平增量 垂直增量 实测高程 原因 备注）。
 * 第一行表头可给可不给；逐行校验，错误全部收集——缺失字段单独罗列。
 */
export function parseBatch(
  text: string,
  knownCodes: Set<string>,
  existingKey: Set<string>,
): { rows: ParsedRound[]; errors: { line: number; problems: string[] }[] } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const rows: ParsedRound[] = []
  const errors: { line: number; problems: string[] }[] = []
  const seenThisBatch = new Set<string>()

  lines.forEach((line, index) => {
    const lineNo = index + 1
    const cells = line.split(/[,\t，]/).map((cell) => cell.trim())
    if (index === 0 && /测点编号/.test(cells[0] ?? '')) return // 跳过表头

    const problems: string[] = []
    const [codeRaw, dateRaw, statusRaw, hRaw, vRaw, elevRaw, reasonRaw, noteRaw] = cells
    const code = codeRaw ?? ''
    const date = dateRaw ?? ''
    const statusToken = statusRaw ?? ''

    if (!code) problems.push('缺少测点编号')
    else if (!knownCodes.has(code)) problems.push(`测点 ${code} 未登记`)
    if (!date) problems.push('缺少观测日期')
    else if (!isValidDate(date)) problems.push(`观测日期「${date}」格式应为 YYYY-MM-DD`)
    const status = STATUS_TOKENS[statusToken]
    if (!status) problems.push(`测次状态「${statusToken}」应为 正常/缺测/中断`)

    const h = parseNullableNumber(hRaw ?? '')
    const v = parseNullableNumber(vRaw ?? '')
    const elev = parseNullableNumber(elevRaw ?? '')

    let reason: MissingReason | '' = (reasonRaw as MissingReason) || ''
    if (reasonRaw && !reason) reason = '其他'

    if (status === 'ok') {
      if (h === null) problems.push('正常测次缺少水平位移取值（缺取值请按缺测登记，不能留空当 0）')
      if (v === null) problems.push('正常测次缺少垂直位移取值（缺取值请按缺测登记，不能留空当 0）')
      if ((hRaw ?? '').trim() !== '' && h === null) problems.push('水平位移不是合法数值')
      if ((vRaw ?? '').trim() !== '' && v === null) problems.push('垂直位移不是合法数值')
    }
    if (status === 'missing' || status === 'interrupted') {
      // 缺测/中断：位移留空是硬性要求；若填了 0 或别的数，说明是拿缺值当 0，直接退回。
      if ((hRaw ?? '').trim() !== '' || (vRaw ?? '').trim() !== '') {
        problems.push('缺测/中断测次不得填位移值，应留空并注明原因')
      }
      if (!reasonRaw) problems.push(status === 'missing' ? '缺测必须注明缺测原因' : '中断必须注明中断原因')
    }
    if ((elevRaw ?? '').trim() !== '' && elev === null) problems.push('实测高程不是合法数值')

    const key = `${code}|${date}`
    if (code && date) {
      if (existingKey.has(key)) problems.push(`${date} 已有观测：重复提交只保留最先入库一稿，本笔整套退回`)
      if (seenThisBatch.has(key)) problems.push(`${date} 在本批数据内重复`)
      seenThisBatch.add(key)
    }

    if (problems.length) {
      errors.push({ line: lineNo, problems })
      return
    }
    rows.push({
      pointCode: code,
      date,
      status: status as RoundStatus,
      horizontal: status === 'ok' ? h : null,
      vertical: status === 'ok' ? v : null,
      measuredElevation: elev,
      reason,
      note: noteRaw ?? '',
    })
  })

  return { rows, errors }
}

/**
 * 存量数据「早期缺测却写成 0」的识别规则（迁移专用，规则固定可解释）：
 * 1. 非数值文本（如占位样例文字）→ 该轮无有效观测，直接判缺测，原因「历史资料缺失」；
 * 2. 数值 0 只有在「该测点此前从未出现过非零读数」且「前后相邻测次至少有一条非零」
 *    时才判为伪 0 缺测——位移为 0 本身合法（稳定不动），所以首个观测基线 0 和持续
 *    稳定的连续 0 都保留，只揪「夹在真实变动之间的孤立 0」和「未动过却写 0」之外
 *    被当 0 的缺测；
 * 3. 状态字段填了（外业状态已填）但高程、位移取值缺失的一轮，判中断；
 * 4. 识别结果全部写入迁移报告，缺失字段单独罗列，不静默改数。
 */
export type LegacyCell = {
  date: string
  statusText: string
  horizontalText: string
  verticalText: string
  elevationText: string
}

export function recognizeLegacy(code: string, cells: LegacyCell[]): {
  observations: { date: string; status: RoundStatus; h: number | null; v: number | null; elev: number | null; reason: MissingReason | '' }[]
  notes: string[]
} {
  const observations: ReturnType<typeof recognizeLegacy>['observations'] = []
  const notes: string[] = []
  const sorted = [...cells].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  let seenNonZero = false

  sorted.forEach((cell, i) => {
    const hNum = parseNullableNumber(cell.horizontalText)
    const vNum = parseNullableNumber(cell.verticalText)
    const elevNum = parseNullableNumber(cell.elevationText)
    const isText = (text: string) => text.trim() !== '' && parseNullableNumber(text) === null
    const missingFields: string[] = []
    if (cell.horizontalText.trim() === '') missingFields.push('水平位移')
    if (cell.verticalText.trim() === '') missingFields.push('垂直位移')
    if (cell.elevationText.trim() === '') missingFields.push('实测高程')

    // 规则 1：取值位是文字占位，历史资料缺失。
    if (isText(cell.horizontalText) || isText(cell.verticalText)) {
      observations.push({ date: cell.date, status: 'missing', h: null, v: null, elev: elevNum, reason: '历史资料缺失' })
      notes.push(`${code} ${cell.date}：位移取值为非数值记录，按缺测处理（历史资料缺失），不计入累计位移`)
      seenNonZero = false
      return
    }

    // 规则 3：外业状态填了，但高程没填（或位移没填）→ 外业中断。
    const fieldIncomplete = missingFields.length > 0
    if (cell.statusText.trim() !== '' && fieldIncomplete) {
      observations.push({
        date: cell.date,
        status: 'interrupted',
        h: null,
        v: null,
        elev: elevNum,
        reason: '外业中断未复测',
      })
      notes.push(`${code} ${cell.date}：外业状态已填但缺失 ${missingFields.join('、')}，按观测中断处理，不当 0 计入累计位移`)
      return
    }

    // 取值完全缺失且无状态说明 → 缺测，缺失字段罗列。
    if (hNum === null && vNum === null) {
      observations.push({ date: cell.date, status: 'missing', h: null, v: null, elev: elevNum, reason: '历史资料缺失' })
      notes.push(`${code} ${cell.date}：缺失 ${missingFields.join('、') || '位移取值'}，按缺测处理（历史资料缺失）`)
      return
    }

    const isZero = (n: number | null) => n === 0
    const prev = observations[i - 1]
    const nextRaw = sorted[i + 1]
    const nextNum = nextRaw ? parseNullableNumber(nextRaw.horizontalText) : null
    const neighborNonZero =
      (prev && ((prev.h !== null && prev.h !== 0) || (prev.v !== null && prev.v !== 0))) ||
      (nextNum !== null && nextNum !== 0)

    // 规则 2：伪 0 缺测——此前从未出现非零读数则是观测基线 0，予以保留；
    // 已出现过真实变动，且本轮为 0、相邻又有非零，判为夹在变动间的伪 0。
    if (hNum !== null && vNum !== null && isZero(hNum) && isZero(vNum) && seenNonZero && neighborNonZero) {
      observations.push({ date: cell.date, status: 'missing', h: null, v: null, elev: elevNum, reason: '历史资料缺失' })
      notes.push(`${code} ${cell.date}：位移记录为 0 但夹在非零变动测次之间，识别为「缺测写成 0」，已留空不计入累计位移`)
      return
    }

    observations.push({
      date: cell.date,
      status: 'ok',
      h: hNum ?? 0,
      v: vNum ?? 0,
      elev: elevNum,
      reason: '',
    })
    if ((hNum !== null && hNum !== 0) || (vNum !== null && vNum !== 0)) seenNonZero = true
  })

  return { observations, notes }
}

/**
 * 历史资料回填解析（按业务日期补数，规则比外业提交宽松）：
 * - 观测日期必填且合法，测点必须已登记，重复键整笔退回；
 * - 位移取值缺失不退回、不当 0：自动登记为缺测（原因「历史资料缺失」），
 *   缺失了哪些字段逐行列入 missingNotes，页面单独罗列；
 * - 高程缺失不影响累计位移，只登记到缺失字段清单。
 * 历史取值对齐方式：一律按观测日期升序对齐为逐测次，增量即记录值，
 * 无法还原增量时以首条非缺测记录为基线（其增量记作 0 基线，不累加出虚假位移）。
 */
export function parseHistory(
  text: string,
  knownCodes: Set<string>,
  existingKey: Set<string>,
): {
  rows: ParsedRound[]
  errors: { line: number; problems: string[] }[]
  missingNotes: { line: number; text: string }[]
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const rows: ParsedRound[] = []
  const errors: { line: number; problems: string[] }[] = []
  const missingNotes: { line: number; text: string }[] = []
  const seenThisBatch = new Set<string>()

  lines.forEach((line, index) => {
    const lineNo = index + 1
    const cells = line.split(/[,\t，]/).map((cell) => cell.trim())
    if (index === 0 && /测点编号/.test(cells[0] ?? '')) return

    const problems: string[] = []
    const [codeRaw, dateRaw, statusRaw, hRaw, vRaw, elevRaw, reasonRaw, noteRaw] = cells
    const code = codeRaw ?? ''
    const date = dateRaw ?? ''
    if (!code) problems.push('缺少测点编号')
    else if (!knownCodes.has(code)) problems.push(`测点 ${code} 未登记`)
    if (!date) problems.push('历史补数必须带观测日期（按业务日期对齐）')
    else if (!isValidDate(date)) problems.push(`观测日期「${date}」格式应为 YYYY-MM-DD`)

    const key = `${code}|${date}`
    if (code && date) {
      if (existingKey.has(key)) problems.push(`${date} 已有观测：最先入库一稿为准，本笔补数整套退回`)
      if (seenThisBatch.has(key)) problems.push(`${date} 在本批数据内重复`)
      seenThisBatch.add(key)
    }
    if (problems.length) {
      errors.push({ line: lineNo, problems })
      return
    }

    const h = parseNullableNumber(hRaw ?? '')
    const v = parseNullableNumber(vRaw ?? '')
    const elev = parseNullableNumber(elevRaw ?? '')
    const declared = STATUS_TOKENS[statusRaw ?? '']
    const missingFields: string[] = []
    if ((hRaw ?? '').trim() === '') missingFields.push('水平位移')
    if ((vRaw ?? '').trim() === '') missingFields.push('垂直位移')
    if ((elevRaw ?? '').trim() === '') missingFields.push('实测高程')

    let status: RoundStatus = declared ?? (missingFields.includes('水平位移') && missingFields.includes('垂直位移') ? 'missing' : 'ok')
    if (declared === 'ok' && (h === null || v === null)) {
      // 声称正常但没有取值：历史资料不能猜 0，降为缺测并备注。
      status = 'missing'
      missingNotes.push({ line: lineNo, text: `${code} ${date}：标注正常但位移取值缺失，改按缺测登记（历史资料缺失）` })
    }
    let reason: MissingReason | '' = (reasonRaw as MissingReason) || ''
    if (reasonRaw && !reason) reason = '历史资料缺失'
    if (status !== 'ok' && !reason) reason = '历史资料缺失'
    if (missingFields.length) {
      missingNotes.push({ line: lineNo, text: `${code} ${date}：历史记录缺失 ${missingFields.join('、')}，已单列；缺值不计 0` })
    }

    rows.push({
      pointCode: code,
      date,
      status,
      horizontal: status === 'ok' ? h : null,
      vertical: status === 'ok' ? v : null,
      measuredElevation: elev,
      reason,
      note: noteRaw ?? (status === 'missing' ? '历史补数：取值缺失' : '历史补数'),
    })
  })

  return { rows, errors, missingNotes }
}

export function buildSubmitFailure(
  message: string,
  errors: { line: number; problems: string[] }[],
): SubmitResult {
  const rejected = errors.reduce((sum, item) => sum + 1, 0)
  // 重复测次属于「后到整套退回」，顶层提示直接点明，避免调用方只看 message 漏掉。
  const duplicate = errors.some((item) => item.problems.some((p) => /退回|重复/.test(p)))
  return {
    ok: false,
    message: rejected > 0 ? `${message}（${rejected} 行有问题，${duplicate ? '后到整套退回' : '整笔未写入'}）` : message,
    rowErrors: errors,
    accepted: 0,
    rejected,
    newlyOverLimit: [],
    newlyNormal: [],
  }
}
