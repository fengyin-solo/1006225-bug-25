import type { DispState } from './types'

// 位移模块 v2 示例数据：测点档案与测次分开，覆盖正常、超限、缺测中断、高程缺失、空态各场景。
// 业务日期都在 2026-09，便于演示「历史数据按业务日期对齐」。
export function displacementSeed(now = Date.parse('2026-10-01T00:00:00Z')): DispState {
  return {
    version: 2,
    clock: 100,
    nextPointId: 6,
    nextObservationId: 100,
    nextBatchId: 1,
    migratedAt: null,
    migrationNotes: [],
    points: [
      {
        id: 1,
        code: 'DB-TP01',
        location: '坝顶0+120',
        elevation: 215.6,
        allowable: 20,
        frequency: '1次/旬',
        reviewedAt: null,
        createdAt: now,
      },
      {
        id: 2,
        code: 'DB-TP02',
        location: '坝顶0+240',
        elevation: 215.2,
        allowable: 20,
        frequency: '1次/旬',
        reviewedAt: null,
        createdAt: now,
      },
      {
        id: 3,
        code: 'DB-IP03',
        location: '坝腰0+240',
        elevation: 188.4,
        allowable: 15,
        frequency: '1次/月',
        reviewedAt: null,
        createdAt: now,
      },
      {
        id: 4,
        code: 'DB-BP04',
        location: '坝趾0+360',
        elevation: null, // 外业状态填了、高程没填：照样允许录测次，但档案缺项单列
        allowable: 15,
        frequency: '1次/月',
        reviewedAt: null,
        createdAt: now,
      },
      {
        id: 5,
        code: 'DB-TP05',
        location: '坝顶0+480',
        elevation: 215.0,
        allowable: 20,
        frequency: '1次/月',
        reviewedAt: null,
        createdAt: now,
      },
    ],
    observations: [
      // TP01：正常，累计位移 9.22mm < 20
      { id: 1, pointId: 1, date: '2026-09-01', observed: true, horizontal: 10.0, vertical: 5.0, reason: '', source: 'seed', batchId: null, createdAt: now },
      { id: 2, pointId: 1, date: '2026-09-11', observed: true, horizontal: 14.0, vertical: 11.0, reason: '', source: 'seed', batchId: null, createdAt: now + 1 },
      { id: 3, pointId: 1, date: '2026-09-21', observed: true, horizontal: 18.0, vertical: 9.0, reason: '', source: 'seed', batchId: null, createdAt: now + 2 },
      // TP02：超限，累计 25mm > 20
      { id: 4, pointId: 2, date: '2026-09-01', observed: true, horizontal: 0.0, vertical: 0.0, reason: '', source: 'seed', batchId: null, createdAt: now },
      { id: 5, pointId: 2, date: '2026-09-11', observed: true, horizontal: 15.0, vertical: 8.0, reason: '', source: 'seed', batchId: null, createdAt: now + 1 },
      { id: 6, pointId: 2, date: '2026-09-21', observed: true, horizontal: 25.0, vertical: 0.0, reason: '', source: 'seed', batchId: null, createdAt: now + 2 },
      // IP03：末测次缺测（观测通道故障），观测中断，不做超限判定
      { id: 7, pointId: 3, date: '2026-09-05', observed: true, horizontal: 3.0, vertical: 1.0, reason: '', source: 'seed', batchId: null, createdAt: now },
      { id: 8, pointId: 3, date: '2026-10-05', observed: false, horizontal: null, vertical: null, reason: '观测墩旁施工，仪器临时拆除，外业无法立尺', source: 'seed', batchId: null, createdAt: now + 1 },
      // BP04：高程未填但测次正常，位移照算，缺高程只在缺项清单里
      { id: 9, pointId: 4, date: '2026-09-08', observed: true, horizontal: 2.0, vertical: 0.5, reason: '', source: 'seed', batchId: null, createdAt: now },
      // TP05：空态——测点建好了，一次取值都没有
    ],
    batches: [],
  }
}
