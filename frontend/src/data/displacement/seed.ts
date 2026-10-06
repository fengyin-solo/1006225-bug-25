import type { DisplacementState } from './types'

/**
 * 位移监测播种数据：
 * - DISP-0001 正常测点，中间缺过一次（仪器故障），累计位移不含该次；
 * - DISP-0002 超限测点，最新一轮中断（外业状态填了高程没填），当前暂不可判定、单列；
 *   它曾在上一轮判超限，缺陷清单里已有对应缺陷；
 * - DISP-0003 空态测点，从未首测；
 * - DISP-0004 历史迁移测点：早期一轮缺测被写成 0（夹在两次非零变动之间）。
 */
export function displacementSeed(): DisplacementState {
  const now = Date.parse('2026-10-01T08:00:00')
  const points = [
    { id: 1, code: 'DISP-0001', location: '坝顶 0+120', elevation: 286.5, limitMm: 20, frequency: '1次/月', createdAt: now },
    { id: 2, code: 'DISP-0002', location: '坝肩 0+240', elevation: 271.2, limitMm: 15, frequency: '1次/月', createdAt: now },
    { id: 3, code: 'DISP-0003', location: '坝趾 0+060', elevation: 245.8, limitMm: 20, frequency: '1次/季', createdAt: now },
    { id: 4, code: 'DISP-0004', location: '坝顶 0+180', elevation: 288.1, limitMm: 25, frequency: '1次/月', createdAt: now },
  ]
  const observations = [
    // DISP-0001：2.0 + (缺测跳过) + 5.0 + 3.5 = H 10.5，合成 11.33，未超限
    { id: 1, pointCode: 'DISP-0001', date: '2026-06-15', status: 'ok' as const, horizontal: 2.0, vertical: 1.0, measuredElevation: 286.42, reason: '' as const, note: '首测基线', source: 'import' as const, receivedAt: now + 1 },
    { id: 2, pointCode: 'DISP-0001', date: '2026-07-15', status: 'missing' as const, horizontal: null, vertical: null, measuredElevation: null, reason: '仪器故障' as const, note: '全站仪送检', source: 'import' as const, receivedAt: now + 2 },
    { id: 3, pointCode: 'DISP-0001', date: '2026-08-15', status: 'ok' as const, horizontal: 5.0, vertical: 2.5, measuredElevation: 286.4, reason: '' as const, note: '', source: 'import' as const, receivedAt: now + 3 },
    { id: 4, pointCode: 'DISP-0001', date: '2026-09-15', status: 'ok' as const, horizontal: 3.5, vertical: 1.8, measuredElevation: 286.38, reason: '' as const, note: '', source: 'import' as const, receivedAt: now + 4 },
    // DISP-0002：前两轮累计合成 16.28 > 15 判过超限；9 月这轮中断，当前暂不可判定
    { id: 5, pointCode: 'DISP-0002', date: '2026-07-20', status: 'ok' as const, horizontal: 8.0, vertical: 4.0, measuredElevation: 271.05, reason: '' as const, note: '', source: 'import' as const, receivedAt: now + 5 },
    { id: 6, pointCode: 'DISP-0002', date: '2026-08-20', status: 'ok' as const, horizontal: 6.0, vertical: 3.0, measuredElevation: 270.98, reason: '' as const, note: '', source: 'import' as const, receivedAt: now + 6 },
    { id: 7, pointCode: 'DISP-0002', date: '2026-09-20', status: 'interrupted' as const, horizontal: null, vertical: null, measuredElevation: 270.9, reason: '外业中断未复测' as const, note: '外业状态已填、垂直位移未测完', source: 'import' as const, receivedAt: now + 7 },
    // DISP-0004：历史资料。7 月真实缺测被写成 0，迁移时识别并留空
    { id: 8, pointCode: 'DISP-0004', date: '2026-06-10', status: 'ok' as const, horizontal: 4.0, vertical: 2.0, measuredElevation: 288.0, reason: '' as const, note: '', source: 'legacy' as const, receivedAt: now + 8 },
    { id: 9, pointCode: 'DISP-0004', date: '2026-07-10', status: 'missing' as const, horizontal: null, vertical: null, measuredElevation: null, reason: '历史资料缺失' as const, note: '存量记录中写成 0，按规则识别为缺测', source: 'legacy' as const, receivedAt: now + 9 },
    { id: 10, pointCode: 'DISP-0004', date: '2026-08-10', status: 'ok' as const, horizontal: 3.0, vertical: 1.5, measuredElevation: 287.95, reason: '' as const, note: '', source: 'legacy' as const, receivedAt: now + 10 },
    { id: 11, pointCode: 'DISP-0004', date: '2026-09-10', status: 'ok' as const, horizontal: 2.0, vertical: 1.0, measuredElevation: 287.92, reason: '' as const, note: '', source: 'import' as const, receivedAt: now + 11 },
  ]
  return {
    points,
    observations,
    migrationNotes: [
      'DISP-0004 2026-07-10：位移记录为 0 但夹在非零变动测次之间，识别为「缺测写成 0」，已留空不计入累计位移',
    ],
    defectLinkedCodes: ['DISP-0002'],
    seq: { point: 5, observation: 12 },
    version: 2,
  }
}
