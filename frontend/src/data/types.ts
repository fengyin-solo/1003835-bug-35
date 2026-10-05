/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /**
   * 乐观锁版本号：每条记录第一次校核入库时为 1，之后每被修改一次加 1。
   * 批量校核提交时必须带着列表上看到的版本，库里版本对不上就说明已被别的终端改过，整批退回。
   */
  version?: number
  [field: string]: string | number | boolean | null | undefined
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

/** 批量校核时，每个测点单独携带的校核数据——按测点 id 归集，绝不允许按表格行号错位回写。 */
export type CoordinateVerifyItem = {
  /** 测点记录主键 */
  id: number
  /** 打开校核面板时列表上该测点的版本，作为乐观锁的预期版本 */
  expectedVersion: number
  /** 本条测点的校核人，每条记录独立填写 */
  checker: string
  /** 本条测点独立复测得到的高程（与登记高程比对，超差判重测） */
  checkedElevation: number | null
}

/** 批量校核里因为被其他终端抢先改落库而冲突的测点，后到者据此收到冲突结果。 */
export type CoordinateVerifyConflict = {
  id: number
  code: string
  currentVersion: number
}

export type BatchVerifyResult = {
  ok: boolean
  message: string
  /** 校核通过（状态置为已校核）的测点编号 */
  passed: string[]
  /** 高程超差、判定需重测的测点编号 */
  retested: string[]
  /** 与其他终端冲突、本批未落库的测点 */
  conflicts: CoordinateVerifyConflict[]
}
