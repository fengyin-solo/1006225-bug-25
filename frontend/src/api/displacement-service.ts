/**
 * 位移监测业务服务：页面只调这里，所有写操作都是整笔事务。
 * - 提交/历史回填：先全部校验，任一行不通过则一条不写（后到的整套退回）；
 * - 并发：acquireSubmitLock 保证同一时刻只有第一笔生效；
 * - 幂等：测点编号+观测日期为键，最先入库一稿为准；
 * - 超限缺陷：判定状态变化同步写入设备缺陷清单（defect 模块，另一个入口可见）。
 */
import { saveRows, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  acquireSubmitLock,
  appendObservations,
  displacementState,
  existingRoundKeys,
  persistDisplacement,
  pointCodes,
  releaseSubmitLock,
} from '@/data/displacement/store'
import {
  buildSubmitFailure,
  fmt,
  judgeAll,
  parseBatch,
  parseHistory,
  pointStatus,
} from '@/data/displacement/logic'
import type {
  DisplacementPoint,
  DisplacementState,
  Observation,
  PointVerdict,
  SubmitResult,
} from '@/data/displacement/types'

const DEFECT_KEY = 'defect'
const SOURCE_TAG = '位移超限自动登记'

export type PointView = {
  id: number
  code: string
  location: string
  elevation: number
  cumulativeHorizontal: string
  cumulativeVertical: string
  magnitude: string
  limitMm: number
  latestDate: string
  latestStatus: string
  missingInfo: string
  status: string
  reviewed: boolean
  rounds: number
  missingCount: number
}

export function verdicts(): PointVerdict[] {
  const state = displacementState()
  return judgeAll(state.points, state.observations)
}

export function migrationNotes(): string[] {
  return displacementState().migrationNotes
}

function statusLabel(obs: Observation | null): string {
  if (!obs) return '未观测'
  if (obs.status === 'ok') return '正常'
  if (obs.status === 'missing') return `缺测（${obs.reason || '未注明原因'}）`
  return `中断（${obs.reason || '未注明原因'}）`
}

/** 测点列表与超限清单共用此视图，杜绝两处口径不一致。 */
export function pointViews(): PointView[] {
  return verdicts().map((verdict) => {
    const unknown = verdict.judgement === 'unknown'
    return {
      id: verdict.point.id,
      code: verdict.point.code,
      location: verdict.point.location,
      elevation: verdict.point.elevation,
      cumulativeHorizontal: unknown ? '—' : fmt(verdict.cumulativeHorizontal),
      cumulativeVertical: unknown ? '—' : fmt(verdict.cumulativeVertical),
      magnitude: unknown ? '—' : fmt(verdict.magnitude),
      limitMm: verdict.limitMm,
      latestDate: verdict.latest?.date ?? '—',
      latestStatus: statusLabel(verdict.latest),
      missingInfo:
        verdict.missingCount === 0
          ? '无'
          : verdict.missingRounds.map((round) => `${round.date} ${statusLabel(round)}`).join('；'),
      status: pointStatus(verdict),
      reviewed: verdict.judgement !== 'unknown' ? Boolean(verdict.latest?.reviewed) : false,
      rounds: verdict.rounds,
      missingCount: verdict.missingCount,
    }
  })
}

export function overLimitVerdicts(): Extract<PointVerdict, { judgement: 'overLimit' }>[] {
  return verdicts().filter((v): v is Extract<PointVerdict, { judgement: 'overLimit' }> => v.judgement === 'overLimit')
}

export function unknownVerdicts(): Extract<PointVerdict, { judgement: 'unknown' }>[] {
  return verdicts().filter((v): v is Extract<PointVerdict, { judgement: 'unknown' }> => v.judgement === 'unknown')
}

export function roundsFor(code: string): Observation[] {
  const state = displacementState()
  return [...state.observations.filter((o) => o.pointCode === code)].sort((a, b) =>
    a.date === b.date ? a.receivedAt - b.receivedAt : a.date < b.date ? -1 : 1,
  )
}

