<template>
  <section class="page" data-module="displacement">
    <header class="page-head">
      <div>
        <h2>位移监测管理</h2>
        <p class="page-desc">
          测点逐测次观测：缺测/中断单独留空注明原因，不计入累计位移、不参与超限判定；
          测点列表、超限清单、另存成果读同一份判定结果。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记位移测点</button>
        <button class="btn" type="button" @click="openSubmit">提交观测</button>
        <button class="btn" type="button" @click="openHistory">历史补数</button>
        <button class="btn" type="button" @click="exportRows">另存位移成果</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item warn">缺测/中断测次：{{ summaryData.missingRounds }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>测点编号/位置</span>
        <input v-model="keyword" placeholder="按测点编号或位置检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <h3 class="section-title">测点明细列表</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>测点编号</th>
          <th>测点位置</th>
          <th>测点高程(m)</th>
          <th>累计水平(mm)</th>
          <th>累计垂直(mm)</th>
          <th>合成位移(mm)</th>
          <th>允许位移(mm)</th>
          <th>最新测次</th>
          <th>缺测标记与原因</th>
          <th>判定/状态</th>
          <th>复核</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredViews" :key="row.id" :class="{ 'row-overlimit': row.status === '超限', 'row-unknown': row.status === '待观测' }">
          <td>{{ row.code }}</td>
          <td>{{ row.location }}</td>
          <td>{{ row.elevation }}</td>
          <td>{{ row.cumulativeHorizontal }}</td>
          <td>{{ row.cumulativeVertical }}</td>
          <td>{{ row.magnitude }}</td>
          <td>{{ row.limitMm }}</td>
          <td>{{ row.latestDate }} {{ row.latestStatus }}</td>
          <td>{{ row.missingInfo }}</td>
          <td>
            <strong v-if="row.status === '超限'" class="tag tag-danger">超限</strong>
            <span v-else-if="isUnknown(row.code)" class="tag tag-muted">暂不可判定</span>
            <span v-else class="tag tag-ok">{{ row.status }}</span>
          </td>
          <td>{{ row.reviewed ? '已复核' : '—' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="toggleRounds(row.code)">测次明细</button>
            <button class="link" type="button" @click="quickMissing(row.code)">登记缺测</button>
            <button class="link" type="button" @click="doReview(row.code)">提交复核</button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td colspan="12" class="empty-state">暂无位移测点，可先登记位移测点</td>
        </tr>
      </tbody>
    </table>

    <div v-if="expandedCode" class="round-panel">
      <h4 class="section-title">{{ expandedCode }} 逐测次明细（缺测/中断不参与累计）</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>观测日期</th><th>测次状态</th><th>水平增量(mm)</th><th>垂直增量(mm)</th>
            <th>实测高程(m)</th><th>缺测/中断原因</th><th>来源</th><th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="round in expandedRounds" :key="round.id" :class="{ 'row-missing': round.status !== 'ok' }">
            <td>{{ round.date }}</td>
            <td>{{ round.status === 'ok' ? '正常' : round.status === 'missing' ? '缺测' : '中断' }}</td>
            <td>{{ round.horizontal === null ? '空（不计 0）' : round.horizontal }}</td>
            <td>{{ round.vertical === null ? '空（不计 0）' : round.vertical }}</td>
            <td>{{ round.measuredElevation ?? '—' }}</td>
            <td>{{ round.reason || '—' }}</td>
            <td>{{ round.source === 'legacy' ? '存量/历史' : '外业提交' }}</td>
            <td>{{ round.note || '—' }}{{ round.reviewed ? '（已复核）' : '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 class="section-title">超限清单（{{ overLimit.length }} 条，与另存成果一致）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>测点编号</th><th>测点位置</th><th>合成位移(mm)</th><th>允许位移(mm)</th>
          <th>超出量(mm)</th><th>最新测次</th><th>设备缺陷</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="v in overLimit" :key="v.code" class="row-overlimit">
          <td>{{ v.code }}</td>
          <td>{{ v.location }}</td>
          <td>{{ v.magnitude }}</td>
          <td>{{ v.limitMm }}</td>
          <td>{{ v.exceed }}</td>
          <td>{{ v.latestDate }} 正常</td>
          <td>已自动登记，<RouterLink to="/defect" class="link">缺陷处置页可查</RouterLink></td>
        </tr>
        <tr v-if="!overLimit.length">
          <td colspan="7" class="empty-state">当前没有超限测点</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">暂不可判定测点（{{ unknownList.length }} 条，单列、不计入超限）</h3>
    <table class="data-table">
      <thead>
        <tr><th>测点编号</th><th>测点位置</th><th>已有测次</th><th>缺测/中断次数</th><th>原因说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="v in unknownList" :key="v.code" class="row-unknown">
          <td>{{ v.code }}</td>
          <td>{{ v.location }}</td>
          <td>{{ v.rounds }}</td>
          <td>{{ v.missingCount }}</td>
          <td>{{ v.reason }}</td>
        </tr>
        <tr v-if="!unknownList.length">
          <td colspan="5" class="empty-state">没有暂不可判定测点</td>
        </tr>
      </tbody>
    </table>

    <div v-if="notes.length" class="notes-panel">
      <h4 class="section-title">存量数据回填与缺失字段说明</h4>
      <ul>
        <li v-for="(note, index) in notes" :key="index">{{ note }}</li>
      </ul>
    </div>

    <div v-if="modal" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <h3>{{ modalTitle }}</h3>

        <template v-if="modal === 'register'">
          <p class="modal-hint">建点台账：测点高程必填；逐测次的实测高程在提交观测时再填。</p>
          <div class="form-grid">
            <label><span>测点编号 *</span><input v-model="registerForm.code" placeholder="如 DISP-0005" /></label>
            <label><span>测点位置</span><input v-model="registerForm.location" placeholder="如 坝顶 0+300" /></label>
            <label><span>测点高程(m) *</span><input v-model="registerForm.elevation" placeholder="如 286.5" /></label>
            <label><span>允许位移(mm) *</span><input v-model="registerForm.limitMm" placeholder="如 20" /></label>
            <label><span>监测频次</span><input v-model="registerForm.frequency" placeholder="1次/月" /></label>
          </div>
        </template>

        <template v-else>
          <p class="modal-hint">
            {{ modal === 'history' ? '按观测日期补数：每行一条，日期必填；位移缺项不当 0，自动按缺测单列。' : '整套观测一起提交：任一测点未登记/取值缺失/日期重复，整笔退回不写入。' }}
          </p>
          <p class="modal-hint">
            每行格式（逗号或制表符分隔）：测点编号, 观测日期, 状态(正常/缺测/中断), 水平增量mm, 垂直增量mm, 实测高程m, 缺测原因, 备注
          </p>
          <textarea
            v-model="batchText"
            class="batch-input"
            rows="9"
            placeholder="DISP-0001,2026-10-08,正常,2.1,1.0,286.36,,&#10;DISP-0002,2026-10-08,缺测,,,,仪器故障,全站仪送检"
          ></textarea>
        </template>

        <template v-if="modal === 'missing'">
          <p class="modal-hint">为 {{ quickCode }} 登记一轮缺测/中断：位移留空，只记录原因。</p>
          <div class="form-grid">
            <label><span>观测日期 *</span><input v-model="missingForm.date" type="date" /></label>
            <label>
              <span>类型 *</span>
              <select v-model="missingForm.status">
                <option value="missing">缺测（整次未测）</option>
                <option value="interrupted">中断（测了但未完成）</option>
              </select>
            </label>
            <label>
              <span>原因 *</span>
              <select v-model="missingForm.reason">
                <option v-for="reason in missingReasons" :key="reason" :value="reason">{{ reason }}</option>
              </select>
            </label>
            <label><span>已测高程(m，可空)</span><input v-model="missingForm.elevation" placeholder="中断时可填已完成的读数" /></label>
            <label class="wide"><span>备注</span><input v-model="missingForm.note" /></label>
          </div>
        </template>

        <div v-if="lastResult" class="result-box" :class="lastResult.ok ? 'ok' : 'fail'">
          <p>{{ lastResult.message }}</p>
          <ul v-if="lastResult.rowErrors.length">
            <li v-for="error in lastResult.rowErrors" :key="error.line">
              第 {{ error.line }} 行：{{ error.problems.join('；') }}
            </li>
          </ul>
        </div>

        <div class="modal-actions">
          <button class="btn" type="button" @click="closeModal">关闭</button>
          <button v-if="modal === 'register'" class="btn primary" type="button" :disabled="busy" @click="doRegister">登记</button>
          <button v-else-if="modal === 'missing'" class="btn primary" type="button" :disabled="busy" @click="doQuickMissing">提交缺测</button>
          <button v-else class="btn primary" type="button" :disabled="busy" @click="doBatch">
            {{ busy ? '提交处理中…' : modal === 'history' ? '整批补数' : '整批提交' }}
          </button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ views.length }} 个位移测点 · 超限 {{ overLimit.length }} 条 · 暂不可判定 {{ unknownList.length }} 条（报表同口径）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadDisplacementCsv,
  overLimitVerdicts,
  pointViews,
  backfillHistory,
  registerPoint,
  reviewPoint,
  submitBatch,
  unknownVerdicts,
  roundsFor,
  migrationNotes,
  summary,
  type PointView,
} from '@/api/displacement-service'
import { MISSING_REASONS } from '@/data/displacement/types'
import type { MissingReason, RoundStatus, SubmitResult } from '@/data/displacement/types'

const views = ref<PointView[]>([])
const notes = ref<string[]>([])
const summaryData = ref(summary())
const keyword = ref('')
const errorMessage = ref('')
const busy = ref(false)

type ModalKind = 'register' | 'submit' | 'history' | 'missing' | null
const modal = ref<ModalKind>(null)
const lastResult = ref<SubmitResult | null>(null)
const batchText = ref('')
const expandedCode = ref('')
const expandedRounds = ref<ReturnType<typeof roundsFor>>([])

const registerForm = ref({ code: '', location: '', elevation: '', limitMm: '', frequency: '1次/月' })
const quickCode = ref('')
const missingForm = ref<{ date: string; status: RoundStatus; reason: MissingReason; elevation: string; note: string }>({
  date: new Date().toISOString().slice(0, 10),
  status: 'missing',
  reason: '天气原因停测',
  elevation: '',
  note: '',
})
const missingReasons = MISSING_REASONS.filter((reason) => reason !== '测点尚未首测' && reason !== '历史资料缺失')

const stats = computed(() => [
  { label: '观测中测点', value: summaryData.value.observing },
  { label: '超限测点', value: summaryData.value.overLimit },
  { label: '暂不可判定', value: summaryData.value.unknown },
  { label: '缺测/中断测次', value: summaryData.value.missingRounds },
])

const statusSummary = computed(() => {
  const buckets: Record<string, number> = { 待观测: 0, 观测中: 0, 超限: 0 }
  for (const row of views.value) buckets[row.status] = (buckets[row.status] ?? 0) + 1
  return Object.entries(buckets).map(([status, count]) => ({ status, count }))
})

const filteredViews = computed(() => {
  const key = keyword.value.trim()
  if (!key) return views.value
  return views.value.filter((row) => row.code.includes(key) || row.location.includes(key))
})
const overLimit = computed(() =>
  overLimitVerdicts().map((v) => ({
    code: v.point.code,
    location: v.point.location,
    magnitude: fmt(v.magnitude),
    limitMm: v.limitMm,
    exceed: fmt(v.magnitude - v.limitMm),
    latestDate: v.latest?.date ?? '—',
  })),
)
const unknownList = computed(() =>
  unknownVerdicts().map((v) => ({
    code: v.point.code,
    location: v.point.location,
    rounds: v.rounds,
    missingCount: v.missingCount,
    reason: v.unknownReason,
  })),
)

const modalTitle = computed(() => {
  if (modal.value === 'register') return '登记位移测点'
  if (modal.value === 'submit') return '提交观测（整套）'
  if (modal.value === 'history') return '历史资料补数'
  return '登记缺测/中断测次'
})

function isUnknown(code: string): boolean {
  return unknownList.value.some((v) => v.code === code)
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

function reload() {
  views.value = pointViews()
  notes.value = migrationNotes()
  summaryData.value = summary()
  if (expandedCode.value) expandedRounds.value = roundsFor(expandedCode.value)
}

function resetFilters() {
  keyword.value = ''
  reload()
}

function exportRows() {
  // 导出走与页面完全相同的统一视图：导出的超限条数 = 页面超限清单条数。
  downloadDisplacementCsv()
}

function openRegister() {
  modal.value = 'register'
  lastResult.value = null
}
function openSubmit() {
  modal.value = 'submit'
  lastResult.value = null
  batchText.value = ''
}
function openHistory() {
  modal.value = 'history'
  lastResult.value = null
  batchText.value = ''
}
function quickMissing(code: string) {
  quickCode.value = code
  modal.value = 'missing'
  lastResult.value = null
  missingForm.value = {
    date: new Date().toISOString().slice(0, 10),
    status: 'missing',
    reason: '天气原因停测',
    elevation: '',
    note: '',
  }
}
function closeModal() {
  modal.value = null
  lastResult.value = null
}

function toggleRounds(code: string) {
  if (expandedCode.value === code) {
    expandedCode.value = ''
    expandedRounds.value = []
    return
  }
  expandedCode.value = code
  expandedRounds.value = roundsFor(code)
}

function runGuarded(action: () => SubmitResult) {
  if (busy.value) return
  busy.value = true
  try {
    const result = action()
    lastResult.value = result
    if (result.ok) {
      reload()
      if (modal.value !== 'missing' && modal.value !== 'register') batchText.value = ''
    }
  } finally {
    busy.value = false
  }
}

function doRegister() {
  runGuarded(() => registerPoint(registerForm.value))
}

function doBatch() {
  runGuarded(() => (modal.value === 'history' ? backfillHistory(batchText.value) : submitBatch(batchText.value)))
}

function doQuickMissing() {
  const f = missingForm.value
  const elev = f.elevation.trim()
  const line = [
    quickCode.value,
    f.date,
    f.status === 'missing' ? '缺测' : '中断',
    '',
    '',
    elev,
    f.reason,
    f.note,
  ].join(',')
  runGuarded(() => submitBatch(line))
  if (lastResult.value?.ok) closeModal()
}

function doReview(code: string) {
  errorMessage.value = ''
  const result = reviewPoint(code)
  if (!result.ok) errorMessage.value = result.message
  reload()
}

onMounted(reload)
</script>
