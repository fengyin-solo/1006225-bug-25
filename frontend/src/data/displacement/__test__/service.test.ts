// 端到端：桩掉 localStorage，验证提交事务/幂等/缺陷联动/导出一致性。
import { submitBatch, backfillHistory, registerPoint, verdicts, pointViews, overLimitVerdicts, unknownVerdicts, exportDisplacementCsv, reviewPoint, summary } from '@/api/displacement-service'
import { listRows } from '@/data/local-store'
import { resetDisplacementCache } from '@/data/displacement/store'

const mem = new Map()
globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } }
globalThis.Blob = class {}
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
globalThis.document = { createElement: () => ({ click() {}, style: {} }), body: { appendChild() {}, removeChild() {} } }

let pass = 0, fail = 0
const assert = (c, l) => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l)) }

resetDisplacementCache()

console.log('A) 播种状态：DISP-0001 观测中（累计跳过缺测）、DISP-0002 暂不可判定、DISP-0003 空态、DISP-0004 迁移后累计')
const s = summary()
assert(s.total === 4 && s.unknown === 2, `4 个测点，2 个暂不可判定（实际 unknown=${s.unknown}）`)
assert(s.missingRounds >= 3, `缺测/中断测次计入统计（${s.missingRounds}）`)
const v1 = verdicts().find((v) => v.point.code === 'DISP-0001')
assert(v1.judgement === 'normal' && v1.cumulativeHorizontal === 10.5, `DISP-0001 累计 H=10.5 跳过 7 月缺测（实际 ${v1.cumulativeHorizontal}）`)
const v4 = verdicts().find((v) => v.point.code === 'DISP-0004')
assert(v4.judgement === 'normal' && v4.cumulativeHorizontal === 9, `DISP-0004 迁移后 H=9=4+3+2（实际 ${v4.cumulativeHorizontal}），伪 0 未翻倍`)
assert(overLimitVerdicts().length === 0 && unknownVerdicts().length === 2, 'DISP-0002 最新中断 → 不在超限清单，进暂不可判定清单')

console.log('B) 缺陷清单：播种的 DISP-0002 超限缺陷在缺陷模块可见（另一入口）')
const defects0 = listRows('defect')
assert(defects0.some((r) => String(r['设备名称']).includes('DISP-0002')), '缺陷处置数据里有 DISP-0002 联动缺陷')

console.log('C) 整笔提交：一行坏整笔不写')
const bad = submitBatch('DISP-0001,2026-10-15,正常,,,,,\nDISP-0009,2026-10-15,正常,1,1')
assert(!bad.ok && bad.accepted === 0, `坏数据整笔拒绝（accepted=${bad.accepted}）`)
assert(bad.rowErrors.length === 2, '两行问题逐行列出')
const v1after = verdicts().find((v) => v.point.code === 'DISP-0001')
assert(v1after.cumulativeHorizontal === 10.5, '拒绝后累计位移未变化')

console.log('D) 合法提交导致超限 → 缺陷自动登记，且只登记一条')
const ok = submitBatch('DISP-0001,2026-10-15,正常,20,20,,,')
assert(ok.ok && ok.newlyOverLimit.some((p) => p.code === 'DISP-0001'), '提交成功并新判超限')
const defects1 = listRows('defect')
const linked1 = defects1.filter((r) => String(r['设备名称']).includes('DISP-0001'))
assert(linked1.length === 1, `超限自动登记恰好一条缺陷（实际 ${linked1.length}）`)
assert(overLimitVerdicts().some((v) => v.point.code === 'DISP-0001'), '超限清单与页面同口径：DISP-0001 在清单中')

console.log('E) 重复导入同一测次：后到整套退回，累计不翻倍')
const dup = submitBatch('DISP-0001,2026-10-15,正常,20,20')
assert(!dup.ok && /退回|已入库/.test(dup.message), '重复提交被整笔退回')
const v1dup = verdicts().find((v) => v.point.code === 'DISP-0001')
assert(v1dup.cumulativeHorizontal === 30.5, `累计仍为 30.5=10.5+20，未加两遍（实际 ${v1dup.cumulativeHorizontal}）`)
assert(listRows('defect').filter((r) => String(r['设备名称']).includes('DISP-0001')).length === 1, '重复导入未重复登记缺陷')

console.log('F) 缺测登记后（最新轮缺测）→ 测点移出超限清单进暂不可判定，缺陷保留')
const miss = submitBatch('DISP-0001,2026-10-20,缺测,,,,仪器故障,')
assert(miss.ok, '缺测轮登记成功')
assert(!overLimitVerdicts().some((v) => v.point.code === 'DISP-0001'), '最新轮缺测：超限清单不再包含该点')
assert(unknownVerdicts().some((v) => v.point.code === 'DISP-0001'), '该点进暂不可判定清单并注明原因')
const v1miss = verdicts().find((v) => v.point.code === 'DISP-0001')
assert(v1miss.judgement === 'unknown' && /仪器故障/.test(v1miss.unknownReason), '原因带出「仪器故障」')

console.log('G) 历史补数：缺字段单列、不当 0；重复键整套退回')
const hist = backfillHistory('DISP-0003,2026-05-01,正常,2,1,,,\nDISP-0003,2026-05-15,正常,,,,245.8')
assert(hist.ok, '历史补数成功（缺字段不退回）')
const v3 = verdicts().find((v) => v.point.code === 'DISP-0003')
assert(v3.judgement === 'unknown', 'DISP-0003 最新一轮为缺测 → 仍暂不可判定')
const rounds3 = pointViews().find((p) => p.code === 'DISP-0003')
assert(/缺测/.test(rounds3.missingInfo), '缺测在列表单列')
const histDup = backfillHistory('DISP-0003,2026-05-01,正常,9,9')
assert(!histDup.ok, '历史补数撞已有业务日期 → 整套退回')

console.log('H) 登记新测点：高程必填，重复编号拒绝')
assert(!registerPoint({ code: '', location: '', elevation: '', limitMm: '', frequency: '' }).ok, '空表单拒绝')
assert(!registerPoint({ code: 'DISP-0001', location: '', elevation: '286', limitMm: '20', frequency: '' }).ok, '重复编号拒绝')
const reg = registerPoint({ code: 'DISP-0009', location: '新坝段', elevation: '280.0', limitMm: '18', frequency: '1次/月' })
assert(reg.ok, '新测点登记成功')
assert(pointViews().find((p) => p.code === 'DISP-0009').magnitude === '—', '新测点空态累计显示 — 而非 0')

console.log('I) 复核：暂不可判定测点不能复核')
assert(!reviewPoint('DISP-0003').ok, '暂不可判定测点复核被拒')
assert(reviewPoint('DISP-0004').ok, '可判定测点复核成功')

console.log('J) 另存成果与页面口径一致：超限条数、暂不可判定条数')
const csv = exportDisplacementCsv().content
const pageOver = overLimitVerdicts().length
const pageUnknown = unknownVerdicts().length
const m1 = csv.match(/超限清单（共 (\d+) 条/)
const m2 = csv.match(/暂不可判定清单（共 (\d+) 条/)
assert(m1 && Number(m1[1]) === pageOver, `导出超限条数 ${m1?.[1]} = 页面 ${pageOver}`)
assert(m2 && Number(m2[1]) === pageUnknown, `导出暂不可判定条数 ${m2?.[1]} = 页面 ${pageUnknown}`)
assert(/缺测\/中断测次明细/.test(csv), '成果含缺测明细与原因')
assert(/存量数据回填/.test(csv), '成果含存量回填规则说明')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
