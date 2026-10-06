import { cumulative, judgePoint, magnitude, parseBatch, parseHistory, recognizeLegacy, sortRounds } from './logic.ts'

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label) }
  else { fail++; console.log('  ✗ 失败:', label) }
}

const mk = (id, date, status, horizontal, vertical, extra = {}) => ({
  id, pointCode: 'P', date, status, horizontal, vertical, measuredElevation: null, reason: extra.reason ?? '', note: '', source: 'import', receivedAt: id, ...extra,
})

console.log('1) 累计位移：缺测/中断跳过，不当 0')
const rounds = [
  mk(1, '2026-06-01', 'ok', 2, 1),
  mk(2, '2026-07-01', 'missing', null, null, { reason: '仪器故障' }),
  mk(3, '2026-08-01', 'ok', 5, 2.5),
  mk(4, '2026-09-01', 'interrupted', null, null, { reason: '外业中断未复测' }),
]
const c = cumulative(rounds)
assert(c.h === 7 && c.v === 3.5, `缺测两轮不参与累加，H=7 V=3.5（实际 ${c.h},${c.v}）`)

console.log('2) 超限判定跳过缺测测次，只比累计合成位移')
const point = { id: 1, code: 'P', location: 'L', elevation: 100, limitMm: 7, frequency: '月', createdAt: 0 }
// 截至 8 月正常轮（9 月那轮中断属于测试 3 的场景）
const roundsUntilOk = rounds.slice(0, 3)
const v = judgePoint(point, roundsUntilOk)
assert(v.judgement === 'overLimit' && v.magnitude === magnitude(7, 3.5), `合成 ${magnitude(7, 3.5)} > 7 判超限`)

const pointOk = { ...point, limitMm: 20 }
const v2 = judgePoint(pointOk, roundsUntilOk)
assert(v2.judgement === 'overLimit' === false && v2.judgement === 'normal', '阈值 20 时判正常（阈值 7 的测点超限）')

console.log('3) 最新测次缺测/中断 → 暂不可判定，不沿用旧值乱亮越限')
const v3 = judgePoint(point, rounds)
// point 阈值 8：旧值本已超限，但最新一轮是中断，应转暂不可判定
assert(v3.judgement === 'unknown', '最新一轮中断时即便历史累计超限也判 unknown')
assert(v3.unknownReason.includes('中断'), '给出中断原因说明')

console.log('4) 空态：一条观测都没有')
const v4 = judgePoint(point, [])
assert(v4.judgement === 'unknown' && v4.cumulativeHorizontal === null, '从未观测 → unknown 且累计为 null 而非 0')
assert(v4.unknownReason.includes('空态'), '空态单独说明原因')

console.log('5) 只有缺测、没有正常测次')
const onlyMissing = [mk(1, '2026-06-01', 'missing', null, null, { reason: '仪器故障' })]
const v5 = judgePoint(point, onlyMissing)
assert(v5.judgement === 'unknown', '只有缺测 → unknown')

console.log('6) 最新一轮恢复正常后重新可判定')
const recovered = [...rounds, mk(5, '2026-10-01', 'ok', 0.5, 0.2)]
const v6 = judgePoint(pointOk, recovered)
assert(v6.judgement === 'normal' && v6.magnitude === magnitude(7.5, 3.7), '恢复观测后按含缺测跳过的累计正常判定')

console.log('7) parseBatch：正常测次缺取值 → 整笔收集错误（缺失字段单独罗列）')
const known = new Set(['DISP-0001'])
const existing = new Set()
const r1 = parseBatch('DISP-0001,2026-10-01,正常,,,286.0', known, existing)
assert(r1.rows.length === 0 && r1.errors.length === 1, '缺水平/垂直取值的正常测次被拒')
assert(r1.errors[0].problems.some((p) => p.includes('水平位移')), '列明缺水平位移')

console.log('8) parseBatch：缺测填了 0 → 拒绝，不能拿缺值当 0')
const r2 = parseBatch('DISP-0001,2026-10-01,缺测,0,0,,仪器故障', known, existing)
assert(r2.rows.length === 0 && r2.errors[0].problems.some((p) => p.includes('不得填位移值')), '缺测带 0 被退回')

console.log('9) parseBatch：缺测必须注明原因')
const r3 = parseBatch('DISP-0001,2026-10-01,缺测,,,,', known, existing)
assert(r3.rows.length === 0 && r3.errors[0].problems.some((p) => p.includes('必须注明')), '无原因缺测被退回')

