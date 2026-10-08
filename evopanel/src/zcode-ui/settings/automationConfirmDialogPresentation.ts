/** Automation 仅固定共享 ConfirmDialog 的外层尺寸，内部样式继续由共享组件维护。 */
export const AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS =
  "min-h-[180px] w-[min(448px,calc(100vw-2rem))] max-w-none";

// 合并原因：远端补充了长文案保护，但不应连带覆盖本地已确认的弹窗内部视觉样式。
export const AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS =
  "line-clamp-3 break-words whitespace-pre-line";
