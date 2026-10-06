import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { buildOverview, fmt } from './engine'
import { displacementStore } from './store'
import type {
  DispObservation,
  DispState,
  Overview,
  ServiceResult,
  SubmitRow,
} from './types'

function nowClock(state: DispState): number {
  state.clock += 1
  return state.clock
}

/** 整套稿的指纹：同一批内容重复提交（包括刷新后再传）只认最先入库的一稿。 */
function fingerprint(rows: SubmitRow[], source: 'manual' | 'import'): string {
  const body = rows
    .map((row) =>
      [
        row.code.trim(),
        row.date,
        row.observed ? '1' : '0',
        row.horizontal === null ? '' : String(row.horizontal),
        row.vertical === null ? '' : String(row.vertical),
        row.reason.trim(),
      ].join('|'),
    )
    .sort()
    .join(';')
  return `${source}:${body}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validate(rows: SubmitRow[], state: DispState): string {
  if (rows.length === 0) {
    return '没有可提交的测次：空表不允许入库'
  }
  const pointByCode = new Map(state.points.map((point) => [point.code, point]))
  const seen = new Set<string>()
  for (const row of rows) {
    const code = row.code.trim()
    if (!code) {
      return '存在未填写测点编号的测次，整笔退回'
    }
    const point = pointByCode.get(code)
    if (!point) {
      return `测点 ${code} 尚未建档，整笔退回（先在测点档案补建，再提交观测）`
    }
    if (!DATE_RE.test(row.date)) {
      return `测点 ${code} 的观测日期「${row.date}」不是 YYYY-MM-DD，整笔退回`
    }
    const key = `${code}@${row.date}`
    if (seen.has(key)) {
      return `本批中 ${key} 出现重复测次，整笔退回，请去重后再提交`
    }
    seen.add(key)
    if (state.observations.some((obs) => obs.pointId === point.id && obs.date === row.date)) {
      return `测点 ${code} 在 ${row.date} 已有入库测次，后到整笔退回：以最先入库的一稿为准`
    }
    if (row.observed) {
      if (row.horizontal === null || row.vertical === null) {
        return `测点 ${code} 在 ${row.date} 标记为已观测但取值不全：没有取值不能当 0，整笔退回；确为缺测请留空取值并填写缺测原因`
      }
    } else if (row.reason.trim() === '') {
      return `测点 ${code} 在 ${row.date} 为缺测但未注明缺测原因，整笔退回`
    }
  }
  return ''
}

// ── 缺陷回写 ──────────────────────────────────────────────────────────────
// 位移超限的动作结果落到通用缺陷库（与缺陷处置页同一把 localStorage 键），
// 缺陷处置菜单就是另一个入口，看到的条数始终与超限清单一致。
function reconcileDefects(state: DispState): void {
  if (typeof window === 'undefined') {
    return
  }
  const overview = buildOverview(state.points, state.observations)
  const rows = listRows('defect')
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let changed = false
  for (const view of overview.overlimit) {
    const exists = rows.some(
      (row) => row['来源模块'] === 'displacement' && row['来源测点'] === view.point.code,
    )
    if (exists) {
      continue
    }
    const cum = view.cumulative
    const severe = cum !== null && view.point.allowable !== null && cum.total > view.point.allowable * 1.2
    const row: EntryRow = {
      id: nextId++,
      status: '待处理',
      pending: true,
      abnormal: false,
      缺陷编号: `QX-DISP-${view.point.code}`,
      设备名称: `位移测点 ${view.point.code}（${view.point.location || '位置未填'}）`,
      缺陷描述: `累计位移 ${fmt(cum?.total ?? null)} mm 超过允许位移 ${fmt(view.point.allowable)} mm（水平累计 ${fmt(cum?.horizontal ?? null)}、垂直累计 ${fmt(cum?.vertical ?? null)}），最近测次 ${view.latest?.date ?? '-'}`,
      缺陷等级: severe ? '紧急缺陷' : '重大缺陷',
      发现日期: view.latest?.date ?? '',
      处理期限: '',
      处理人员: '',
      缺陷状态: '待处理',
      来源模块: 'displacement',
      来源测点: view.point.code,
    }
    rows.push(row)
    changed = true
  }
  if (changed) {
    saveRows('defect', rows)
  }
}

function overviewOf(state: DispState): Overview {
  const overview = buildOverview(state.points, state.observations)
  overview.batches = state.batches.slice().sort((a, b) => b.createdAt - a.createdAt)
  return overview
}

// 首次进入模块时做一次幂等对账：种子/迁移带来的超限测点也要在缺陷清单（另一个入口）可见。
let defectsReconciled = false
function ensureDefectsSynced(): void {
  if (defectsReconciled) {
    return
  }
  defectsReconciled = true
  const acquired = displacementStore.commit((state) => {
    reconcileDefects(state)
  })
  void acquired
}

export function getOverview(): Overview {
  ensureDefectsSynced()
  return overviewOf(displacementStore.state())
}

export type SubmitOutcome = { accepted: number; overview: Overview; batchId: number }

class RejectError extends Error {}

/**
 * 提交一整套观测（单测次录入与整套导入同一入口、同一套规则）：
 * 先整体校验，再查重（指纹 + 测点×业务日期），最后拿模块锁一次性落盘；
 * 任何一条不过或并发落败，整笔拒绝写入，一条都不会进库。
 */
export function submitBatch(
  rawRows: SubmitRow[],
  source: 'manual' | 'import',
  operator = '值班管理员',
): ServiceResult<SubmitOutcome> {
  const rows = rawRows.map((row) => ({
    ...row,
    code: row.code.trim(),
    reason: row.reason.trim(),
    horizontal: row.observed ? row.horizontal : null,
    vertical: row.observed ? row.vertical : null,
  }))
  const stamp = fingerprint(rows, source)
  let batchId = 0

  const result = displacementStore.commit((state) => {
    if (state.batches.some((batch) => batch.fingerprint === stamp)) {
      throw new RejectError('整套内容此前已入库（以最先入库的一稿为准），后到整笔退回，重复提交只留一条')
    }
    const error = validate(rows, state)
    if (error) {
      throw new RejectError(error)
    }
    batchId = state.nextBatchId++
    const createdAt = nowClock(state)
    const pointByCode = new Map(state.points.map((point) => [point.code, point]))
    const touched = new Set<number>()
    for (const row of rows) {
      const point = pointByCode.get(row.code)!
      const obs: DispObservation = {
        id: state.nextObservationId++,
        pointId: point.id,
        date: row.date,
        observed: row.observed,
        horizontal: row.observed ? row.horizontal : null,
        vertical: row.observed ? row.vertical : null,
        reason: row.observed ? '' : row.reason,
        source,
        batchId,
        createdAt,
      }
      state.observations.push(obs)
      touched.add(point.id)
    }
    // 新测次到达，旧复核结论失效，须按最新数据重新判定
    for (const point of state.points) {
      if (touched.has(point.id)) {
        point.reviewedAt = null
      }
    }
    state.batches.push({
      id: batchId,
      fingerprint: stamp,
      source,
      operator,
      accepted: rows.length,
      preview:
        rows
          .slice(0, 3)
          .map((row) => `${row.code} ${row.date} ${row.observed ? `${row.horizontal}/${row.vertical}` : '缺测'}`)
          .join('，') + (rows.length > 3 ? ` 等${rows.length}条` : ''),
      createdAt,
    })
    reconcileDefects(state)
  })

  if (result.locked) {
    return { ok: false, message: '并发提交冲突：已有一笔正在写入，后到整笔拒绝写入，请刷新后重试' }
  }
  if (result.error) {
    return { ok: false, message: result.error.message }
  }
  return {
    ok: true,
    message: `已接收 ${rows.length} 条测次（批次 #${batchId}），累计位移按有效测次重算，超限结论以本稿为准`,
    data: { accepted: rows.length, overview: overviewOf(displacementStore.state()), batchId },
  }
}