console.log('10) 合法混合批：正常 + 缺测（留空带原因）一起通过')
const batch = ['DISP-0001,2026-10-01,正常,2.1,1.0,286.0,,', 'DISP-0001,2026-10-02,缺测,,,,仪器故障,送检'].join('\n')
const r4 = parseBatch(batch, known, existing)
assert(r4.errors.length === 0 && r4.rows.length === 2, '两行都通过')
assert(r4.rows[1].horizontal === null && r4.rows[1].reason === '仪器故障', '缺测行位移为 null（非 0）')

console.log('11) 幂等：重复测点+日期键被拒（最先入库一稿为准）')
const existing2 = new Set(['DISP-0001|2026-10-01'])
const r5 = parseBatch('DISP-0001,2026-10-01,正常,9,9', known, existing2)
assert(r5.errors[0].problems.some((p) => p.includes('重复提交') || p.includes('退回')), '重复测次被拒')
const r5b = parseBatch('DISP-0001,2026-10-01,正常,2,1\nDISP-0001,2026-10-01,正常,3,2', known, new Set())
assert(r5b.errors.some((e) => e.problems.some((p) => p.includes('本批数据内重复'))), '批内自重复被拒')

console.log('12) 未登记测点、非法日期整笔校验')
const r6 = parseBatch('DISP-9,2026-13-99,正常,1,1', known, new Set())
assert(r6.errors[0].problems.length >= 2, '未知测点 + 非法日期都被列出')

console.log('13) 存量「缺测写成 0」识别：夹在非零变动间的孤立 0')
const legacy = [
  { date: '2026-06-01', statusText: '观测中', horizontalText: '4', verticalText: '2', elevationText: '100' },
  { date: '2026-07-01', statusText: '观测中', horizontalText: '0', verticalText: '0', elevationText: '100' },
  { date: '2026-08-01', statusText: '观测中', horizontalText: '3', verticalText: '1.5', elevationText: '100' },
]
const rec = recognizeLegacy('P', legacy)
const july = rec.observations.find((o) => o.date === '2026-07-01')
assert(july.status === 'missing' && july.h === null, '7 月孤立 0 识别为缺测、留空')
assert(rec.notes.some((n) => n.includes('缺测写成 0')), '识别规则写入迁移说明')
const cumLegacy = cumulative(rec.observations.map((o, i) => mk(i + 1, o.date, o.status, o.h, o.v)))
assert(cumLegacy.h === 7, `迁移后累计只加 4+3=7（实际 ${cumLegacy.h}），伪 0 不翻倍`)

console.log('14) 存量：首个基线 0 与连续稳定 0 保留（0 本身合法）')
const stable = [
  { date: '2026-06-01', statusText: '', horizontalText: '0', verticalText: '0', elevationText: '100' },
  { date: '2026-07-01', statusText: '', horizontalText: '0', verticalText: '0', elevationText: '100' },
]
const rec2 = recognizeLegacy('P2', stable)
assert(rec2.observations.every((o) => o.status === 'ok'), '未动过的连续 0 保持正常，不冤判缺测')

console.log('15) 存量：外业状态填了但高程/取值没填 → 中断，不当 0')
const partial = [{ date: '2026-07-01', statusText: '观测中', horizontalText: '2', verticalText: '', elevationText: '' }]
const rec3 = recognizeLegacy('P3', partial)
assert(rec3.observations[0].status === 'interrupted' && rec3.observations[0].v === null, '状态已填但字段缺失 → 中断')
assert(rec3.notes[0].includes('垂直位移'), '缺失字段被罗列')

console.log('16) 存量：文字占位（样例数据）→ 历史资料缺失缺测')
const textCell = [{ date: '2026-07-01', statusText: '', horizontalText: '位移监测样例1', verticalText: '位移监测样例1', elevationText: 'xx' }]
const rec4 = recognizeLegacy('P4', textCell)
assert(rec4.observations[0].status === 'missing' && rec4.observations[0].reason === '历史资料缺失', '文字占位判缺测')

console.log('17) 历史补数：缺取值不退回、不当 0，单列缺失字段')
const r7 = parseHistory('DISP-0001,2026-05-01,正常,,,,286.0', known, new Set())
assert(r7.errors.length === 0 && r7.rows.length === 1, '历史缺值不整笔退回')
assert(r7.rows[0].status === 'missing' && r7.rows[0].horizontal === null, '缺值降为缺测且为 null')
assert(r7.missingNotes.some((n) => n.text.includes('水平位移')), '缺失字段单独罗列')

console.log('18) 历史补数按业务日期对齐排序')
const unsorted = [mk(2, '2026-08-01', 'ok', 3, 1), mk(1, '2026-06-01', 'ok', 1, 0), mk(3, '2026-07-01', 'missing', null, null, { reason: '天气原因停测' })]
const sorted = sortRounds(unsorted)
assert(sorted.map((o) => o.date).join() === '2026-06-01,2026-07-01,2026-08-01', '按观测日期升序')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
