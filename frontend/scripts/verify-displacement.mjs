// 位移领域规则端到端校验：tsc 转译 TS 领域层后，用内存 localStorage 桩驱动。
// 运行：npx tsc -p tsconfig.test.json && node --experimental-loader ./scripts/alias-loader.mjs scripts/verify-displacement.mjs
import assert from 'node:assert/strict'

const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
}

const ENTRIES_KEY = 'hydropower-plant-om:entries'
const DISP_KEY = 'hydropower-plant-om:displacement-v2'

// 直接构造通用库（含 defect 空表），位移不放 v1 数据 → 走 v2 内置示例
mem.set(ENTRIES_KEY, JSON.stringify({ defect: [] }))

const mod = await import('./dist-test/data/displacement/service.js')

let ov = mod.getOverview()
assert.equal(ov.stats.totalPoints, 5, '应有5个示例测点')

// 1. TP01 正常：累计 = hypot(18-10, 9-5) = 8.944
const tp01 = ov.points.find((p) => p.point.code === 'DB-TP01')
assert.equal(tp01.state, '正常')
assert.equal(tp01.cumulative.total, 8.944)

// 2. TP02 超限：25mm > 20
const tp02 = ov.points.find((p) => p.point.code === 'DB-TP02')
assert.equal(tp02.state, '超限')
assert.equal(tp02.cumulative.total, 25)
assert.equal(ov.overlimit.length, 1, '超限清单应只有 TP02 一条')

// 3. IP03 末测次缺测 → 观测中断，不判超限（旧累计 hypot(3,1)=3.16 也不沿用）
const ip03 = ov.points.find((p) => p.point.code === 'DB-IP03')
assert.equal(ip03.state, '暂不可判定')
assert.equal(ip03.reason, '观测中断')

// 4. BP04 高程缺失但可判定为正常，缺高程进缺项清单
const bp04 = ov.points.find((p) => p.point.code === 'DB-BP04')
assert.equal(bp04.state, '正常')
assert.ok(bp04.gapFields.includes('测点高程'))

// 5. TP05 空态
const tp05 = ov.points.find((p) => p.point.code === 'DB-TP05')
assert.equal(tp05.state, '暂不可判定')
assert.equal(tp05.reason, '空态')
assert.equal(tp05.cumulative, null)

// 6. 超限结果落到缺陷清单（另一个入口）
let defects = JSON.parse(mem.get(ENTRIES_KEY)).defect
assert.equal(defects.length, 1)
assert.equal(defects[0]['来源测点'], 'DB-TP02')
assert.equal(defects[0]['缺陷编号'], 'QX-DISP-DB-TP02')

// 7. 缺测测次值留空且不计 0：IP03 末测次
const missingRound = ov.observations.find((o) => o.pointId === ip03.point.id && !o.observed)
assert.equal(missingRound.horizontal, null)
assert.ok(missingRound.reason.length > 0)

// 8. 单测次：缺测无原因 → 整笔退回
let r = mod.submitBatch(
  [{ code: 'DB-TP01', date: '2026-10-01', observed: false, horizontal: null, vertical: null, reason: '' }],
  'manual',
)
assert.equal(r.ok, false)
assert.match(r.message, /缺测原因/)

// 9. 已观测但只填一个值（另一个空）→ 拒绝，不能当 0
r = mod.submitBatch(
  [{ code: 'DB-TP01', date: '2026-10-01', observed: true, horizontal: 5, vertical: null, reason: '' }],
  'manual',
)
assert.equal(r.ok, false)
assert.match(r.message, /不能当 0/)

// 10. 合法缺测提交 → 成功，TP01 变观测中断，超限数量不变
r = mod.submitBatch(
  [{ code: 'DB-TP01', date: '2026-10-01', observed: false, horizontal: null, vertical: null, reason: '道路水毁无法进点' }],
  'manual',
)
assert.equal(r.ok, true, r.message)
ov = mod.getOverview()
const tp01b = ov.points.find((p) => p.point.code === 'DB-TP01')
assert.equal(tp01b.state, '暂不可判定')
assert.equal(tp01b.reason, '观测中断')
assert.equal(ov.overlimit.length, 1, '缺测不能影响超限清单')

// 11. 重复提交同一稿 → 整笔退回，只留一条
r = mod.submitBatch(
  [{ code: 'DB-TP01', date: '2026-10-01', observed: false, horizontal: null, vertical: null, reason: '道路水毁无法进点' }],
  'manual',
)
assert.equal(r.ok, false)
assert.match(r.message, /最先入库/)
ov = mod.getOverview()
assert.equal(ov.observations.filter((o) => o.pointId === tp01.point.id && o.date === '2026-10-01').length, 1)

// 12. 同测点已有该日期、不同内容 → 同样退回，累计不翻倍
r = mod.submitBatch(
  [{ code: 'DB-TP01', date: '2026-10-01', observed: true, horizontal: 99, vertical: 99, reason: '' }],
  'import',
)
assert.equal(r.ok, false)

// 13. 批内一条不合法 → 整笔退回（TP02 那条也不能进库）
r = mod.submitBatch(
  [
    { code: 'DB-TP02', date: '2026-10-02', observed: true, horizontal: 30, vertical: 0, reason: '' },
    { code: 'DB-TP05', date: 'bad-date', observed: true, horizontal: 1, vertical: 1, reason: '' },
  ],
  'import',
)
assert.equal(r.ok, false)
ov = mod.getOverview()
assert.ok(!ov.observations.some((o) => o.pointId === tp02.point.id && o.date === '2026-10-02'), '整笔回回的条目不能入库')