function commitWithDefectSync(
  state: DisplacementState,
  before: Map<string, PointVerdict['judgement']>,
): { newlyOverLimit: DisplacementPoint[]; newlyNormal: DisplacementPoint[] } {
  const after = judgeAll(state.points, state.observations)
  const newlyOverLimit: DisplacementPoint[] = []
  const newlyNormal: DisplacementPoint[] = []
  for (const verdict of after) {
    const previous = before.get(verdict.point.code)
    if (verdict.judgement === 'overLimit' && previous !== 'overLimit') newlyOverLimit.push(verdict.point)
    if (verdict.judgement === 'normal' && previous === 'overLimit') newlyNormal.push(verdict.point)
  }
  const linked = syncDefects(newlyOverLimit, state.defectLinkedCodes)
  state.defectLinkedCodes = linked
  persistDisplacement(state)
  return { newlyOverLimit, newlyNormal }
}

/**
 * 把超限测点写进设备缺陷清单（通用 defect 模块），缺陷处置页作为另一个入口同样看得到。
 * 同一测点只登记一条（按来源标识去重），重复提交/重复导入不会加两遍。
 */
function syncDefects(points: DisplacementPoint[], linked: string[]): string[] {
  if (points.length === 0) return linked
  const defects = listRows(DEFECT_KEY)
  const next = [...defects]
  let seq = defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const today = new Date().toISOString().slice(0, 10)
  const linkedNext = [...linked]

  for (const point of points) {
    const exists =
      linkedNext.includes(point.code) ||
      next.some((row) => String(row['缺陷描述'] ?? '').includes(`${point.code}`) && String(row['设备名称'] ?? '').includes('位移'))
    if (exists) {
      if (!linkedNext.includes(point.code)) linkedNext.push(point.code)
      continue
    }
    seq += 1
    const row: EntryRow = {
      id: seq,
      status: '待处理',
      pending: true,
      abnormal: true,
      缺陷编号: `DEFE-DISP-${String(seq).padStart(4, '0')}`,
      设备名称: `位移测点 ${point.code}`,
      缺陷描述: `${SOURCE_TAG}：${point.code}（${point.location}）累计合成位移超过允许值 ${point.limitMm}mm`,
      缺陷等级: '紧急',
      发现日期: today,
      处理期限: '',
      处理人员: '',
      缺陷状态: '待处理',
      关联来源: `${SOURCE_TAG} ${point.code} ${today}`,
    }
    next.push(row)
    linkedNext.push(point.code)
  }
  saveRows(DEFECT_KEY, next)
  return linkedNext
}

export function submitBatch(text: string): SubmitResult {
  return applyBatch(text, false)
}

export function backfillHistory(text: string): SubmitResult {
  return applyBatch(text, true)
}

function applyBatch(text: string, history: boolean): SubmitResult {
  if (!acquireSubmitLock()) {
    return {
      ok: false,
      message: '有一笔观测正在提交，并发提交只接受第一笔，本笔整笔拒绝写入',
      rowErrors: [],
      accepted: 0,
      rejected: 0,
      newlyOverLimit: [],
      newlyNormal: [],
    }
  }
  try {
    const state = displacementState()
    const before = new Map(verdicts().map((v) => [v.point.code, v.judgement]))
    const parsed = history
      ? parseHistory(text, pointCodes(state), existingRoundKeys(state))
      : { ...parseBatch(text, pointCodes(state), existingRoundKeys(state)), missingNotes: [] as { line: number; text: string }[] }
    const errors = parsed.errors
    if (errors.length > 0) {
      return buildSubmitFailure(history ? '历史补数校验未通过，整笔未写入' : '观测提交校验未通过，整笔未写入', errors)
    }
    if (parsed.rows.length === 0) {
      return buildSubmitFailure('没有可写入的观测行', [])
    }

    // 幂等最后一道闸：解析通过到写入之间若已有同键数据（重复提交），整笔退回。
    const refreshed = displacementState()
    const currentKeys = existingRoundKeys(refreshed)
    const clash = parsed.rows.find((row) => currentKeys.has(`${row.pointCode}|${row.date}`))
    if (clash) {
      return buildSubmitFailure(`${clash.pointCode} ${clash.date} 已入库：以最先入库一稿为准，本笔整套退回`, [])
    }

    let nextState = appendObservations(
      refreshed,
      parsed.rows.map((row) => ({
        pointCode: row.pointCode,
        date: row.date,
        status: row.status,
        horizontal: row.horizontal,
        vertical: row.vertical,
        measuredElevation: row.measuredElevation,
        reason: row.reason,
        note: row.note,
        source: history ? 'legacy' : 'import',
      })),
    )

    const migrationNotes = history ? parsed.missingNotes.map((n: { text: string }) => n.text) : []
    if (migrationNotes.length) {
      nextState = { ...nextState, migrationNotes: [...nextState.migrationNotes, ...migrationNotes] }
    }

    const { newlyOverLimit, newlyNormal } = commitWithDefectSync(nextState, before)
    return {
      ok: true,
      message: `${history ? '历史补数' : '观测提交'}成功：写入 ${parsed.rows.length} 条，缺测/中断未计入累计位移` +
        (migrationNotes.length ? `；另有 ${migrationNotes.length} 条缺失字段已单独罗列` : ''),
      rowErrors: [],
      accepted: parsed.rows.length,
      rejected: 0,
      newlyOverLimit,
      newlyNormal,
    }
  } finally {
    releaseSubmitLock()
  }
}

