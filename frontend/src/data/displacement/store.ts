import type { DisplacementPoint, DisplacementState, Observation } from './types'
import { displacementSeed } from './seed'
import { recognizeLegacy } from './logic'
import type { LegacyCell } from './logic'

// 位移领域单独存储：旧的通用台账键 hydropower-plant-om:entries 保持不动。
const STATE_KEY = 'hydropower-plant-om:displacement:v2'
const LEGACY_KEY = 'hydropower-plant-om:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 存量迁移：从旧通用台账里把 displacement 记录捞回来，按观测日期对齐成逐测次数据。
 * 旧台账每个「测点」只有一条扁平记录，拿不出逐测次序列，因此按以下规则补：
 * - 编号、高程、允许位移（原「允许位移」字段能解析成数则用，否则给默认阈值）建成测点；
 * - 「水平位移/垂直位移」是文字占位（样例数据）→ 一轮缺测，原因「历史资料缺失」；
 * - 识别规则全部走 recognizeLegacy，缺失字段进迁移报告单独罗列。
 * 历史取值对齐方式：旧记录没有观测日期序列，统一以记录中的日期（无日期则用播种月
 * 2026-09 的各天）作为业务日期补一轮到该测点；缺值不补 0，只补缺测标记。
 */
function migrateLegacy(fallback: DisplacementState): DisplacementState {
  if (typeof window === 'undefined' || !window.localStorage) return fallback
  const raw = window.localStorage.getItem(LEGACY_KEY)
  if (!raw) return fallback
  let legacyRows: Record<string, unknown>[] = []
  try {
    const parsed = JSON.parse(raw) as { displacement?: Record<string, unknown>[] }
    legacyRows = parsed.displacement ?? []
  } catch {
    return fallback
  }
  if (!Array.isArray(legacyRows) || legacyRows.length === 0) return fallback

  const state = clone(fallback)
  const notes: string[] = []
  let pointSeq = state.seq.point
  let obsSeq = state.seq.observation
  const baseTime = Date.parse('2026-09-01T09:00:00')

  legacyRows.forEach((row, index) => {
    const code = String(row['测点编号'] ?? `DISP-LEGACY-${index + 1}`)
    if (state.points.some((point) => point.code === code)) return
    const elevationText = String(row['测点高程'] ?? '')
    const limitText = String(row['允许位移'] ?? '')
    const elevNum = /^-?\d+(\.\d+)?$/.test(elevationText.trim()) ? Number(elevationText) : 0
    const limitNum = /^\d+(\.\d+)?$/.test(limitText.trim()) ? Number(limitText) : 20
    const date = typeof row['监测日期'] === 'string' && row['监测日期'] ? String(row['监测日期']) : `2026-09-${String(index + 1).padStart(2, '0')}`

    const point: DisplacementPoint = {
      id: pointSeq++,
      code,
      location: `存量迁移测点 ${code}`,
      elevation: elevNum,
      limitMm: limitNum,
      frequency: '1次/月',
      createdAt: baseTime + index,
    }
    state.points.push(point)

    const cells: LegacyCell[] = [
      {
        date,
        statusText: String(row['测点状态'] ?? ''),
        horizontalText: String(row['水平位移'] ?? ''),
        verticalText: String(row['垂直位移'] ?? ''),
        elevationText: elevationText,
      },
    ]
    const { observations, notes: cellNotes } = recognizeLegacy(code, cells)
    notes.push(...cellNotes)
    observations.forEach((cell) => {
      state.observations.push({
        id: obsSeq++,
        pointCode: code,
        date: cell.date,
        status: cell.status,
        horizontal: cell.h,
        vertical: cell.v,
        measuredElevation: cell.elev,
        reason: cell.reason,
        note: '存量台账迁移',
        source: 'legacy',
        receivedAt: baseTime + index,
      })
    })
  })

  if (notes.length) state.migrationNotes.unshift(...notes)
  state.seq = { point: pointSeq, observation: obsSeq }
  return state
}

let cache: DisplacementState | null = null

export function displacementState(): DisplacementState {
  if (cache) return cache
  const seed = displacementSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = seed
    return cache
  }
  const raw = window.localStorage.getItem(STATE_KEY)
  if (raw) {
    try {
      cache = JSON.parse(raw) as DisplacementState
      return cache
    } catch {
      // 损坏时落到迁移/播种，不把异常吞成空数据
    }
  }
  cache = migrateLegacy(seed)
  persist(cache)
  return cache
}

export function persistDisplacement(state: DisplacementState): void {
  cache = state
  persist(state)
}

function persist(state: DisplacementState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state))
  }
}

/** 仅测试用：重置内存缓存。 */
export function resetDisplacementCache(): void {
  cache = null
}

/**
 * 并发提交锁：纯前端没有事务，用同步锁 + 持久化令牌双保险。
 * 同一时刻只允许一笔写入，后到的整笔拒绝；锁在事件循环内同步获取/释放，
 * 正常用户操作不存在并发交叉，双提交（双击/重复回调）会被挡下。
 */
let submitting = false

export function acquireSubmitLock(): boolean {
  if (submitting) return false
  submitting = true
  return true
}

export function releaseSubmitLock(): void {
  submitting = false
}

/** 幂等键：同一测点同一观测日期只留最先入库的一条。 */
export function existingRoundKeys(state: DisplacementState): Set<string> {
  return new Set(state.observations.map((o) => `${o.pointCode}|${o.date}`))
}

export function pointCodes(state: DisplacementState): Set<string> {
  return new Set(state.points.map((point) => point.code))
}

export function nextObservationId(state: DisplacementState): number {
  state.seq.observation += 1
  return state.seq.observation
}

export function appendObservations(state: DisplacementState, rows: Omit<Observation, 'id' | 'receivedAt'>[]): DisplacementState {
  const receivedAt = Date.now()
  const observations = [...state.observations]
  rows.forEach((row, index) => {
    observations.push({ ...row, id: state.seq.observation + index + 1, receivedAt: receivedAt + index })
  })
  state.seq.observation += rows.length
  return { ...state, observations }
}
