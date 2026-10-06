/**
 * 位移监测领域模型。
 *
 * 与通用台账（EntryRow）不同：位移监测的核心数据是「测点 + 逐测次观测」，
 * 累计位移、超限判定都必须从逐测次观测值推导，空值（缺测/中断）绝不参与求和，
 * 因此单独建领域类型，页面、超限清单、导出成果全部读同一份推导结果。
 */

/** 测次状态：ok 正常观测；missing 缺测（整次未测）；interrupted 中断（测了但未完成）。 */
export type RoundStatus = 'ok' | 'missing' | 'interrupted'

/** 缺测/中断原因枚举，登记缺测时必须给出原因，空态也要有说明。 */
export type MissingReason =
  | '测点被覆盖'
  | '仪器故障'
  | '天气原因停测'
  | '施工干扰'
  | '外业中断未复测'
  | '历史资料缺失'
  | '测点尚未首测'
  | '其他'

export const MISSING_REASONS: MissingReason[] = [
  '测点被覆盖',
  '仪器故障',
  '天气原因停测',
  '施工干扰',
  '外业中断未复测',
  '历史资料缺失',
  '测点尚未首测',
  '其他',
]

/**
 * 一次测次观测。
 * - 正常观测：status='ok'，水平增量/垂直增量为数值（mm，本期相对上期）。
 * - 缺测/中断：status 非 ok，增量一律为 null，reason 必填；
 *   中断允许带已完成的高程读数（measuredElevation），但增量仍为空。
 */
export type Observation = {
  id: number
  pointCode: string
  date: string
  status: RoundStatus
  /** 本期水平位移增量（mm）；缺测/中断为 null，绝不写 0。 */
  horizontal: number | null
  /** 本期垂直位移增量（mm）；缺测/中断为 null，绝不写 0。 */
  vertical: number | null
  /** 本期测点实测高程（m），可空，不参与累计位移。 */
  measuredElevation: number | null
  reason: MissingReason | ''
  note: string
  /** 复核标记：提交复核只标最新正常测次，不改变超限口径。 */
  reviewed?: boolean
  /** legacy 表示由存量数据迁移/历史回填产生，import 表示外业整套导入。 */
  source: 'import' | 'legacy'
  /** 入库时间戳，最先入库的一稿以此为准。 */  receivedAt: number
}

/** 位移测点台账。 */
export type DisplacementPoint = {
  id: number
  code: string
  location: string
  /** 测点高程（m）：测点台账属性，建点时必填，与逐测次实测高程分开。 */
  elevation: number
  /** 允许位移（mm）：合成位移阈值，超限判定只跟它比。 */
  limitMm: number
  frequency: string
  createdAt: number
}

/**
 * 测点判定结果：列表、超限清单、导出共用的「同一份」派生视图，
 * 任何页面都不许自己另算累计位移或自己判超限。
 */
export type PointVerdict =
  | {
      point: DisplacementPoint
      judgement: 'normal'
      /** 累计水平位移（仅累加 status='ok' 测次的增量）。 */
      cumulativeHorizontal: number
      cumulativeVertical: number
      /** 合成位移 sqrt(H²+V²)，超限判定唯一使用的量。 */
      magnitude: number
      limitMm: number
      latest: Observation
      rounds: number
      missingRounds: Observation[]
      missingCount: number
    }
  | {
      point: DisplacementPoint
      judgement: 'overLimit'
      cumulativeHorizontal: number
      cumulativeVertical: number
      magnitude: number
      limitMm: number
      latest: Observation
      rounds: number
      missingRounds: Observation[]
      missingCount: number
    }
  | {
      point: DisplacementPoint
      judgement: 'unknown'
      cumulativeHorizontal: null
      cumulativeVertical: null
      magnitude: null
      limitMm: number
      latest: Observation | null
      rounds: number
      missingRounds: Observation[]
      missingCount: number
      /** 暂不可判定原因（空态或最新测次中断）。 */
      unknownReason: string
    }

export type DisplacementState = {
  points: DisplacementPoint[]
  observations: Observation[]
  /** 迁移报告：存量数据中按规则补出的缺测/缺失字段，页面上单独罗列。 */
  migrationNotes: string[]
  /** 已经据超限结果登记过缺陷的测点编号，避免重复登记。 */
  defectLinkedCodes: string[]
  seq: { point: number; observation: number }
  /** 用于让已经播过种的旧浏览器跳过存量迁移。 */
  version: number
}

/** 提交/导入结果。整笔事务：不通过则一条都不写入。 */
export type SubmitResult = {
  ok: boolean
  message: string
  /** 整笔拒绝时逐行列明的问题（含缺失字段、重复测次）。 */
  rowErrors: { line: number; problems: string[] }[]
  accepted: number
  rejected: number
  /** 本笔新判超限/恢复的测点，用于同步设备缺陷清单。 */
  newlyOverLimit: DisplacementPoint[]
  newlyNormal: DisplacementPoint[]
}
