<template>
  <section class="page" data-module="displacement">
    <header class="page-head">
      <div>
        <h2>位移监测管理</h2>
        <p class="page-desc">
          测点档案与观测测次分开管理：缺测测次留空并注明原因，累计位移只累加有效取值、空值不当 0，
          超限判定跳过缺测测次；暂不可判定的测点单列，不混进超限。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="doExport">另存位移成果（CSV）</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">测点总数</span><strong class="stat-value">{{ overview.stats.totalPoints }}</strong></article>
      <article class="stat-card"><span class="stat-label">超限测点</span><strong class="stat-value warn">{{ overview.stats.overlimit }}</strong></article>
      <article class="stat-card"><span class="stat-label">暂不可判定</span><strong class="stat-value muted">{{ overview.stats.pending }}</strong></article>
      <article class="stat-card"><span class="stat-label">缺测测次</span><strong class="stat-value muted">{{ overview.stats.missingRounds }}</strong></article>
      <article class="stat-card"><span class="stat-label">空态/中断/缺项</span><strong class="stat-value muted">{{ overview.stats.fieldGaps }}</strong></article>
    </div>

    <p class="status-legend">
      <span class="legend-item">列表、超限清单、导出 CSV 同读一份计算结果，超限条数始终一致</span>
      <span class="legend-item">历史取值以首个有效测次为基准重算</span>
      <span class="legend-item">超限自动登记缺陷，可到「缺陷处置」页处理</span>
    </p>

    <p v-if="message" :class="['foot-msg', resultOk ? 'ok-text' : 'error-text']">{{ message }}</p>

    <h3 class="block-title">一、测点清单（累计位移与判定结论）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>测点编号</th><th>位置</th><th>测点高程(m)</th><th>允许位移(mm)</th>
          <th>有效测次</th><th>累计水平(mm)</th><th>累计垂直(mm)</th><th>累计合位移(mm)</th>
          <th>判定结论</th><th>复核</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in overview.points" :key="view.point.id" :class="rowClass(view.state)">
          <td>{{ view.point.code }}</td>
          <td>{{ view.point.location || '—' }}</td>
          <td :class="{ gap: view.point.elevation === null }">{{ view.point.elevation === null ? '缺失' : view.point.elevation }}</td>
          <td :class="{ gap: view.point.allowable === null }">{{ view.point.allowable === null ? '缺失' : view.point.allowable }}</td>
          <td>{{ view.valid.length }}</td>
          <td>{{ view.cumulative === null ? '—' : fmt(view.cumulative.horizontal) }}</td>
          <td>{{ view.cumulative === null ? '—' : fmt(view.cumulative.vertical) }}</td>
          <td>{{ view.cumulative === null ? '—' : fmt(view.cumulative.total) }}</td>
          <td>
            <span :class="['state-tag', stateClass(view.state)]">{{ view.statusText }}</span>
          </td>
          <td>{{ view.point.reviewedAt ? '已复核' : '未复核' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="prefill(view.point.code)">录测次</button>
            <button class="link" type="button" @click="doReview(view.point.id)" :disabled="view.state === '暂不可判定'">提交复核</button>
            <button class="link" type="button" @click="doRegisterDefect(view.point.id)" :disabled="view.state !== '超限'">登记缺陷</button>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">二、超限清单（{{ overview.overlimit.length }} 条，与另存成果条数一致）</h3>
    <table class="data-table">
      <thead>
        <tr><th>测点编号</th><th>位置</th><th>累计合位移(mm)</th><th>允许位移(mm)</th><th>超出量(mm)</th><th>最近测次</th><th>缺陷状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="view in overview.overlimit" :key="'ol-' + view.point.id">
          <td>{{ view.point.code }}</td>
          <td>{{ view.point.location || '—' }}</td>
          <td class="warn">{{ view.cumulative === null ? '—' : fmt(view.cumulative.total) }}</td>
          <td>{{ view.point.allowable }}</td>
          <td>{{ view.cumulative && view.point.allowable !== null ? fmt(view.cumulative.total - view.point.allowable) : '—' }}</td>
          <td>{{ view.latest?.date ?? '—' }}</td>
          <td>已同步缺陷处置清单（{{ defectStatus(view.point.code) }}）</td>
        </tr>
        <tr v-if="!overview.overlimit.length"><td colspan="7" class="empty-state">暂无超限测点</td></tr>
      </tbody>
    </table>

    <h3 class="block-title">三、暂不可判定测点（{{ overview.pending.length }} 条，不计入超限）</h3>
    <table class="data-table">
      <thead><tr><th>测点编号</th><th>位置</th><th>原因</th><th>说明</th><th>档案缺项</th></tr></thead>
      <tbody>
        <tr v-for="view in overview.pending" :key="'pd-' + view.point.id">
          <td>{{ view.point.code }}</td>
          <td>{{ view.point.location || '—' }}</td>
          <td><span class="state-tag pending">{{ view.reason }}</span></td>
          <td>{{ pendingHint(view.reason) }}</td>
          <td>{{ view.gapFields.join('、') || '—' }}</td>
        </tr>
        <tr v-if="!overview.pending.length"><td colspan="5" class="empty-state">所有测点均可判定</td></tr>
      </tbody>
    </table>

    <h3 class="block-title">四、缺测与缺项清单（空态、观测中断、字段缺失分别注明原因）</h3>
    <table class="data-table">
      <thead><tr><th>类型</th><th>测点编号</th><th>业务日期</th><th>缺项</th><th>原因</th></tr></thead>
      <tbody>
        <tr v-for="(gap, index) in overview.gaps" :key="'gap-' + index">
          <td><span :class="['state-tag', gapClass(gap.kind)]">{{ gap.kind }}</span></td>
          <td>{{ gap.pointCode }}</td>
          <td>{{ gap.date || '—' }}</td>
          <td>{{ gap.field }}</td>
          <td>{{ gap.reason }}</td>
        </tr>
        <tr v-if="!overview.gaps.length"><td colspan="5" class="empty-state">暂无缺测或缺项</td></tr>
      </tbody>
    </table>

    <div class="form-grid">
      <form class="entry-form" @submit.prevent="submitManual">
        <h3 class="block-title">五、单测次提交（缺测留空并填原因）</h3>
        <label>测点
          <select v-model="form.code">
            <option value="">请选择</option>
            <option v-for="point in overview.points" :key="point.point.id" :value="point.point.code">{{ point.point.code }}（{{ point.point.location }}）</option>
          </select>
        </label>
        <label>观测日期<input v-model="form.date" type="date" /></label>
        <label class="check"><input v-model="form.observed" type="checkbox" /> 本次已观测（取消勾选=缺测）</label>
        <template v-if="form.observed">
          <label>水平位移(mm)<input v-model="form.hText" inputmode="decimal" placeholder="有取值才填，没有不能填0" /></label>
          <label>垂直位移(mm)<input v-model="form.vText" inputmode="decimal" placeholder="有取值才填，没有不能填0" /></label>
        </template>
        <label v-else class="reason-input">缺测原因<input v-model="form.reason" placeholder="如：施工干扰仪器拆除、洪水封路无法到达" /></label>
        <div class="form-actions">
          <button class="btn primary" type="submit">提交本测次</button>
          <span class="hint">重复提交同稿、同测点同日期均整笔退回</span>
        </div>
      </form>

      <form class="entry-form import-form" @submit.prevent="submitImport">
        <h3 class="block-title">六、整套导入（先校验后入库，整笔生效或整笔退回）</h3>
        <p class="hint">每行：测点编号,日期,水平,垂直[,缺测原因]；水平垂直都留空表示缺测（原因必填）。</p>
        <textarea v-model="importText" rows="7" placeholder="DB-TP01,2026-11-01,20.1,9.8&#10;DB-IP03,2026-11-05,,,,观测通道故障"></textarea>
        <div class="form-actions">
          <button class="btn primary" type="submit">整套提交</button>
          <span class="hint">以最先入库的一稿为准，后到整套退回</span>
        </div>
      </form>
    </div>

    <h3 class="block-title">七、测次明细（同一测点同一业务日期唯一）</h3>
    <table class="data-table">
      <thead><tr><th>测点编号</th><th>观测日期</th><th>水平位移(mm)</th><th>垂直位移(mm)</th><th>状态</th><th>原因</th><th>来源</th><th>批次</th></tr></thead>
      <tbody>
        <tr v-for="obs in overview.observations" :key="obs.id">
          <td>{{ pointCode(obs.pointId) }}</td>
          <td :class="{ gap: obs.date === '' }">{{ obs.date || '日期缺失·待补' }}</td>
          <td>{{ obs.observed ? fmt(obs.horizontal) : '' }}</td>
          <td>{{ obs.observed ? fmt(obs.vertical) : '' }}</td>
          <td><span :class="['state-tag', obs.observed ? 'ok' : 'missing']">{{ obs.observed ? '有效' : '缺测' }}</span></td>
          <td>{{ obs.reason || '—' }}</td>
          <td>{{ sourceLabel(obs.source) }}</td>
          <td>{{ obs.batchId === null ? '—' : '#' + obs.batchId }}</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">八、入库批次（重复提交只留一条）</h3>
    <table class="data-table">
      <thead><tr><th>批次</th><th>入口</th><th>条数</th><th>内容预览</th><th>入库顺序</th><th>值班</th></tr></thead>
      <tbody>
        <tr v-for="batch in overview.batches" :key="batch.id">
          <td>#{{ batch.id }}</td>
          <td>{{ batch.source === 'manual' ? '单测次' : '整套导入' }}</td>
          <td>{{ batch.accepted }}</td>
          <td>{{ batch.preview }}</td>
          <td>{{ batch.createdAt }}</td>
          <td>{{ batch.operator }}</td>
        </tr>
        <tr v-if="!overview.batches.length"><td colspan="6" class="empty-state">暂无提交批次</td></tr>
      </tbody>
    </table>

    <section v-if="notes.length" class="migration-note">
      <h3 class="block-title">存量数据迁移说明（按观测日期回填后的识别结果）</h3>
      <ul>
        <li v-for="(note, index) in notes" :key="index">{{ note }}</li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>测点 {{ overview.points.length }} 个 · 超限 {{ overview.overlimit.length }} 条 · 另存成果与本页一致</span>
      <button class="btn ghost" type="button" @click="doReset">重置位移数据</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import { fmt } from '@/data/displacement/engine'
import {
  exportDisplacement,
  getOverview,
  migrationNotes,
  registerDefect,
  resetDisplacement,
  reviewPoint,
  submitBatch,
  tryParseImportText,
} from '@/data/displacement/service'
import type { Overview } from '@/data/displacement/types'
import { listRows } from '@/data/local-store'

const emptyOverview = (): Overview => ({
  points: [], overlimit: [], pending: [], normal: [], gaps: [], observations: [], undated: [], batches: [],
  stats: { totalPoints: 0, overlimit: 0, pending: 0, missingRounds: 0, fieldGaps: 0 },
})

const overview = ref<Overview>(emptyOverview())
const message = ref('')
const resultOk = ref(true)
const notes = ref<string[]>([])
const importText = ref('')

const form = reactive({
  code: '',
  date: '',
  observed: true,
  hText: '',
  vText: '',
  reason: '',
})

function reload() {
  overview.value = getOverview()
  notes.value = migrationNotes()
}

function flash(ok: boolean, text: string) {
  resultOk.value = ok
  message.value = text
}

function pointCode(pointId: number): string {
  return overview.value.points.find((view) => view.point.id === pointId)?.point.code ?? `#${pointId}`
}

function defectStatus(code: string): string {
  const row = listRows('defect').find((item) => item['来源模块'] === 'displacement' && item['来源测点'] === code)
  return row ? String(row.status) : '待处理'
}

function prefill(code: string) {
  form.code = code
}

function submitManual() {
  const row = {
    code: form.code,
    date: form.date,
    observed: form.observed,
    horizontal: form.observed ? Number(form.hText) : null,
    vertical: form.observed ? Number(form.vText) : null,
    reason: form.reason,
  }
  if (form.observed && (form.hText.trim() === '' || form.vText.trim() === '')) {
    flash(false, '已观测但取值留空：没有取值不能当 0；如确为缺测，请取消「本次已观测」并填写缺测原因')
    return
  }
  const result = submitBatch([row], 'manual')
  flash(result.ok, result.message)
  if (result.ok) {
    Object.assign(form, { date: '', hText: '', vText: '', reason: '', observed: true })
    reload()
  }
}

function submitImport() {
  const parsed = tryParseImportText(importText.value)
  if (!parsed.ok || !parsed.data) {
    flash(false, parsed.message)
    return
  }
  const result = submitBatch(parsed.data, 'import')
  flash(result.ok, result.message)
  if (result.ok) {
    importText.value = ''
    reload()
  }
}

function doReview(pointId: number) {
  const result = reviewPoint(pointId)
  flash(result.ok, result.message)
  reload()
}

function doRegisterDefect(pointId: number) {
  const result = registerDefect(pointId)
  flash(result.ok, result.message)
  reload()
}

function doExport() {
  const { filename, content } = exportDisplacement()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  flash(true, `已另存：CSV 中超限 ${overview.value.overlimit.length} 条，与本页一致`)
}

function doReset() {
  const result = resetDisplacement(true)
  overview.value = result.overview
  notes.value = result.notes
  flash(true, '位移数据已重置为内置示例')
}

function rowClass(state: string): string {
  return state === '超限' ? 'row-overlimit' : state === '暂不可判定' ? 'row-pending' : ''
}

function stateClass(state: string): string {
  if (state === '超限') return 'overlimit'
  if (state === '暂不可判定') return 'pending'
  return 'ok'
}

function gapClass(kind: string): string {
  if (kind === '缺测') return 'missing'
  if (kind === '字段缺失') return 'pending'
  return 'pending'
}

function pendingHint(reason: string): string {
  if (reason === '空态') return '一次有效取值都没有，累计位移留空，不按 0 参与超限判定'
  if (reason === '观测中断') return '最近一测次缺测，旧累计不能代表当前，补齐后自动恢复判定'
  if (reason === '缺少允许位移') return '允许位移未填，无法比对；补齐档案后即可判定'
  return ''
}

function sourceLabel(source: string): string {
  return { seed: '内置示例', manual: '单测次录入', import: '整套导入', legacy: '存量迁移' }[source] ?? source
}

onMounted(reload)
</script>

<style scoped>
.block-title { font-size: 14px; margin: 18px 0 8px; }
.warn { color: #b42318; }
.muted { color: #64748b; }
.gap { color: #b45418; }
.state-tag { border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.state-tag.overlimit { background: #fee4e2; color: #b42318; }
.state-tag.pending { background: #fef3c7; color: #92400e; }
.state-tag.ok { background: #dcfae6; color: #027a48; }
.state-tag.missing { background: #e0e7ff; color: #3730a3; }
.row-overlimit { background: #fff7f6; }
.row-pending { background: #fffdf5; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 8px; }
.entry-form { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.entry-form label { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); gap: 4px; margin-bottom: 8px; }
.entry-form label.check { flex-direction: row; align-items: center; gap: 6px; color: #1f2937; }
.entry-form input, .entry-form select, .entry-form textarea { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.entry-form textarea { width: 100%; resize: vertical; font-family: monospace; }
.form-actions { display: flex; align-items: center; gap: 10px; }
.hint { font-size: 12px; color: var(--muted); }
.foot-msg { font-size: 13px; }
.ok-text { color: #027a48; }
.migration-note { background: #f8fafc; border: 1px dashed var(--border); border-radius: 8px; padding: 8px 14px; margin-top: 16px; }
.migration-note ul { margin: 6px 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
button:disabled { color: #9aa6b2; cursor: not-allowed; }
</style>