export function registerPoint(input: {
  code: string
  location: string
  elevation: string
  limitMm: string
  frequency: string
}): SubmitResult {
  const problems: string[] = []
  const code = input.code.trim()
  if (!code) problems.push('测点编号必填')
  const elevation = input.elevation.trim() === '' ? null : Number(input.elevation)
  const limitMm = input.limitMm.trim() === '' ? null : Number(input.limitMm)
  if (elevation === null || Number.isNaN(elevation)) problems.push('测点高程必填（建点台账高程，不能与逐测次取值混为一谈）')
  if (limitMm === null || Number.isNaN(limitMm) || limitMm <= 0) problems.push('允许位移必须为正数')
  if (!acquireSubmitLock()) {
    return { ok: false, message: '有一笔提交正在处理，请稍后再试', rowErrors: [], accepted: 0, rejected: 0, newlyOverLimit: [], newlyNormal: [] }
  }
  try {
    const state = displacementState()
    if (state.points.some((point) => point.code === code)) problems.push(`测点 ${code} 已存在，重复登记被拒绝`)
    if (problems.length) return buildSubmitFailure('测点登记未通过', [{ line: 1, problems }])
    const point: DisplacementPoint = {
      id: state.seq.point,
      code,
      location: input.location.trim() || '—',
      elevation: elevation as number,
      limitMm: limitMm as number,
      frequency: input.frequency.trim() || '1次/月',
      createdAt: Date.now(),
    }
    const nextState: DisplacementState = {
      ...state,
      points: [...state.points, point],
      seq: { ...state.seq, point: state.seq.point + 1 },
    }
    persistDisplacement(nextState)
    return { ok: true, message: `测点 ${code} 已登记，尚无观测，处于空态待观测`, rowErrors: [], accepted: 1, rejected: 0, newlyOverLimit: [], newlyNormal: [] }
  } finally {
    releaseSubmitLock()
  }
}

/** 提交复核：在最新正常测次上标注，不改变超限判定口径。 */
export function reviewPoint(code: string): SubmitResult {
  const state = displacementState()
  const allRounds = state.observations
    .filter((o) => o.pointCode === code)
    .sort((a, b) => (a.date === b.date ? a.receivedAt - b.receivedAt : a.date < b.date ? -1 : 1))
  const lastRound = allRounds[allRounds.length - 1]
  if (!lastRound) {
    return buildSubmitFailure('该测点尚无任何测次（空态），暂不可复核', [{ line: 1, problems: ['空态测点先补观测'] }])
  }
  if (lastRound.status !== 'ok') {
    return buildSubmitFailure(`最新测次（${lastRound.date}）${lastRound.status === 'missing' ? '缺测' : '中断'}，暂不可判定，不能复核`, [
      { line: 1, problems: ['须先补测恢复正常测次'] },
    ])
  }
  const latest = lastRound
  if (latest.reviewed) {
    return buildSubmitFailure('该测次已复核，无需重复操作', [])
  }
  const observations = state.observations.map((o) =>
    o.id === latest.id ? { ...o, reviewed: true, note: o.note || '已复核' } : o,
  )
  persistDisplacement({ ...state, observations })
  return { ok: true, message: `${code} 最新测次已提交复核`, rowErrors: [], accepted: 1, rejected: 0, newlyOverLimit: [], newlyNormal: [] }
}

