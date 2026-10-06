import { SEED_ROWS } from '@/data/seed'
import type { EntryRow } from '@/data/types'

import { displacementSeed } from './seed-v2'
import type { DispObservation, DispPoint, DispState } from './types'

const STORE_KEY = 'hydropower-plant-om:displacement-v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readV1Rows(): EntryRow[] | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem('hydropower-plant-om:entries')
  if (!raw) {
    return null // 全新浏览器：没有任何存量，直接用 v2 示例
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const rows = parsed.displacement ?? null
    if (!rows || rows.length === 0) {
      return null
    }
    // 脚手架示例数据的特征串（生成器把文本字段统一填成「位移监测样例N」）：
    // 这不是真实存量，直接走 v2 示例，不做迁移。
    const looksLikeScaffold = rows.every((row) =>
      ['测点高程', '水平位移', '垂直位移', '累计位移', '允许位移'].every((field) =>
        String(row[field] ?? '').includes('位移监测样例'),
      ),
    )
    return looksLikeScaffold ? null : rows
  } catch {
    return null
  }
}

function num(value: unknown): { n: number | null; unparsed: boolean } {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { n: null, unparsed: false }
  }
  const n = Number(String(value).trim())
  return Number.isFinite(n) ? { n, unparsed: false } : { n: null, unparsed: true }
}

/**
 * 存量迁移：把 v1 扁平位移行（测点与测值挤在一行、空值当 0）拆成「测点档案 + 测次」。
 *
 * 「早期缺测却写成 0」的识别规则（按业务日期排好序后）：
 *  1. 首测（或首测前连续的 0）视为真实基准观测，保留为有效 0；
 *  2. 该测点一旦出现过非零有效观测，其后出现的水平/垂直全 0 测次，
 *     判为「缺测误录为 0」，转缺测、测值留空、原因注明「存量0值识别为缺测」；
 *  3. 解析不成数值的文本（如脚手架示例串）记为字段缺失，不臆造数值；
 *  4. 旧表无观测日期列：不臆造日期，测次保留但日期留空、不进序列，
 *     在缺项清单挂「观测日期缺失」，等按业务日期补数。
 * 旧行自带的「累计位移」不可信（空被当 0、会翻倍），迁移后一律由引擎按有效测次重算。
 */
function migrateV1(rows: EntryRow[]): DispState {
  const now = Date.now()
  const state = displacementSeed(now)
  // 迁移数据替换示例：历史稿为真。编号从 100 起避免与示例占位冲突。
  state.points = []
  state.observations = []
  state.nextPointId = 100
  state.nextObservationId = 100
  state.migratedAt = now

  const notes: string[] = []
  // v1 同一「测点编号」的多行 = 同一测点按观测日期回填的多个测次，先按编号合并测点档案。
  const pointIdByCode = new Map<string, number>()

  const codeOf = (row: EntryRow): string => {
    const code = String(row['测点编号'] ?? '').trim()
    return code || `DISP-M${row.id}`
  }

  for (const row of rows) {
    const code = codeOf(row)
    if (pointIdByCode.has(code)) {
      continue
    }
    const id = state.nextPointId++
    pointIdByCode.set(code, id)
    const elev = num(row['测点高程'])
    const allow = num(row['允许位移'])
    state.points.push({
      id,
      code,
      location: '',
      elevation: elev.n,
      allowable: allow.n,
      frequency: String(row['监测频次'] ?? '').trim(),
      reviewedAt: null,
      createdAt: now,
    })
    if (elev.unparsed) {
      notes.push(`测点 ${code}：测点高程「${row['测点高程']}」无法识别为数值，按字段缺失处理`)
    }
    if (allow.unparsed) {
      notes.push(`测点 ${code}：允许位移「${row['允许位移']}」无法识别为数值，按字段缺失处理`)
    }
  }

  let zeroTurnedMissing = 0
  let undated = 0
  for (const row of rows) {
    const code = codeOf(row)
    const pointId = pointIdByCode.get(code)!
    const dateRaw = String(row['观测日期'] ?? '').trim()
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : ''
    if (!date) {
      undated++
    }
    const h = num(row['水平位移'])
    const v = num(row['垂直位移'])
    const textBad = h.unparsed || v.unparsed

    const obs: DispObservation = {
      id: state.nextObservationId++,
      pointId,
      date,
      observed: !textBad,
      horizontal: textBad ? null : h.n,
      vertical: textBad ? null : v.n,
      reason: textBad ? '存量记录取值无法识别为数值，待按业务日期补数' : '',
      source: 'legacy',
      batchId: null,
      createdAt: now,
    }
    state.observations.push(obs)
    if (textBad) {
      notes.push(`测点 ${code}：水平/垂直位移取值无法识别，测次留空待补`)
    }
  }

  // 按测点做 0→缺测 识别：排序后只处理有业务日期的测次
  for (const point of state.points) {
    const series = state.observations
      .filter((obs) => obs.pointId === point.id && obs.date !== '' && obs.observed)
      .sort((a, b) => a.date.localeCompare(b.date))
    let seenNonZero = false
    for (const obs of series) {
      if ((obs.horizontal ?? 0) !== 0 || (obs.vertical ?? 0) !== 0) {
        seenNonZero = true
        continue
      }
      if (seenNonZero) {
        obs.observed = false
        obs.horizontal = null
        obs.vertical = null
        obs.reason = '存量0值识别为缺测：此前已有非零有效观测，本次全0判为缺测误录，需外业核实补数'
        zeroTurnedMissing++
      }
    }
  }

  notes.unshift(
    `按观测日期回填：${pointIdByCode.size} 个测点合并 ${state.observations.length} 条存量测次；` +
      `${zeroTurnedMissing} 条「先非零后全 0」测次按规则识别为缺测；${undated} 条无观测日期已挂缺项待补；旧累计位移作废，全部按有效测次重算。`,
  )
  state.migrationNotes = notes
  return state
}

let cache: DispState | null = null
// 模块级写入锁：同一时刻只允许一笔提交走完读-判-写，并发点击的第二笔直接拒绝。
let writing = false

function init(): DispState {
  if (cache) {
    return cache
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (raw) {
      try {
        cache = JSON.parse(raw) as DispState
        return cache
      } catch {
        // 落盘坏了就当没有，下面重建
      }
    }
  }
  const v1 = readV1Rows()
  cache = v1 && v1.length > 0 ? migrateV1(v1) : displacementSeed()
  persist(cache)
  return cache
}

function persist(state: DispState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(state))
  }
}

export const displacementStore = {
  state(): DispState {
    return init()
  },
  /**
   * 在锁内完成一次「读状态→改→落盘」。拿不到锁说明已有一笔正在提交，整笔拒绝。
   * mutate 内可抛 RejectError 表达业务拒绝（整笔不写入），错误冒泡给调用方。
   */
  commit(mutate: (state: DispState) => void): { locked: boolean; error?: Error } {
    if (writing) {
      return { locked: true }
    }
    writing = true
    try {
      const draft = clone(init())
      mutate(draft)
      persist(draft)
      return { locked: false }
    } catch (error) {
      return { locked: false, error: error instanceof Error ? error : new Error(String(error)) }
    } finally {
      writing = false
    }
  },
  reset(seedOnly: boolean): DispState {
    const fresh = seedOnly
      ? displacementSeed()
      : (() => {
          const v1 = readV1Rows()
          return v1 && v1.length > 0 ? migrateV1(v1) : displacementSeed()
        })()
    persist(fresh)
    return fresh
  },
  storageKey(): string {
    return STORE_KEY
  },
  // 供测试直接构造状态
  seedForTest: displacementSeed,
}
