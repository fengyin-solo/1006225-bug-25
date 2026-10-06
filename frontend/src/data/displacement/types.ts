/** 位移监测领域模型：测点档案与观测测次分开存，缺测是显式状态而不是 0。 */

// 测点档案：高程、允许位移是测点属性，与某一测次的观测值彻底分开。
export type DispPoint = {
  id: number
  code: string
  location: string
  elevation: number | null // 测点高程（m），外业没填就是 null，不允许拿 0 顶
  allowable: number | null // 允许位移（mm），缺了就无法做超限判定
  frequency: string // 监测频次
  reviewedAt: number | null // 最近一次复核的入库时间；新测次到达后旧复核自动失效
  createdAt: number
}

// 一次测次：同一测点同一业务日期只允许一条。
// observed=false 表示缺测：水平/垂直位移必须为 null，reason 必填缺测原因。
export type DispObservation = {
  id: number
  pointId: number
  date: string // 业务日期 YYYY-MM-DD；存量补录不到日期时为空串，整次不参与序列
  observed: boolean
  horizontal: number | null // mm
  vertical: number | null // mm
  reason: string // 缺测原因；有效测次为 ''
  source: 'seed' | 'manual' | 'import' | 'legacy'
  batchId: number | null
  createdAt: number
}

// 每次成功提交（单测次录入与整套导入同源）留一稿指纹，后到的同稿整套退回。
export type DispBatch = {
  id: number
  fingerprint: string
  source: 'manual' | 'import'
  operator: string
  accepted: number
  preview: string
  createdAt: number
}

export type DispState = {
  version: 2
  clock: number // 入库先后的单调时钟：「以最先入库的一稿为准」靠它
  nextPointId: number
  nextObservationId: number
  nextBatchId: number
  points: DispPoint[]
  observations: DispObservation[]
  batches: DispBatch[]
  migratedAt: number | null
  migrationNotes: string[]
}

export type SubmitRow = {
  code: string
  date: string
  observed: boolean
  horizontal: number | null
  vertical: number | null
  reason: string
}

export type ServiceResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

// 判定结论：超限就是超限，判不了的一律走「暂不可判定」并说明原因，不混在一起。
export type JudgeState = '正常' | '超限' | '暂不可判定'
export type JudgeReason = '' | '空态' | '观测中断' | '缺少允许位移'

export type PointView = {
  point: DispPoint
  statusText: string
  state: JudgeState
  reason: JudgeReason
  dated: DispObservation[] // 按业务日期排序的测次（不含日期缺失的存量记录）
  valid: DispObservation[]
  missing: DispObservation[]
  first: DispObservation | null
  latest: DispObservation | null
  cumulative: { horizontal: number; vertical: number; total: number } | null
  gapFields: string[] // 测点级缺失字段
}

export type GapView = {
  kind: '缺测' | '空态' | '观测中断' | '字段缺失'
  pointCode: string
  date: string
  field: string
  reason: string
}

export type Overview = {
  points: PointView[]
  overlimit: PointView[]
  pending: PointView[] // 暂不可判定
  normal: PointView[]
  gaps: GapView[]
  observations: DispObservation[]
  undated: DispObservation[]
  batches: DispBatch[]
  stats: {
    totalPoints: number
    overlimit: number
    pending: number
    missingRounds: number
    fieldGaps: number
  }
}
