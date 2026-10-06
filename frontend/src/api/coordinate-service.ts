import { commitState, listRows } from '@/data/local-store'
import type {
  BatchCheckResult,
  CheckDraft,
  CheckFailure,
  EntryRow,
} from '@/data/types'

const COORDINATE_KEY = 'coordinate'
const RETRIAL_KEY = 'retrials'
const SURVEY_KEY = 'survey'

const ARCHIVED_STATUS = '已归档'
const RETEST_STATUS = '需重测'
const CHECKED_STATUS = '已校核'

export type CoordinateRow = EntryRow

/** 列表读取：结果页始终以存储层当前值为准，校核提交后重新读取，不沿用页面草稿。 */
export function listCoordinates(): CoordinateRow[] {
  return listRows(COORDINATE_KEY)
}

export function getCoordinate(id: number): CoordinateRow | undefined {
  return listCoordinates().find((row) => Number(row.id) === id)
}

/** 重测记录按测点业务编号关联读取，与列表行序号彻底解耦，行序再变也不会串位。 */
export function listRetrials(coordinateCode?: string): EntryRow[] {
  const rows = listRows(RETRIAL_KEY)
  if (!coordinateCode) {
    return rows
  }
  return rows.filter((row) => String(row['关联测点']) === coordinateCode)
}

function isArchived(row: EntryRow): boolean {
  return String(row.status) === ARCHIVED_STATUS
}

/** 跨单位测点只读：所属单位与当前登录单位不一致即不可校核。 */
export function canCheck(row: EntryRow, unit: string): boolean {
  return !isArchived(row) && String(row['所属单位']) === unit
}

