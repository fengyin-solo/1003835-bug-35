<template>
  <section class="page" data-module="coordinate">
    <header class="page-head">
      <div>
        <h2>三维坐标管理</h2>
        <p class="page-desc">
          维护测点记录，围绕测点编号、所属单位、坐标系、北坐标做登记、筛选与状态流转。
          当前登录单位「{{ store.unit }}」，仅本单位测点可校核，跨单位与已归档测点只读。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!selectedEditableIds.length" @click="openBatchPanel">
          批量校核（{{ selectedEditableIds.length }}）
        </button>
        <button class="btn" type="button" :disabled="!selectedEditableIds.length" @click="simulateRace">
          模拟另一终端抢先校核
        </button>
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

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allVisibleEditableSelected"
              :disabled="!visibleEditableRows.length"
              @change="toggleAllVisible"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>数据版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-readonly': !canEdit(row) }">
          <td class="col-check">
            <input
              type="checkbox"
              :value="Number(row.id)"
              :checked="selectedIds.has(Number(row.id))"
              :disabled="!canEdit(row)"
              :title="checkHint(row)"
              @change="toggleOne(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>v{{ Number(row.version ?? 1) }}</td>
          <td>
            {{ row.status }}
            <span v-if="!isOwnUnit(row)" class="lock-tag">跨单位·只读</span>
            <span v-else-if="row.status === '已归档'" class="lock-tag">已归档·只读</span>
          </td>
          <td class="row-actions">
            <template v-if="canEdit(row)">
              <button class="link" type="button" @click="retestOne(row)">
                安排重测
              </button>
            </template>
            <span v-else class="readonly-text">仅可查看</span>
            <button class="link" type="button" @click="showRetrials(row)">
              重测记录（{{ retrialCount(row) }}）
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无三维坐标数据，可先登记测点记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条三维坐标记录；勾选 {{ selectedIds.size }} 条（可校核 {{ selectedEditableIds.length }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 重测记录：按测点业务编号关联展示，与坐标列表行序无关，不会随勾选/筛选串位。 -->
    <section v-if="activeRetrials.length" class="retrial-panel">
      <h3>重测记录 / 现场复测清单关联（测点 {{ activeRetrialCode }}）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>关联测点</th>
            <th>重测原因</th>
            <th>登记人</th>
            <th>登记日期</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in activeRetrials" :key="String(item.id)">
            <td>{{ item['关联测点'] }}</td>
            <td>{{ item['重测原因'] }}</td>
            <td>{{ item['登记人'] }}</td>
            <td>{{ item['登记日期'] }}</td>
            <td>{{ item.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 批量校核面板：每个测点一行独立草稿，键为测点 id，杜绝「后一行的校核人/高程写到前一行」。 -->
    <div v-if="batchOpen" class="batch-mask" @click.self="closeBatchPanel">
      <section class="batch-dialog">
        <header class="batch-head">
          <h3>批量校核 · {{ drafts.length }} 个测点独立填写</h3>
          <button class="link" type="button" @click="closeBatchPanel">关闭</button>
        </header>
        <p class="batch-tip">
          每条测点必须独立填写校核人与结论；任一条校验失败，整批退回，不保留半批结果。
          若另一终端已先行落库，后到者将收到版本冲突结果。
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>测点编号</th>
              <th>所属单位</th>
              <th>测量高程</th>
              <th>校核人（必填）</th>
              <th>校核高程（通过必填）</th>
              <th>校核结论</th>
              <th>重测原因（重测必填）</th>
              <th>基线版本</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="draft in drafts" :key="String(draft.coordinateId)">
              <td>{{ codeOf(draft.coordinateId) }}</td>
              <td>{{ unitOf(draft.coordinateId) }}</td>
              <td>{{ elevationOf(draft.coordinateId) }}</td>
              <td>
                <input v-model="draft.校核人" placeholder="本测点校核人" />
              </td>
              <td>
                <input v-model="draft.校核高程" placeholder="如 48.705" />
              </td>
              <td>
                <select v-model="draft.结论">
                  <option value="通过">通过</option>
                  <option value="重测">重测</option>
                </select>
              </td>
              <td>
                <input
                  v-model="draft.重测原因"
                  :placeholder="draft.结论 === '重测' ? '必须填写重测原因' : '通过时留空'"
                  :disabled="draft.结论 === '通过'"
                />
              </td>
              <td>v{{ draft.baseVersion }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="batchFailures.length" class="batch-failures">
          <strong>整批已退回，以下测点未落库：</strong>
          <ul>
            <li v-for="failure in batchFailures" :key="failure.coordinateId" :class="{ conflict: failure.conflict }">
              {{ failure.测点编号 }}：{{ failure.reason }}
              <em v-if="failure.conflict">（并发冲突）</em>
            </li>
          </ul>
        </div>
        <p v-else-if="batchMessage" class="batch-ok">{{ batchMessage }}</p>

        <footer class="batch-foot">
          <button class="btn" type="button" @click="fillCurrentOperator">填入当前操作人</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitBatch">
            {{ submitting ? '提交中…' : '整批提交校核' }}
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  arrangeRetest,
  batchCheckCoordinates,
  canCheck,
  listCoordinates,
  listRetrials,
  simulateConcurrentUpdate,
} from '@/api/coordinate-service'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { CheckDraft, CheckFailure, EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('coordinate')
const columns = ["测点编号", "所属单位", "坐标系", "北坐标", "东坐标", "高程值", "校核人", "校核高程", "测量人", "记录状态"]
const editableStatuses = ['已测量', '已校核', '需重测']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 选中集合以测点业务 id 为键，绝不使用行下标；筛选、排序、刷新都不会让勾选串位。
const selectedIds = reactive(new Set<number>())

// 批量校核面板状态。
const batchOpen = ref(false)
const submitting = ref(false)
const drafts = ref<CheckDraft[]>([])
const batchFailures = ref<CheckFailure[]>([])
const batchMessage = ref('')

const activeRetrialCode = ref('')

const stats = computed(() => [
  { label: '测点总数', value: rows.value.length },
  { label: '已校核数', value: rows.value.filter((row) => row.status === '已校核').length },
  { label: '待校核数', value: rows.value.filter((row) => row.status === '已测量' || row.status === '需重测').length },
])

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const retrials = computed(() => listRetrials())

const activeRetrials = computed(() =>
  activeRetrialCode.value
    ? retrials.value.filter((item) => String(item['关联测点']) === activeRetrialCode.value)
    : [],
)

function isOwnUnit(row: EntryRow): boolean {
  return String(row['所属单位']) === store.unit
}

/** 可校核 = 本单位且未归档；跨单位测点和历史归档坐标只能查看。 */
function canEdit(row: EntryRow): boolean {
  return canCheck(row, store.unit) && editableStatuses.includes(String(row.status))
}

function checkHint(row: EntryRow): string {
  if (row.status === '已归档') {
    return '已归档历史坐标只读'
  }
  if (!isOwnUnit(row)) {
    return `测点属于 ${String(row['所属单位'])}，跨单位只能查看`
  }
  return '勾选后参与批量校核'
}

const visibleEditableRows = computed(() => rows.value.filter((row) => canEdit(row)))
const selectedEditableIds = computed(() =>
  [...selectedIds].filter((id) => {
    const row = rows.value.find((item) => Number(item.id) === id)
    return row ? canEdit(row) : false
  }),
)
const allVisibleEditableSelected = computed(
  () =>
    visibleEditableRows.value.length > 0 &&
    visibleEditableRows.value.every((row) => selectedIds.has(Number(row.id))),
)

function toggleOne(row: EntryRow) {
  const id = Number(row.id)
  if (selectedIds.has(id)) {
    selectedIds.delete(id)
  } else {
    selectedIds.add(id)
  }
}

function toggleAllVisible(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  for (const row of visibleEditableRows.value) {
    const id = Number(row.id)
    if (checked) {
      selectedIds.add(id)
    } else {
      selectedIds.delete(id)
    }
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function formatCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || value === '') {
    return '—'
  }
  return String(value)
}

function codeOf(id: number): string {
  return String(rows.value.find((row) => Number(row.id) === id)?.['测点编号'] ?? `#${id}`)
}

function unitOf(id: number): string {
  return String(rows.value.find((row) => Number(row.id) === id)?.['所属单位'] ?? '—')
}

function elevationOf(id: number): string {
  const value = rows.value.find((row) => Number(row.id) === id)?.['高程值']
  return value === undefined || value === '' ? '—' : String(value)
}

function retrialCount(row: EntryRow): number {
  const code = String(row['测点编号'])
  return retrials.value.filter((item) => String(item['关联测点']) === code).length
}

function showRetrials(row: EntryRow) {
  activeRetrialCode.value = String(row['测点编号'])
}

function retestOne(row: EntryRow) {
  const reason = window.prompt(`测点 ${String(row['测点编号'])} 安排重测，请填写重测原因`)
  if (reason === null) {
    return
  }
  errorMessage.value = ''
  const result = arrangeRetest(Number(row.id), reason, {
    operator: store.operator,
    unit: store.unit,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  activeRetrialCode.value = String(row['测点编号'])
}

/**
 * 打开批量面板：对每个勾选测点做快照，生成独立草稿对象，并记录当前版本号。
 * 草稿数组每项自带 coordinateId，输入框只绑定自己那份草稿，和表格行序号完全无关。
 */
function openBatchPanel() {
  const selected = rows.value.filter(
    (row) => selectedIds.has(Number(row.id)) && canEdit(row),
  )
  drafts.value = selected.map((row) => ({
    coordinateId: Number(row.id),
    校核人: '',
    校核高程: '',
    结论: '通过',
    重测原因: '',
    baseVersion: Number(row.version ?? 1),
  }))
  batchFailures.value = []
  batchMessage.value = ''
  batchOpen.value = true
}

function closeBatchPanel() {
  batchOpen.value = false
  drafts.value = []
  batchFailures.value = []
  batchMessage.value = ''
  reload()
}

function fillCurrentOperator() {
  for (const draft of drafts.value) {
    draft.校核人 = store.operator
  }
}

/**
 * 整批提交：服务端（本地服务层）两阶段处理——
 * 先逐条独立校验（单位、归档、必填、版本），任一失败整批退回；
 * 零失败才在同一次存储写入里提交坐标、重测记录和现场复测清单。
 */
function submitBatch() {
  submitting.value = true
  batchFailures.value = []
  batchMessage.value = ''
  try {
    const result = batchCheckCoordinates(drafts.value.map((draft) => ({ ...draft })), {
      operator: store.operator,
      unit: store.unit,
    })
    if (!result.ok) {
      batchFailures.value = result.failures ?? []
      batchMessage.value = result.message
      // 冲突意味着库内版本已变：重新从存储层读取，结果页与保存值保持一致。
      reload()
      return
    }
    batchMessage.value = result.message
    // 成功后丢弃全部草稿与勾选，结果以存储层重读为准，避免页面显示旧值。
    selectedIds.clear()
    drafts.value = []
    reload()
    window.setTimeout(() => {
      batchOpen.value = false
    }, 800)
  } finally {
    submitting.value = false
  }
}

/** 演示并发：让「另一终端」对当前勾选测点抢先落库（版本号 +1），本终端再提交即收到冲突。 */
function simulateRace() {
  errorMessage.value = ''
  const bumped = simulateConcurrentUpdate([...selectedIds], store.unit)
  reload()
  errorMessage.value = `另一终端已抢先校核 ${bumped} 个重叠测点；本终端提交时这些测点将被判冲突，整批退回。`
}

/** 结果页一律从存储层重读，批量校核/并发模拟后页面与保存值严格一致。 */
function reload() {
  errorMessage.value = ''
  try {
    rows.value = listCoordinates()
    total.value = rows.value.length
    // 清理已不存在或变为只读的勾选，防止脏选择。
    for (const id of [...selectedIds]) {
      const row = rows.value.find((item) => Number(item.id) === id)
      if (!row || !canEdit(row)) {
        selectedIds.delete(id)
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '三维坐标列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.col-check {
  width: 36px;
  text-align: center;
}
.row-readonly {
  background: #fafbfc;
  color: #64748b;
}
.lock-tag,
.readonly-text {
  display: inline-block;
  margin-left: 6px;
  font-size: 12px;
  color: #b45309;
}
.retrial-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.retrial-panel h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.batch-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.batch-dialog {
  width: min(1080px, 92vw);
  max-height: 86vh;
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  padding: 16px;
}
.batch-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.batch-head h3 {
  margin: 0;
  font-size: 16px;
}
.batch-tip {
  color: var(--muted);
  font-size: 12px;
}
.batch-dialog input,
.batch-dialog select {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.batch-failures {
  margin-top: 10px;
  border: 1px solid #fda29b;
  background: #fef3f2;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: #b42318;
}
.batch-failures ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.batch-failures .conflict {
  font-weight: 600;
}
.batch-ok {
  margin-top: 10px;
  color: #067647;
  font-size: 13px;
}
.batch-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
</style>
