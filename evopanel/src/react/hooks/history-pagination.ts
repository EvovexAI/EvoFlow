/**
 * 未超过此行数：普通文档流渲染历史（浏览器原生滚动，稳定、无估高空白）。
 * 超过后启用虚拟列表，降低长会话 DOM 节点数。
 * 30 -> 15：长对话大消息 DOM 常驻是「整个窗口卡」的主因之一，
 * 提前切换虚拟化，把常驻 DOM 控制在可视区 + overscan 范围内。
 */
export const HISTORY_FLAT_LIST_MAX_ROWS = 15

/** 距顶部小于此缓冲（px）时预取更早一页，避免滚到顶才加载。 */
export const HISTORY_LOAD_OLDER_TOP_BUFFER_MIN_PX = 320
export const HISTORY_LOAD_OLDER_TOP_BUFFER_MAX_PX = 720

/** WeChat-style prefetch buffer: ~1 viewport height from top, clamped. */
export function historyLoadOlderScrollBufferPx(viewportHeight: number): number {
  const vh = Math.max(1, Math.floor(Number(viewportHeight) || 0))
  return Math.max(
    HISTORY_LOAD_OLDER_TOP_BUFFER_MIN_PX,
    Math.min(HISTORY_LOAD_OLDER_TOP_BUFFER_MAX_PX, Math.floor(vh * 1.0)),
  )
}

export function shouldPrefetchOlderHistory(scroller: HTMLElement): boolean {
  return scroller.scrollTop < historyLoadOlderScrollBufferPx(scroller.clientHeight)
}