// 14. 暂不可判定的测点不允许复核
r = mod.reviewPoint(ip03.point.id)
assert.equal(r.ok, false)

// 15. 非超限测点登记缺陷被拒
r = mod.registerDefect(bp04.point.id)
assert.equal(r.ok, false)
// 超限测点登记缺陷幂等
r = mod.registerDefect(tp02.point.id)
assert.equal(r.ok, true)
defects = JSON.parse(mem.get(ENTRIES_KEY)).defect
assert.equal(defects.filter((d) => d['来源测点'] === 'DB-TP02').length, 1)

// 16. 合法整套导入（TP05 两个测次，第一测0第二测非0 → 正常，首测0算基准）
r = mod.submitBatch(
  [
    { code: 'DB-TP05', date: '2026-09-10', observed: true, horizontal: 0, vertical: 0, reason: '' },
    { code: 'DB-TP05', date: '2026-10-10', observed: true, horizontal: 12, vertical: 5, reason: '' },
  ],
  'import',
)
assert.equal(r.ok, true, r.message)
ov = mod.getOverview()
const tp05b = ov.points.find((p) => p.point.code === 'DB-TP05')
assert.equal(tp05b.state, '正常')
assert.equal(tp05b.cumulative.total, 13)

// 17. 导入文本解析：缺测行
const parsed = mod.tryParseImportText('DB-TP01,2026-11-01,,,仪器检修')
assert.equal(parsed.ok, true)
assert.equal(parsed.data[0].observed, false)
assert.equal(parsed.data[0].reason, '仪器检修')

// 18. 导出 CSV 中超限条数与页面一致
const exported = mod.exportDisplacement().content
assert.match(exported, new RegExp(`超限清单（共 ${ov.overlimit.length} 条`))
assert.match(exported, /超限测点：1/)

// 19. 存量迁移：0 即缺测识别 + 无日期单列 + 累计重算
mem.delete(DISP_KEY)
// 重新导入模块会重建缓存不现实，这里直接改存储后调用 reset 强制迁移
const legacyAll = JSON.parse(mem.get(ENTRIES_KEY))
legacyAll.displacement = [
  // M1：0,0 → 10,0 → 0,0（全0应识别为缺测）；末测缺测 → 观测中断
  { id: 1, status: '观测中', pending: true, abnormal: false, '测点编号': 'LEG-01', '测点高程': 200, '水平位移': 0, '垂直位移': 0, '累计位移': 999, '允许位移': 20, '监测频次': '1次/月', '测点状态': '', '观测日期': '2026-06-01' },
  { id: 2, status: '观测中', pending: true, abnormal: false, '测点编号': 'LEG-01', '测点高程': 200, '水平位移': 10, '垂直位移': 0, '累计位移': 999, '允许位移': 20, '监测频次': '1次/月', '测点状态': '', '观测日期': '2026-07-01' },
  { id: 3, status: '观测中', pending: true, abnormal: false, '测点编号': 'LEG-01', '测点高程': 200, '水平位移': 0, '垂直位移': 0, '累计位移': 999, '允许位移': 20, '监测频次': '1次/月', '测点状态': '', '观测日期': '2026-08-01' },
  // M2：无观测日期的存量行 → 日期留空，不进序列 → 空态 + 观测日期缺失
  { id: 4, status: '待观测', pending: true, abnormal: false, '测点编号': 'LEG-02', '测点高程': 190, '水平位移': 3, '垂直位移': 4, '累计位移': 5, '允许位移': 10, '监测频次': '', '测点状态': '', '观测日期': '' },
  // M3：文本垃圾 → 取值无法识别，字段缺失
  { id: 5, status: '待观测', pending: true, abnormal: false, '测点编号': 'LEG-03', '测点高程': '坏值', '水平位移': '位移监测样例', '垂直位移': '位移监测样例', '累计位移': '坏值', '允许位移': '坏值', '监测频次': '', '测点状态': '', '观测日期': '2026-05-01' },
]
mem.set(ENTRIES_KEY, JSON.stringify(legacyAll))
const notes = mod.resetDisplacement(false).notes
ov = mod.getOverview()
assert.ok(notes.some((n) => n.includes('1 条') && n.includes('识别为缺测')), JSON.stringify(notes))
assert.ok(notes.some((n) => n.includes('1 条无观测日期')), JSON.stringify(notes))
assert.ok(notes.some((n) => n.includes('3 个测点合并 5 条')), JSON.stringify(notes))
const leg1 = ov.points.find((p) => p.point.code === 'LEG-01')
assert.equal(leg1.state, '暂不可判定')
assert.equal(leg1.reason, '观测中断')
// 累计仍按有效测次重算 = 10（旧值 999 不再使用）
assert.equal(leg1.cumulative.total, 10)
const leg2 = ov.points.find((p) => p.point.code === 'LEG-02')
assert.equal(leg2.state, '暂不可判定')
assert.equal(leg2.reason, '空态')
assert.ok(ov.gaps.some((g) => g.pointCode === 'LEG-02' && g.field === '观测日期'))
const leg3 = ov.points.find((p) => p.point.code === 'LEG-03')
assert.ok(leg3.gapFields.includes('测点高程'))
assert.ok(leg3.gapFields.includes('允许位移'))

// 20. 迁移幂等：再取 overview 不会重复迁移
const before = mod.getOverview().points.length
ov = mod.getOverview()
assert.equal(ov.points.length, before)

console.log('全部断言通过 ✔')