/** 提交复核：暂不可判定的测点不允许复核；页面不做业务判断，规则全在服务层。 */
export function reviewPoint(pointId: number): ServiceResult<Overview> {
  let success = false
  let message = '复核已登记'
  const result = displacementStore.commit((state) => {
    const point = state.points.find((item) => item.id === pointId)
    if (!point) {
      throw new RejectError('没有找到该测点')
    }
    const view = buildOverview(state.points, state.observations).points.find(
      (item) => item.point.id === pointId,
    )!
    if (view.state === '暂不可判定') {
      throw new RejectError(`测点 ${point.code} 当前「${view.statusText}」暂不可判定，不能提交复核；请先补齐观测`)
    }
    point.reviewedAt = nowClock(state)
    reconcileDefects(state)
    success = true
  })
  if (result.locked) {
    return { ok: false, message: '并发提交冲突：已有一笔正在写入，后到整笔拒绝写入' }
  }
  if (result.error) {
    return { ok: false, message: result.error.message }
  }
  if (success) {
    return { ok: true, message, data: getOverview() }
  }
  return { ok: false, message: '提交未生效' }
}

/** 手动登记缺陷：仅当引擎判定为超限时接受（修「越限标记乱亮」），且幂等不重复。 */
export function registerDefect(pointId: number): ServiceResult<Overview> {
  let message = ''
  const result = displacementStore.commit((state) => {
    const view = buildOverview(state.points, state.observations).points.find(
      (item) => item.point.id === pointId,
    )
    if (!view) {
      throw new RejectError('没有找到该测点')
    }
    if (view.state !== '超限') {
      throw new RejectError(`测点 ${view.point.code} 当前为「${view.statusText}」，不允许登记超限缺陷`)
    }
    reconcileDefects(state)
    message = `测点 ${view.point.code} 的超限缺陷已在缺陷处置清单登记（幂等，不重复登记）`
  })
  if (result.locked) {
    return { ok: false, message: '并发提交冲突：已有一笔正在写入，后到整笔拒绝写入' }
  }
  if (result.error) {
    return { ok: false, message: result.error.message }
  }
  return { ok: true, message, data: getOverview() }
}

