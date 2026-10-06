/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 批量校核时，每个测点一份独立草稿；以测点业务 id 为键，绝不使用列表行下标，避免串位。 */
export type CheckDraft = {
  coordinateId: number
  校核人: string
  校核高程: string
  结论: '通过' | '重测'
  重测原因: string
  /** 打开批量校核面板时读到的版本号，作为乐观锁基线。 */
  baseVersion: number
}

export type CheckFailure = {
  coordinateId: number
  测点编号: string
  reason: string
  /** 版本冲突标记：说明该测点已被另一个终端先落库。 */
  conflict?: boolean
}

export type BatchCheckResult = {
  ok: boolean
  message: string
  checkedCount?: number
  retestCount?: number
  failures?: CheckFailure[]
}
