const STORAGE_KEY = 'evopanel_chat_layout_v1'

export type ChatLayoutPrefs = {
  /** 右侧面板宽度（px）；null 表示使用各面板默认值 */
  rightPanelWidthPx: number | null
  /** 底部输入区高度（px）；null 表示随内容自适应 */
  bottomDockHeightPx: number | null
}

export const DEFAULT_CHAT_LAYOUT: ChatLayoutPrefs = {
  rightPanelWidthPx: null,
  bottomDockHeightPx: null,
}

export function loadChatLayoutPrefs(): ChatLayoutPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CHAT_LAYOUT }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CHAT_LAYOUT }
    const parsed = JSON.parse(raw) as Partial<ChatLayoutPrefs>
    return {
      rightPanelWidthPx:
        typeof parsed.rightPanelWidthPx === 'number' && Number.isFinite(parsed.rightPanelWidthPx)
          ? parsed.rightPanelWidthPx
          : null,
      bottomDockHeightPx:
        typeof parsed.bottomDockHeightPx === 'number' && Number.isFinite(parsed.bottomDockHeightPx)
          ? parsed.bottomDockHeightPx
          : null,
    }
  } catch {
    return { ...DEFAULT_CHAT_LAYOUT }
  }
}

export function saveChatLayoutPrefs(prefs: ChatLayoutPrefs) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

export type RightPanelLayoutKind = 'half' | 'wide' | 'narrow' | 'workspace-browse' | 'workspace-write'

export {
  defaultRightPanelWidth,
  clampRightPanelWidth,
  rightStageLayoutToPanelKind,
} from './right-stage/right-stage-layout.js'

export function clampBottomDockHeight(
  height: number,
  viewportHeight: number,
  containerHeight?: number,
): number {
  const min = 100
  const viewportCap = Math.max(min, Math.round(viewportHeight * 0.5))
  // 给消息区至少留约 35% 主列高度，避免输入区上拉后把回复「盖住」
  const col = Number(containerHeight) || 0
  const containerCap =
    col > min ? Math.max(min, Math.round(col * 0.55)) : viewportCap
  const max = Math.min(viewportCap, containerCap)
  return Math.min(max, Math.max(min, Math.round(height)))
}

/** 根据当前高度与拖拽增量计算下一高度；缩到接近自然高度时回到自适应 */
export function applyBottomAreaHeightDelta(
  currentHeight: number,
  delta: number,
  naturalHeight: number,
  viewportHeight: number,
  containerHeight?: number,
): number | null {
  const next = currentHeight - delta
  if (next <= naturalHeight + 4) return null
  return clampBottomDockHeight(next, viewportHeight, containerHeight)
}

/** 临时解除固定高度，测量输入区内容真实高度 */
export function measureBottomAreaNaturalHeight(el: HTMLElement): number {
  const prevHeight = el.style.height
  const prevMinHeight = el.style.minHeight
  const prevMaxHeight = el.style.maxHeight
  el.style.height = 'auto'
  el.style.minHeight = '0'
  el.style.maxHeight = 'none'
  const measured = Math.ceil(el.getBoundingClientRect().height)
  el.style.height = prevHeight
  el.style.minHeight = prevMinHeight
  el.style.maxHeight = prevMaxHeight
  return Math.max(100, measured)
}
