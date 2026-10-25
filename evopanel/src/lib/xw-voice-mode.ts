/**
 * 小V 语音全屏模式（全局接管布局）：
 * 开启后 html[data-xw-voice='1'] —— 左侧小V语音域 + 右侧 right-stage 标签区两栏铺满整窗，
 * 正常聊天 chrome（会话列表/顶栏/对话列/输入区）由 CSS 隐藏，退出即还原。
 * 状态不放 React：任何模块（面板按钮/语音舞台）都可同步读写。
 */
import { notifyLayoutChromeChanged } from './layout-chrome.js'
import { rightStageStore } from './right-stage/right-stage-store.js'

export const XW_VOICE_MODE_EVENT = 'xw-voice-mode-change'

export function isXwVoiceMode(): boolean {
  try {
    return document.documentElement.dataset.xwVoice === '1'
  } catch {
    return false
  }
}

export function subscribeXwVoiceMode(fn: (on: boolean) => void): () => void {
  const handler = (ev: Event) => fn(Boolean((ev as CustomEvent<{ on?: boolean }>).detail?.on))
  window.addEventListener(XW_VOICE_MODE_EVENT, handler)
  return () => window.removeEventListener(XW_VOICE_MODE_EVENT, handler)
}

function apply(on: boolean) {
  if (on) document.documentElement.dataset.xwVoice = '1'
  else delete document.documentElement.dataset.xwVoice
  window.dispatchEvent(new CustomEvent(XW_VOICE_MODE_EVENT, { detail: { on } }))
  // 右栏槽位四角大变：通知内嵌浏览器立刻 rebind（不能等 ResizeObserver 晚一拍）
  notifyLayoutChromeChanged(on ? 'xw-voice-enter' : 'xw-voice-exit')
}

/** 进入语音全屏模式：右栏标签区升为主体（必须展开；若停在小V标签则切到别的标签，避免右侧重复显示小V）。 */
export function enterXwVoiceMode(): void {
  if (isXwVoiceMode()) return
  rightStageStore.expand()
  const snap = rightStageStore.getSnapshot()
  if (String(snap.activeKey || '').startsWith('xiaomi:')) {
    const other = snap.tabs.find((t) => t.kind !== 'xiaomi')
    if (other) rightStageStore.activateTab(`${other.kind}:${other.id}`)
  }
  apply(true)
}

/** 退出语音全屏模式，还原正常聊天布局。 */
export function exitXwVoiceMode(): void {
  if (!isXwVoiceMode()) return
  apply(false)
}