function isSameUnit(row: EntryRow, unit: string): boolean {
  return String(row['所属单位']) === unit
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 一个测点被判重测时，同步在另一个业务面（考古调查）生成/更新一条「现场复测」清单。 */
function upsertFieldRetest(
  surveyRows: EntryRow[],
  row: EntryRow,
  reason: string,
  operator: string,
): void {
  const code = String(row['测点编号'])
  const surveyNo = `RC-${code}`
  const existing = surveyRows.find((item) => String(item['调查编号']) === surveyNo)
  const values = {
    调查编号: surveyNo,
    调查区域: `${String(row['所属单位'])} 测点 ${code}`,
    调查方法: '现场复测',
    地表发现: `现场复测清单：测点 ${code} 校核未通过，${reason}`,
    断面观察: '待现场复测',
    初步断代: '待复核',
    调查人: operator,
    记录状态: '需复查',
  }
  if (existing) {
    Object.assign(existing, values, { status: '需复查', pending: true, abnormal: true })
  } else {
    surveyRows.push({
      id: nextId(surveyRows),
      status: '需复查',
      pending: true,
      abnormal: true,
      ...values,
    })
  }
}

/** 重测记录同样按测点业务编号幂等更新，不依赖任何行下标。 */
function upsertRetrial(
  retrialRows: EntryRow[],
  row: EntryRow,
  reason: string,
  operator: string,
): void {
  const code = String(row['测点编号'])
  const existing = retrialRows.find((item) => String(item['关联测点']) === code)
  const values = {
    关联测点: code,
    重测原因: reason,
    登记人: operator,
    登记日期: today(),
    记录状态: '待复测',
  }
  if (existing) {
    Object.assign(existing, values, { status: '待复测', pending: true, abnormal: true })
  } else {
    retrialRows.push({
      id: nextId(retrialRows),
      status: '待复测',
      pending: true,
      abnormal: true,
      ...values,
    })
  }
}

/**
 * 批量校核：整批要么全部落库，要么全部退回。
 *
 * 两阶段处理，彻底修掉「逐条保存、失败只丢后半批」：
 * 1. 校验阶段：不写任何数据，逐条独立校验单位、归档态、字段完整性、乐观锁版本；
 * 2. 提交阶段：只有零失败才进入 commitState，坐标/重测记录/调查清单在同一次存储写入里落库。
 *
 * @param drafts 每条测点一份草稿，键为测点 id（不是行下标），从根上杜绝校核人/高程串行。
 * @param context 当前终端的操作人与所属单位。
 */
export function batchCheckCoordinates(
  drafts: CheckDraft[],
  context: { operator: string; unit: string },
): BatchCheckResult {
  if (drafts.length === 0) {
    return { ok: false, message: '未选择任何测点，无法校核' }
  }

  const coordinates = listCoordinates()
  const failures: CheckFailure[] = []
  let checkedCount = 0
  let retestCount = 0

  // 第一阶段：逐条独立校验，任何一条不过都记录失败，绝不提前写库。
  for (const draft of drafts) {
    const row = coordinates.find((item) => Number(item.id) === draft.coordinateId)
    const code = row ? String(row['测点编号']) : `#${draft.coordinateId}`
    const fail = (reason: string, conflict = false): void => {
      failures.push({ coordinateId: draft.coordinateId, 测点编号: code, reason, conflict })
    }

    if (!row) {
      fail('测点记录不存在或已被删除')
      continue
    }
    // 历史已归档坐标：只读，任何校核/重测写操作都不允许。
    if (isArchived(row)) {
      fail('测点已归档，历史坐标不允许修改')
      continue
    }
    // 跨单位测点只能查看。
    if (!isSameUnit(row, context.unit)) {
      fail(`测点属于 ${String(row['所属单位'])}，非本单位（${context.unit}）测点只能查看`)
      continue
    }

    if (!draft.校核人.trim()) {
      fail('校核人为必填，每个测点必须独立填写')
      continue
    }

    if (draft.结论 === '通过') {
      const elevation = Number(draft.校核高程)
      if (!draft.校核高程.trim() || Number.isNaN(elevation)) {
        fail('校核结论为通过时，必须填写本测点独立的校核高程')
        continue
      }
      // 高程容差：较差超过 0.1m 直接判定本测点数据异常，不允许通过。
      const measured = Number(row['高程值'])
      if (!Number.isNaN(measured) && Math.abs(elevation - measured) > 0.1) {
        fail(
          `校核高程 ${elevation.toFixed(3)}m 与测量值 ${measured.toFixed(3)}m 较差超限，应判重测`,
        )
        continue
      }
    } else if (!draft.重测原因.trim()) {
      fail('校核结论为重测时，必须填写重测原因')
      continue
    }

    // 乐观锁：基线版本与库内版本不一致，说明该测点已被另一个终端先落库。
    if (Number(row['version'] ?? 1) !== draft.baseVersion) {
      fail(
        `测点已被另一终端校核（版本 v${draft.baseVersion} → v${Number(row['version'] ?? 1)}），本终端为后到版本，整批已退回`,
        true,
      )
      continue
    }

    if (draft.结论 === '通过') {
      checkedCount += 1
    } else {
      retestCount += 1
    }
  }

  // 任一记录失败：整批退回，不保存任何成功部分（第一阶段本来就没写库）。
  if (failures.length > 0) {
    const conflictCount = failures.filter((item) => item.conflict).length
    const summary =
      conflictCount > 0
        ? `存在 ${conflictCount} 个测点与另一终端校核结果冲突（同一测点只允许一个版本落库）`
        : `有 ${failures.length} 条测点校核未通过`
    return {
      ok: false,
      message: `整批校核已退回：${summary}；共 ${drafts.length} 条，未落库任何一条`,
      failures,
    }
  }

  // 第二阶段：全部独立校验通过，三张表在同一次原子写入里提交。
  commitState((state) => {
    const coordRows = state[COORDINATE_KEY] ?? []
    const retrialRows = state[RETRIAL_KEY] ?? []
    const surveyRows = state[SURVEY_KEY] ?? []

    for (const draft of drafts) {
      const index = coordRows.findIndex((item) => Number(item.id) === draft.coordinateId)
      const row = coordRows[index]
      if (draft.结论 === '通过') {
        coordRows[index] = {
          ...row,
          status: CHECKED_STATUS,
          pending: false,
          abnormal: false,
          校核人: draft.校核人.trim(),
          校核高程: Number(Number(draft.校核高程).toFixed(3)),
          记录状态: CHECKED_STATUS,
          version: Number(row['version'] ?? 1) + 1,
        }
      } else {
        const reason = draft.重测原因.trim()
        coordRows[index] = {
          ...row,
          status: RETEST_STATUS,
          pending: true,
          abnormal: true,
          校核人: '',
          校核高程: '',
          记录状态: RETEST_STATUS,
          version: Number(row['version'] ?? 1) + 1,
        }
        // 重测记录与现场复测清单都挂在测点业务编号上，随整批一起提交。
        upsertRetrial(retrialRows, row, reason, context.operator)
        upsertFieldRetest(surveyRows, row, reason, context.operator)
      }
    }

    state[COORDINATE_KEY] = coordRows
    state[RETRIAL_KEY] = retrialRows
    state[SURVEY_KEY] = surveyRows
  })

  return {
    ok: true,
    message: `本批 ${drafts.length} 条测点已全部独立校核并落库（通过 ${checkedCount} 条，重测 ${retestCount} 条）`,
    checkedCount,
    retestCount,
  }
}

/** 单条安排重测（行内动作）：同样受单位/归档保护，并回写两张关联表。 */
export function arrangeRetest(
  coordinateId: number,
  reason: string,
  context: { operator: string; unit: string },
): BatchCheckResult {
  const row = getCoordinate(coordinateId)
  if (!row) {
    return { ok: false, message: '没有找到该测点记录' }
  }
  if (isArchived(row)) {
    return { ok: false, message: '测点已归档，历史坐标不允许修改' }
  }
  if (!isSameUnit(row, context.unit)) {
    return { ok: false, message: '跨单位测点只能查看，不能安排重测' }
  }
  if (!reason.trim()) {
    return { ok: false, message: '必须填写重测原因' }
  }

  commitState((state) => {
    const coordRows = state[COORDINATE_KEY] ?? []
    const index = coordRows.findIndex((item) => Number(item.id) === coordinateId)
    const current = coordRows[index]
    coordRows[index] = {
      ...current,
      status: RETEST_STATUS,
      pending: true,
      abnormal: true,
      校核人: '',
      校核高程: '',
      记录状态: RETEST_STATUS,
      version: Number(current['version'] ?? 1) + 1,
    }
    const retrialRows = state[RETRIAL_KEY] ?? []
    upsertRetrial(retrialRows, current, reason.trim(), context.operator)
    state[RETRIAL_KEY] = retrialRows
    const surveyRows = state[SURVEY_KEY] ?? []
    upsertFieldRetest(surveyRows, current, reason.trim(), context.operator)
    state[SURVEY_KEY] = surveyRows
  })

  return { ok: true, message: `测点 ${String(row['测点编号'])} 已安排重测，现场复测清单已同步增加一条` }
}

/**
 * 模拟「另一终端」抢先校核：把指定测点的库内版本号 +1。
 * 本终端持有的基线版本随即过期，提交时命中乐观锁冲突，整批退回并收到冲突结果。
 */
export function simulateConcurrentUpdate(coordinateIds: number[], unit: string): number {
  let bumped = 0
  commitState((state) => {
    const coordRows = state[COORDINATE_KEY] ?? []
    for (const id of coordinateIds) {
      const index = coordRows.findIndex((item) => Number(item.id) === id)
      if (index < 0) {
        continue
      }
      const row = coordRows[index]
      // 另一终端同样改不了跨单位/已归档测点。
      if (isArchived(row) || !isSameUnit(row, unit)) {
        continue
      }
      coordRows[index] = { ...row, version: Number(row['version'] ?? 1) + 1 }
      bumped += 1
    }
    state[COORDINATE_KEY] = coordRows
  })
  return bumped
}