// ── 导出：报表与明细清单始终一致，分段都取自同一个 Overview ──────────────────
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csv(lines: string[][]): string {
  return '﻿' + lines.map((line) => line.map(csvCell).join(',')).join('\n')
}

export function exportDisplacement(): { filename: string; content: string } {
  const overview = getOverview()
  const lines: string[][] = []
  lines.push(['位移监测成果（缺测留空、空值不计 0、超限判定跳过缺测测次）'])
  lines.push([
    `超限测点：${overview.overlimit.length}`,
    `暂不可判定：${overview.pending.length}`,
    `缺测测次：${overview.stats.missingRounds}`,
    `空态/中断/缺项：${overview.stats.fieldGaps}`,
  ])
  lines.push([])

  lines.push(['一、测点清单（累计位移与判定口径与页面完全一致）'])
  lines.push(['测点编号', '位置', '测点高程(m)', '允许位移(mm)', '有效测次数', '累计水平(mm)', '累计垂直(mm)', '累计合位移(mm)', '判定结论', '判定说明', '已复核'])
  for (const view of overview.points) {
    lines.push([
      view.point.code,
      view.point.location,
      view.point.elevation === null ? '' : String(view.point.elevation),
      view.point.allowable === null ? '' : String(view.point.allowable),
      String(view.valid.length),
      view.cumulative === null ? '' : fmt(view.cumulative.horizontal),
      view.cumulative === null ? '' : fmt(view.cumulative.vertical),
      view.cumulative === null ? '' : fmt(view.cumulative.total),
      view.state,
      view.reason || (view.gapFields.length ? `缺：${view.gapFields.join('/')}` : ''),
      view.point.reviewedAt ? '是' : '否',
    ])
  }
  lines.push([])

  lines.push([`二、超限清单（共 ${overview.overlimit.length} 条，与页面统计一致）`])
  lines.push(['测点编号', '位置', '累计合位移(mm)', '允许位移(mm)', '最近测次日期'])
  for (const view of overview.overlimit) {
    lines.push([
      view.point.code,
      view.point.location,
      fmt(view.cumulative?.total ?? null),
      fmt(view.point.allowable),
      view.latest?.date ?? '',
    ])
  }
  lines.push([])

  lines.push([`三、暂不可判定测点（共 ${overview.pending.length} 条，不计入超限）`])
  lines.push(['测点编号', '位置', '原因', '档案缺项'])
  for (const view of overview.pending) {
    lines.push([view.point.code, view.point.location, view.reason, view.gapFields.join('/')])
  }
  lines.push([])

  lines.push(['四、缺测与缺项清单（空态、观测中断、字段缺失分别注明原因）'])
  lines.push(['类型', '测点编号', '业务日期', '缺项', '原因'])
  for (const gap of overview.gaps) {
    lines.push([gap.kind, gap.pointCode, gap.date, gap.field, gap.reason])
  }
  lines.push([])

  lines.push(['五、测次明细（同一测点同一业务日期唯一；缺测的水平/垂直留空）'])
  lines.push(['测点编号', '观测日期', '水平位移(mm)', '垂直位移(mm)', '状态', '缺测原因', '来源', '批次'])
  for (const obs of overview.observations) {
    const code = overview.points.find((view) => view.point.id === obs.pointId)?.point.code ?? `#${obs.pointId}`
    lines.push([
      code,
      obs.date || '（日期缺失）',
      obs.observed ? fmt(obs.horizontal) : '',
      obs.observed ? fmt(obs.vertical) : '',
      obs.observed ? '有效' : '缺测',
      obs.reason,
      obs.source,
      obs.batchId === null ? '' : `#${obs.batchId}`,
    ])
  }

  return { filename: '位移监测-成果清单.csv', content: csv(lines) }
}

