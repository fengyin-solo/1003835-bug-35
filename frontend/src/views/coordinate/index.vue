<template>
  <section class="page" data-module="coordinate">
    <header class="page-head">
      <div>
        <h2>三维坐标管理</h2>
        <p class="page-desc">
          维护测点记录，勾选后逐条独立填写校核人与复核高程批量校核；当前登录单位「{{ store.unit }}」，跨单位测点只能查看。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记测点记录</button>
        <button class="btn" type="button" @click="exportRows">导出三维坐标清单</button>
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
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="externalNote" class="batch-note warn">{{ externalNote }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col">
            <input
              type="checkbox"
              :checked="allSelectableChecked"
              :disabled="selectableRows.length === 0"
              title="全选当前可校核测点"
              @change="toggleSelectAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>数据版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'readonly-row': !canVerify(row) }">
          <td class="check-col">
            <input
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              :disabled="!canVerify(row)"
              :title="lockReason(row)"
              @change="toggleRow(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>v{{ rowVersion(row) }}</td>
          <td>
            {{ row.status }}
            <span v-if="!sameUnit(row)" class="tag tag-readonly" :title="lockReason(row)">跨单位只读</span>
            <span v-else-if="isArchived(row)" class="tag tag-readonly">已归档锁定</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canWrite(row)"
              :title="canWrite(row) ? action : lockReason(row)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无三维坐标数据，可先登记测点记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 批量校核面板：每条测点一行独立录入，草稿按测点 id 存储，行序怎么变都不会串位 -->
    <div v-if="selectedRows.length > 0" class="batch-panel">
      <h3>批量校核（已选 {{ selectedRows.length }} 条，每条独立校核）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>测点编号</th>
            <th>所属单位</th>
            <th>登记高程(m)</th>
            <th>复核高程(m)</th>
            <th>较差(m)</th>
            <th>校核人</th>
            <th>基准版本</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in selectedRows" :key="`draft-${row.id}`">
            <td>{{ row['测点编号'] }}</td>
            <td>{{ row['所属单位'] }}</td>
            <td>{{ row['高程值'] }}</td>
            <td>
              <input
                v-model.number="drafts[Number(row.id)].checkedElevationText"
                class="cell-input"
                type="number"
                step="0.001"
                placeholder="逐条填写"
              />
            </td>
            <td :class="deviationClass(row)">{{ deviationText(row) }}</td>
            <td>
              <input
                v-model="drafts[Number(row.id)].checker"
                class="cell-input"
                type="text"
                placeholder="本条校核人"
              />
            </td>
            <td>v{{ drafts[Number(row.id)].expectedVersion }}</td>
          </tr>
        </tbody>
      </table>
      <div class="batch-actions">
        <button class="btn primary" type="button" @click="submitBatch">整批提交校核</button>
        <button class="btn ghost" type="button" @click="clearSelection">取消勾选</button>
        <span class="batch-hint">任一测点校验不通过或与其他终端版本冲突时，整批退回，不会只保存成功部分。</span>
      </div>
    </div>

    <div v-if="lastResult" class="batch-result" :class="batchOk ? 'result-ok' : 'result-error'">
      <p>{{ batchMessage }}</p>
      <p v-if="lastResult.conflicts.length > 0">
        冲突测点：{{ lastResult.conflicts.map((c) => `${c.code}(当前 v${c.currentVersion})`).join('、') }}
      </p>
      <p v-if="lastResult.retested.length > 0">
        重测任务已回写至另一个业务面：
        <RouterLink to="/survey">考古调查 · 现场复测清单</RouterLink>
      </p>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条三维坐标记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  batchVerifyCoordinates,
  downloadEntries,
  ELEVATION_TOLERANCE,
  listEntriesFresh,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { BatchVerifyResult, EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('coordinate')
// 记录状态单列展示，其余字段全部进主表（含校核高程、校核人，保存后页面与落库值直接对得上）。
const columns = meta.fields.filter((field) => field !== '记录状态')
// 行内只留流转动作；「提交校核（已测量→已校核）」必须走下方批量校核面板，逐条独立录入。
const actions = ['确认校核', '安排重测']
const statuses = ['已测量', '已校核', '需重测', '已归档']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['测点编号', '所属单位', '坐标系']

// 勾选与逐条录入草稿：一律以测点 id 为键，杜绝按下标对位导致的「后一行写到前一行」。
type VerifyDraft = { checker: string; checkedElevationText: string; expectedVersion: number }
const selectedIds = reactive(new Set<number>())
const drafts = reactive<Record<number, VerifyDraft>>({})

const batchMessage = ref('')
const batchOk = ref(false)
const lastResult = ref<BatchVerifyResult | null>(null)
const externalNote = ref('')

const stats = computed(() => [
  { label: '测点总数', value: rows.value.length },
  { label: '已校核数', value: rows.value.filter((row) => String(row.status) === '已校核').length },
  { label: '待校核数', value: rows.value.filter((row) => String(row.status) === '已测量').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowVersion(row: EntryRow): number {
  return typeof row.version === 'number' ? row.version : 1
}

function sameUnit(row: EntryRow): boolean {
  return String(row['所属单位'] ?? '') === store.unit
}

function isArchived(row: EntryRow): boolean {
  return String(row.status) === '已归档'
}

/** 可勾选进批量校核：本单位、未归档、尚未校核（已测量/需重测）。 */
function canVerify(row: EntryRow): boolean {
  return sameUnit(row) && !isArchived(row) && String(row.status) !== '已校核'
}

/** 行内单动作可写：本单位且未归档（重复状态由服务端拦）。 */
function canWrite(row: EntryRow): boolean {
  return sameUnit(row) && !isArchived(row)
}

function lockReason(row: EntryRow): string {
  if (isArchived(row)) {
    return '历史已归档坐标不允许修改'
  }
  if (!sameUnit(row)) {
    return '跨单位测点只能查看'
  }
  if (String(row.status) === '已校核') {
    return '该测点已校核，不能重复校核'
  }
  return '勾选后参与批量校核'
}

const selectableRows = computed(() => rows.value.filter(canVerify))
const allSelectableChecked = computed(
  () =>
    selectableRows.value.length > 0 &&
    selectableRows.value.every((row) => selectedIds.has(Number(row.id))),
)
const selectedRows = computed(() =>
  rows.value.filter((row) => selectedIds.has(Number(row.id))),
)

function addDraft(row: EntryRow) {
  const id = Number(row.id)
  drafts[id] = {
    checker: store.operator === '值班管理员' ? '' : store.operator,
    checkedElevationText: '',
    expectedVersion: rowVersion(row),
  }
}

function toggleRow(row: EntryRow) {
  batchMessage.value = ''
  const id = Number(row.id)
  if (selectedIds.has(id)) {
    selectedIds.delete(id)
    delete drafts[id]
  } else {
    selectedIds.add(id)
    addDraft(row)
  }
}

function toggleSelectAll(event: Event) {
  batchMessage.value = ''
  const checked = (event.target as HTMLInputElement).checked
  for (const row of selectableRows.value) {
    const id = Number(row.id)
    if (checked) {
      if (!selectedIds.has(id)) {
        selectedIds.add(id)
        addDraft(row)
      }
    } else {
      selectedIds.delete(id)
      delete drafts[id]
    }
  }
}

function clearSelection() {
  selectedIds.clear()
  for (const key of Object.keys(drafts)) {
    delete drafts[Number(key)]
  }
  batchMessage.value = ''
  lastResult.value = null
}

function parsedDraftElevation(row: EntryRow): number | null {
  const draft = drafts[Number(row.id)]
  if (!draft || draft.checkedElevationText.trim() === '') {
    return null
  }
  const value = Number(draft.checkedElevationText)
  return Number.isFinite(value) ? value : null
}

function deviationText(row: EntryRow): string {
  const checked = parsedDraftElevation(row)
  if (checked === null) {
    return '—'
  }
  const registered = Number(row['高程值'])
  if (!Number.isFinite(registered)) {
    return '登记高程异常'
  }
  return Math.abs(checked - registered).toFixed(3)
}

function deviationClass(row: EntryRow): string {
  const checked = parsedDraftElevation(row)
  if (checked === null) {
    return ''
  }
  const registered = Number(row['高程值'])
  if (!Number.isFinite(registered)) {
    return 'error-text'
  }
  return Math.abs(checked - registered) > ELEVATION_TOLERANCE ? 'error-text' : 'ok-text'
}

function submitBatch() {
  errorMessage.value = ''
  const items = selectedRows.value.map((row) => {
    const draft = drafts[Number(row.id)]
    const text = draft.checkedElevationText.trim()
    const value = text === '' ? null : Number(text)
    return {
      id: Number(row.id),
      expectedVersion: draft.expectedVersion,
      checker: draft.checker,
      checkedElevation: value !== null && Number.isFinite(value) ? value : null,
    }
  })
  const result = batchVerifyCoordinates(items, { unit: store.unit, operator: store.operator })
  batchOk.value = result.ok
  batchMessage.value = result.message
  lastResult.value = result
  // 无论成功还是冲突退回，都以库里最新数据重渲染，保证页面与保存值一致。
  reload()
  if (result.ok) {
    clearSelection()
    lastResult.value = result
  } else if (result.conflicts.length > 0 || result.message.includes('版本')) {
    // 冲突后旧基准版本作废，强制重新勾选、重新看数，避免拿旧版本再撞一次。
    clearSelection()
    lastResult.value = result
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '测点记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  batchMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    unit: store.unit,
    operator: store.operator,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntriesFresh(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 别的终端可能已把某条勾选记录校核/归档：清掉已不可校核的勾选与草稿，
    // 但保留仍可校核记录的草稿（其 expectedVersion 已过期，提交时会命中乐观锁冲突提示）。
    const liveIds = new Set(rows.value.map((row) => Number(row.id)))
    for (const id of [...selectedIds]) {
      const row = rows.value.find((item) => Number(item.id) === id)
      if (!row || !liveIds.has(id) || !canVerify(row)) {
        selectedIds.delete(id)
        delete drafts[id]
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '三维坐标列表读取失败'
  }
}

// 另一个终端（浏览器标签页）校核落库后，本端 storage 会收到事件：刷新到最新版本，
// 已勾选测点的旧版本在提交时自然命中乐观锁冲突，由后到者收到冲突结果。
function onStorage(event: StorageEvent) {
  if (event.key && event.key !== storageKey()) {
    return
  }
  externalNote.value = '检测到其他终端已更新测点数据，列表已刷新到最新版本；已勾选记录提交时将按新版本校核。'
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})

onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.check-col {
  width: 40px;
  text-align: center;
}
.readonly-row {
  background: #fafbfd;
  color: #64748b;
}
.tag {
  display: inline-block;
  margin-left: 6px;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 18px;
}
.tag-readonly {
  background: #eef2f7;
  color: #64748b;
}
.link:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
.batch-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.batch-panel h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.cell-input {
  width: 110px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 13px;
}
.batch-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.batch-hint {
  color: var(--muted);
  font-size: 12px;
}
.batch-note {
  margin: 8px 0 0;
  font-size: 13px;
}
.batch-note.ok {
  color: #067647;
}
.batch-note.error {
  color: #b42318;
}
.batch-note.warn {
  color: #b54708;
}
.batch-result {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  font-size: 13px;
}
.batch-result p {
  margin: 2px 0;
}
.result-ok {
  border-color: #a6f4c5;
  background: #ecfdf3;
}
.result-error {
  border-color: #fda29b;
  background: #fef3f2;
}
.ok-text {
  color: #067647;
}
</style>
