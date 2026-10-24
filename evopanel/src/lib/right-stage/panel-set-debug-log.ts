/**
 * panel_set → 右栏排查日志（中文）。
 * 控制台过滤：`右栏·panel_set`
 * 排查完可删本文件及各处 logPanelSet 调用。
 */
const TAG = '[右栏·panel_set]'

export function logPanelSet(step: string, detail?: Record<string, unknown>): void {
  try {
    if (detail && Object.keys(detail).length) {
      console.log(TAG, step, detail)
    } else {
      console.log(TAG, step)
    }
  } catch {
    /* ignore */
  }
}
