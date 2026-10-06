import type {
  DispObservation,
  DispPoint,
  GapView,
  JudgeReason,
  JudgeState,
  Overview,
  PointView,
} from './types'

/**
 * 位移计算与超限判定的唯一口径：列表、超限清单、导出 CSV 全部调用这里，
 * 保证页面看到几条超限，另存的位移成果里就是几条。
 */

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 有效测次：有业务日期、observed=true、水平与垂直都有数。缺测不参与任何数值计算。 */
export function isValid(obs: DispObservation): boolean {
  return (
    obs.observed &&
    obs.date !== '' &&
    obs.horizontal !== null &&
    obs.vertical !== null
  )
}

export function fmt(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return ''
  }
  return String(round3(value))
}

export function pointObservations(point: DispPoint, all: DispObservation[]): DispObservation[] {
  return all
    .filter((obs) => obs.pointId === point.id && obs.date !== '')
    .sort((a, b) => a.date.localeCompare(b.date))
}

function cumulative(
  point: DispPoint,
  valid: DispObservation[],
): { horizontal: number; vertical: number; total: number } | null {
  if (valid.length === 0) {
    return null
  }
  // 以该测点首个有效测次（基准）为零点：只对有取值的测次累加，缺测跳过，绝不把空当 0。
  const base = valid[0]
  const last = valid[valid.length - 1]
  const dh = (last.horizontal ?? 0) - (base.horizontal ?? 0)
  const dv = (last.vertical ?? 0) - (base.vertical ?? 0)
  return { horizontal: round3(dh), vertical: round3(dv), total: round3(Math.hypot(dh, dv)) }
}

function judge(
  point: DispPoint,
  dated: DispObservation[],
  valid: DispObservation[],
  cum: { horizontal: number; vertical: number; total: number } | null,
): { state: JudgeState; reason: JudgeReason; statusText: string } {
  // 缺允许位移，任何观测都判不了；缺高程属字段缺失，但只要允许位移在、仍可按测值判定。
  if (point.allowable === null) {
    return { state: '暂不可判定', reason: '缺少允许位移', statusText: '暂不可判定·缺少允许位移' }
  }
  if (valid.length === 0) {
    // 一个取值都没有：空态，不能当成位移为 0。
    return { state: '暂不可判定', reason: '空态', statusText: '暂不可判定·空态' }
  }
  if (dated.length > 0 && !dated[dated.length - 1].observed) {
    // 最后一测次缺测：序列中断，旧累计不能代表当前，暂停超限判定。
    return { state: '暂不可判定', reason: '观测中断', statusText: '暂不可判定·观测中断' }
  }
  return (cum?.total ?? 0) > point.allowable
    ? { state: '超限', reason: '', statusText: '超限' }
    : { state: '正常', reason: '', statusText: '正常' }
}

export function buildPointView(point: DispPoint, all: DispObservation[]): PointView {
  const dated = pointObservations(point, all)
  const valid = dated.filter(isValid)
  const missing = dated.filter((obs) => !obs.observed)
  const cum = cumulative(point, valid)
  const { state, reason, statusText } = judge(point, dated, valid, cum)
  const gapFields: string[] = []
  if (point.elevation === null) {
    gapFields.push('测点高程')
  }
  if (point.allowable === null) {
    gapFields.push('允许位移')
  }
  return {
    point,
    statusText,
    state,
    reason,
    dated,
    valid,
    missing,
    first: valid[0] ?? null,
    latest: valid[valid.length - 1] ?? null,
    cumulative: cum,
    gapFields,
  }
}

export function buildOverview(points: DispPoint[], observations: DispObservation[]): Overview {
  const views = points
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((point) => buildPointView(point, observations))
  const overlimit = views.filter((view) => view.state === '超限')
  const pending = views.filter((view) => view.state === '暂不可判定')
  const normal = views.filter((view) => view.state === '正常')

  const gaps: GapView[] = []
  for (const view of views) {
    // 缺测测次单独留空并注明缺测原因
    for (const obs of view.missing) {
      gaps.push({
        kind: '缺测',
        pointCode: view.point.code,
        date: obs.date,
        field: '水平位移/垂直位移',
        reason: obs.reason || '未注明原因',
      })
    }
    // 空态：从无有效取值，单独说明
    if (view.reason === '空态') {
      gaps.push({
        kind: '空态',
        pointCode: view.point.code,
        date: '',
        field: '全部测次',
        reason: '尚无有效观测取值，累计位移留空，不按 0 判定',
      })
    }
    // 观测中断：末测次缺测，旧结果不能沿用
    if (view.reason === '观测中断') {
      const last = view.dated[view.dated.length - 1]
      gaps.push({
        kind: '观测中断',
        pointCode: view.point.code,
        date: last?.date ?? '',
        field: '当前测次',
        reason: last?.reason || '最近一测次缺测，暂停超限判定',
      })
    }
    // 测点档案缺字段，单独罗列
    for (const field of view.gapFields) {
      gaps.push({
        kind: '字段缺失',
        pointCode: view.point.code,
        date: '',
        field,
        reason: field === '测点高程' ? '测点高程未填，不影响位移计算但档案不完整' : '无允许位移，超限判定无法进行',
      })
    }
  }
  // 存量补录不到业务日期的记录：整次不进序列，作为缺项列出
  for (const obs of observations.filter((item) => item.date === '')) {
    gaps.push({
      kind: '字段缺失',
      pointCode: points.find((point) => point.id === obs.pointId)?.code ?? `#${obs.pointId}`,
      date: '',
      field: '观测日期',
      reason: `存量记录无观测日期，${obs.observed ? '取值暂不计入累计' : '缺测原因：' + obs.reason || '缺测'}，按业务日期补数后生效`,
    })
  }

  return {
    points: views,
    overlimit,
    pending,
    normal,
    gaps,
    observations: observations.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
    undated: observations.filter((obs) => obs.date === ''),
    batches: [],
    stats: {
      totalPoints: views.length,
      overlimit: overlimit.length,
      pending: pending.length,
      missingRounds: gaps.filter((gap) => gap.kind === '缺测').length,
      fieldGaps: gaps.filter((gap) => gap.kind === '字段缺失').length
        + gaps.filter((gap) => gap.kind === '空态' || gap.kind === '观测中断').length,
    },
  }
}
