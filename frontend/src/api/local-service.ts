import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitRows,
  freshRows,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  BatchVerifyResult,
  CoordinateVerifyItem,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const COORDINATE_KEY = 'coordinate'
const SURVEY_KEY = 'survey'
const STATUS_ARCHIVED = '已归档'
const STATUS_VERIFIED = '已校核'
const STATUS_REMEASURE = '需重测'
const STATUS_SURVEY_RECHECK = '需复查'
/** 复核高程与登记高程的允许较差（米）：超出即判定该测点需重测。 */
export const ELEVATION_TOLERANCE = 0.05

export type ActionContext = {
  /** 操作人所属单位，坐标模块用来卡跨单位只读 */
  unit?: string
  /** 操作人姓名，写进校核人/复测任务调查人 */
  operator?: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 直接读取最新落库数据，供坐标页在批量校核前/收到跨终端 storage 事件后刷新。 */
export function listEntriesFresh(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(freshRows()[key] ?? [], filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function todayCompact(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}${month}${day}`
}

/** 考古调查模块「现场复测清单」任务编号：RMS-日期-当日序号。 */
function nextRemeasureCode(rows: EntryRow[]): string {
  const prefix = `RMS-${todayCompact()}-`
  const seq = rows.filter((row) => String(row['调查编号'] ?? '').startsWith(prefix)).length + 1
  return `${prefix}${String(seq).padStart(3, '0')}`
}

/**
 * 坐标校核判重测后，向考古调查模块的现场复测清单回写一条任务。
 * 关联靠测点编号/所属单位这些稳定字段，绝不按数组下标对位（旧缺陷就是下标串位的根源）。
 */
function buildRemeasureEntry(
  surveyRows: EntryRow[],
  params: { unit: string; points: string[]; deviations: string[]; operator: string },
): EntryRow {
  const detail = params.deviations.join('，')
  return {
    id: nextId(surveyRows),
    status: STATUS_SURVEY_RECHECK,
    pending: true,
    abnormal: false,
    version: 1,
    调查编号: nextRemeasureCode(surveyRows),
    调查区域: params.unit,
    调查方法: '现场复测',
    地表发现: `复测测点：${params.points.join('、')}`,
    断面观察: detail.length > 200 ? `${detail.slice(0, 197)}...` : detail,
    初步断代: '',
    调查人: params.operator,
    记录状态: STATUS_SURVEY_RECHECK,
  }
}

function rowCode(row: EntryRow): string {
  return String(row['测点编号'] ?? row.id)
}

function rowVersion(row: EntryRow): number {
  return typeof row.version === 'number' ? row.version : 1
}

function parseElevation(value: string | number | boolean | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 坐标模块的写操作前置校验：归档锁定、跨单位只读。任何写动作都必须先过这一关。 */
function guardCoordinateRow(row: EntryRow | undefined, id: number, unit: string): string | null {
  if (!row) {
    return `没有找到编号为 ${id} 的测点记录`
  }
  if (String(row.status) === STATUS_ARCHIVED) {
    return `测点 ${rowCode(row)} 已归档，历史归档坐标不允许修改`
  }
  if (String(row['所属单位'] ?? '') !== unit) {
    return `测点 ${rowCode(row)} 属于${String(row['所属单位'] ?? '其他单位')}，跨单位测点只能查看`
  }
  return null
}

export function runAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === COORDINATE_KEY) {
    return runCoordinateAction(id, action, target, meta, context)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    version: rowVersion(rows[index]) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runCoordinateAction(
  id: number,
  action: string,
  target: string,
  meta: ModuleMeta,
  context: ActionContext,
): ActionResult {
  // 「已测量 → 已校核」只允许走批量校核面板：必须逐条独立填写校核人与复核高程，
  // 单条直改会绕过独立校核，因此在这里封死。
  if (target === STATUS_VERIFIED) {
    return {
      ok: false,
      message: '测点校核必须逐条填写校核人与复核高程，请在列表勾选后使用「整批提交校核」',
    }
  }
  const unit = context.unit ?? ''
  const operator = context.operator ?? ''
  const store = freshRows()
  const rows = store[COORDINATE_KEY] ?? []
  const row = rows.find((item) => Number(item.id) === id)
  const blocked = guardCoordinateRow(row, id, unit)
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const current = String(row!.status)
  if (current === target) {
    return { ok: false, message: `测点 ${rowCode(row!)}已经是「${target}」，不用重复操作` }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row!,
    status: target,
    pending: target !== lastStatus,
    abnormal: target === STATUS_REMEASURE,
    version: rowVersion(row!) + 1,
  }
  if (target === STATUS_REMEASURE && operator) {
    updated['校核人'] = operator
  }
  const nextRows = rows.map((item) => (Number(item.id) === id ? updated : item))

  // 单条「安排重测」同样要在另一个业务面——考古调查的现场复测清单里落一条任务。
  const patch: Record<string, EntryRow[]> = { [COORDINATE_KEY]: nextRows }
  if (target === STATUS_REMEASURE) {
    const surveyRows = store[SURVEY_KEY] ?? []
    patch[SURVEY_KEY] = [
      ...surveyRows,
      buildRemeasureEntry(surveyRows, {
        unit,
        points: [rowCode(row!)],
        deviations: ['单条安排重测，待现场复测'],
        operator: operator || '值班管理员',
      }),
    ]
  }
  commitRows(patch)
  const suffix = target === STATUS_REMEASURE ? '，现场复测清单已新增 1 条复测任务' : ''
  return { ok: true, message: `测点 ${rowCode(row!)}已${action}，当前状态「${target}」${suffix}` }
}

/**
 * 三维坐标批量校核（原子事务）。
 *
 * 修复要点：
 * 1. 每条测点按 id 独立携带校核人与复核高程，按 id 回写，不再出现「后一行的校核人/高程写到前一行」；
 * 2. 先把全部测点校验一遍（归档、跨单位、缺失、版本冲突），任何一条不过都整批退回、绝不只保存成功部分；
 * 3. 超差测点判「需重测」，并向考古调查模块的现场复测清单原子回写一条复测任务；
 * 4. expectedVersion 与库里最新版本不一致，说明该测点已被另一终端先落库，本批整体冲突退回。
 */
export function batchVerifyCoordinates(
  items: CoordinateVerifyItem[],
  context: ActionContext = {},
): BatchVerifyResult {
  const unit = context.unit ?? ''
  const operator = context.operator ?? '值班管理员'

  if (items.length === 0) {
    return { ok: false, message: '请先勾选需要校核的测点', passed: [], retested: [], conflicts: [] }
  }

  const store = freshRows()
  const rows = store[COORDINATE_KEY] ?? []
  const byId = new Map(rows.map((row) => [Number(row.id), row]))

  // 同一测点在一批里重复勾选，按重复提交处理，整批退回。
  const submittedIds = new Set<number>()
  for (const item of items) {
    if (submittedIds.has(item.id)) {
      return {
        ok: false,
        message: `测点 ${item.id} 在本批中重复提交，整批退回，未保存任何记录`,
        passed: [],
        retested: [],
        conflicts: [],
      }
    }
    submittedIds.add(item.id)
  }

  // 第一关：逐条独立校验权限与录入完整性。任何一条失败都直接返回，此阶段不产生任何写入。
  for (const item of items) {
    const row = byId.get(item.id)
    const blocked = guardCoordinateRow(row, item.id, unit)
    if (blocked) {
      return {
        ok: false,
        message: `${blocked}；整批退回，未保存任何记录`,
        passed: [],
        retested: [],
        conflicts: [],
      }
    }
    if (!item.checker.trim()) {
      return {
        ok: false,
        message: `测点 ${rowCode(row!)} 未填写校核人；整批退回，未保存任何记录`,
        passed: [],
        retested: [],
        conflicts: [],
      }
    }
    if (item.checkedElevation === null || !Number.isFinite(item.checkedElevation)) {
      return {
        ok: false,
        message: `测点 ${rowCode(row!)} 的复核高程缺失或不是数字；整批退回，未保存任何记录`,
        passed: [],
        retested: [],
        conflicts: [],
      }
    }
    if (parseElevation(row!['高程值']) === null) {
      return {
        ok: false,
        message: `测点 ${rowCode(row!)} 的登记高程缺失或不是数字，无法校核；整批退回，未保存任何记录`,
        passed: [],
        retested: [],
        conflicts: [],
      }
    }
  }

  // 第二关：乐观锁，必须先于「已校核」状态判断——后到终端看到的状态差异本身就是对方先落库造成的。
  // 以库里最新版本为准，任何一条被别的终端抢先改过，后到者整批收到冲突结果，且同一测点不再产生第二版本。
  const conflicts = items
    .filter((item) => rowVersion(byId.get(item.id)!) !== item.expectedVersion)
    .map((item) => ({
      id: item.id,
      code: rowCode(byId.get(item.id)!),
      currentVersion: rowVersion(byId.get(item.id)!),
    }))
  if (conflicts.length > 0) {
    return {
      ok: false,
      message: `测点 ${conflicts
        .map((c) => c.code)
        .join('、')} 已被其他终端先校核落库（版本冲突），本批整批退回，未保存任何记录；请刷新列表后以最新版本重新勾选`,
      passed: [],
      retested: [],
      conflicts,
    }
  }

  // 第三关：版本一致才谈状态。能走到这里说明没有别的终端插手，已校核即本端重复提交，照常整批退回。
  for (const item of items) {
    const row = byId.get(item.id)!
    if (String(row.status) === STATUS_VERIFIED) {
      return {
        ok: false,
        message: `测点 ${rowCode(row)} 已校核，不能重复提交；整批退回，未保存任何记录`,
        passed: [],
        retested: [],
        conflicts: [],
      }
    }
  }

  // 全部通过后才在内存里生成新数据集，逐条按 id 回写，互不串位。
  const passed: string[] = []
  const retested: string[] = []
  const deviations: string[] = []
  const nextRows = rows.map((row) => {
    const item = items.find((candidate) => candidate.id === Number(row.id))
    if (!item) {
      return row
    }
    const registered = parseElevation(row['高程值']) as number
    // 前置校验已保证复核高程是有限数字；这里显式取值，避免闭包里丢失类型收窄。
    const checkedElevation = item.checkedElevation as number
    const diff = Math.abs(checkedElevation - registered)
    const fail = diff > ELEVATION_TOLERANCE
    const status = fail ? STATUS_REMEASURE : STATUS_VERIFIED
    if (fail) {
      retested.push(rowCode(row))
      deviations.push(`${rowCode(row)} 较差 ${diff.toFixed(3)}m`)
    } else {
      passed.push(rowCode(row))
    }
    const updated: EntryRow = {
      ...row,
      status,
      pending: fail,
      abnormal: fail,
      version: rowVersion(row) + 1,
      校核高程: checkedElevation,
      校核人: item.checker.trim(),
      记录状态: status,
    }
    return updated
  })

  // 重测记录与坐标结果在同一次原子提交里落库，保证结果页与保存值对得上。
  const patch: Record<string, EntryRow[]> = { [COORDINATE_KEY]: nextRows }
  if (retested.length > 0) {
    const surveyRows = store[SURVEY_KEY] ?? []
    patch[SURVEY_KEY] = [
      ...surveyRows,
      buildRemeasureEntry(surveyRows, {
        unit,
        points: retested,
        deviations,
        operator,
      }),
    ]
  }
  commitRows(patch)

  const tail =
    retested.length > 0
      ? `，已向考古调查现场复测清单新增 1 条复测任务（含 ${retested.length} 个测点）`
      : ''
  return {
    ok: true,
    message: `批量校核整批落库成功：校核通过 ${passed.length} 条，需重测 ${retested.length} 条${tail}`,
    passed,
    retested,
    conflicts: [],
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