export type DisplacementSummary = {
  total: number
  observing: number
  overLimit: number
  unknown: number
  missingRounds: number
}

export function summary(): DisplacementSummary {
  const all = verdicts()
  return {
    total: all.length,
    observing: all.filter((v) => v.judgement === 'normal').length,
    overLimit: all.filter((v) => v.judgement === 'overLimit').length,
    unknown: all.filter((v) => v.judgement === 'unknown').length,
    missingRounds: all.reduce((sum, v) => sum + v.missingCount, 0),
  }
}

/**
 * 另存位移成果（CSV）：明细清单、超限清单、暂不可判定清单、缺测测次明细、
 * 存量迁移缺项说明同一批导出。超限条数直接取 overLimitVerdicts().length，
 * 与页面超限清单严格一致。
 */
export function exportDisplacementCsv(): { filename: string; content: string } {
  const all = verdicts()
  const sections: string[] = []

  sections.push(['# 测点明细清单（缺测不计入累计位移）'].join(','))
  sections.push(
    ['测点编号', '位置', '测点高程(m)', '累计水平(mm)', '累计垂直(mm)', '合成位移(mm)', '允许位移(mm)', '判定', '最新测次', '缺测情况'].join(','),
  )
  for (const v of all) {
    sections.push(
      [
        v.point.code,
        v.point.location,
        v.point.elevation,
        v.judgement === 'unknown' ? '' : fmt(v.cumulativeHorizontal),
        v.judgement === 'unknown' ? '' : fmt(v.cumulativeVertical),
        v.judgement === 'unknown' ? '' : fmt(v.magnitude),
        v.limitMm,
        v.judgement === 'overLimit' ? '超限' : v.judgement === 'normal' ? '正常' : '暂不可判定',
        v.latest ? `${v.latest.date} ${statusLabel(v.latest)}` : '空态',
        v.missingCount === 0 ? '无' : v.missingRounds.map((r) => `${r.date}${r.status === 'missing' ? '缺测' : '中断'}(${r.reason})`).join('；'),
      ].join(','),
    )
  }

  const over = all.filter((v) => v.judgement === 'overLimit')
  sections.push('')
  sections.push(`# 超限清单（共 ${over.length} 条，与页面一致）`)
  sections.push(['测点编号', '位置', '合成位移(mm)', '允许位移(mm)', '超出量(mm)'].join(','))
  for (const v of over) {
    sections.push(
      [v.point.code, v.point.location, fmt(v.magnitude), v.limitMm, fmt((v as { magnitude: number }).magnitude - v.limitMm)].join(','),
    )
  }

  const unknown = all.filter((v) => v.judgement === 'unknown')
  sections.push('')
  sections.push(`# 暂不可判定清单（共 ${unknown.length} 条，不计入超限）`)
  sections.push(['测点编号', '位置', '原因'].join(','))
  for (const v of unknown) {
    sections.push([v.point.code, v.point.location, (v as { unknownReason: string }).unknownReason].join(','))
  }

  const state = displacementState()
  sections.push('')
  sections.push(`# 缺测/中断测次明细（共 ${state.observations.filter((o) => o.status !== 'ok').length} 条，累计位移已跳过）`)
  sections.push(['测点编号', '观测日期', '类型', '原因', '备注', '来源'].join(','))
  for (const o of state.observations.filter((x) => x.status !== 'ok')) {
    sections.push([o.pointCode, o.date, o.status === 'missing' ? '缺测' : '中断', o.reason, o.note, o.source === 'legacy' ? '存量迁移' : '外业提交'].join(','))
  }

  if (state.migrationNotes.length) {
    sections.push('')
    sections.push('# 存量数据回填与缺项识别说明')
    state.migrationNotes.forEach((note) => sections.push(note))
  }

  return { filename: `位移监测成果-${new Date().toISOString().slice(0, 10)}.csv`, content: `﻿${sections.join('\n')}` }
}

export function downloadDisplacementCsv(): void {
  const { filename, content } = exportDisplacementCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