/** 导入文本解析：每行「测点编号,日期,水平,垂直[,缺测原因]」；水平垂直都空 = 缺测，原因必填。 */
export function parseImportText(text: string): ServiceResult<SubmitRow[]> {
  const rows: SubmitRow[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  lines.forEach((line, index) => {
    const cells = line.split(/[,\t，;；]/).map((cell) => cell.trim())
    if (index === 0 && /测点|编号|date/i.test(cells[0] ?? '')) {
      return
    }
    const [code = '', date = '', hText = '', vText = '', reason = ''] = cells
    const observed = hText !== '' || vText !== ''
    const toNum = (value: string): number | null => {
      if (value === '') {
        return null
      }
      const n = Number(value)
      return Number.isFinite(n) ? n : NaN
    }
    const horizontal = toNum(hText)
    const vertical = toNum(vText)
    if (observed && (Number.isNaN(horizontal) || Number.isNaN(vertical))) {
      rows.length = 0
      throw new ParseError(`第 ${index + 1} 行水平/垂直位移不是数值：没有取值请整列留空表示缺测，并注明原因`)
    }
    rows.push({ code, date, observed, horizontal, vertical, reason })
  })
  if (rows.length === 0) {
    return { ok: false, message: '导入内容为空' }
  }
  return { ok: true, message: `解析出 ${rows.length} 条测次`, data: rows }
}

class ParseError extends Error {}

export function tryParseImportText(text: string): ServiceResult<SubmitRow[]> {
  try {
    return parseImportText(text)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '导入内容解析失败' }
  }
}

export function resetDisplacement(seedOnly = false): { overview: Overview; notes: string[] } {
  const state = displacementStore.reset(seedOnly)
  reconcileDefects(state)
  const fresh = displacementStore.state()
  return { overview: overviewOf(fresh), notes: fresh.migrationNotes }
}

export function migrationNotes(): string[] {
  return displacementStore.state().migrationNotes
}
