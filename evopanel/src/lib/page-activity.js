/**
 * 兼容层：页面行为总线已并入 ui-focus（留痕 + 当前焦点）。
 * 旧 import 路径继续可用。
 */
export {
  emitPageActivity,
  getRecentPageActivities,
  emitUiActivity,
  getRecentUiActivities,
  getUiFocusSnapshot,
  ensureUiFocusClickCapture,
  noteRouteFocus,
  UI_FOCUS_EVENT,
  UI_ACTIVITY_EVENT,
} from './ui-focus.js'

/** @deprecated 与 UI_ACTIVITY_EVENT 同值 */
export const PAGE_ACTIVITY_EVENT = 'evoflow:page-activity'
