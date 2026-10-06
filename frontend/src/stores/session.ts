import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    // 当前终端登录人所属发掘单位：只有该单位的测点可校核，其他单位测点只读。
    unit: 'T0101',
    shiftLabel: '白班 08:00-20:00',
    scope: '田野考古发掘数字化管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setUnit(unit: string) {
      this.unit = unit
    },
  },
})
