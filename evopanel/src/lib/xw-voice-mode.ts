/**
 * 小V 语音全屏模式（全局接管布局）：
 * 开启后 html[data-xw-voice='1'] —— 左侧小V语音域 + 右侧 right-stage 标签区两栏铺满整窗，
 * 正常聊天 chrome（会话列表/顶栏/对话列/输入区）由 CSS 隐藏，退出即还原。
 * 状态不放 React：任何模块（面板按钮/语音舞台）都可同步读写。
 *
 * 进入时带 data-xw-voice-anim=enter：从右缘小弧（对齐边缘「小V」标签）展开，
 * 动画结束后再 notify 布局（避免 HWND 中途跳动）。
 */
import { notifyLayoutChromeChanged } from './layout-chrome.js'
import { rightStageStore } from './right-stage/right-stage-store.js'

export const XW_VOICE_MODE_EVENT = 'xw-voice-mode-change'

/** 与 CSS @keyframes xw-arc-expand 时长对齐 */
const ENTER_ANIM_MS = 480

let enterAnimTimer = 0

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

function clearEnterAnimTimer() {
  if (enterAnimTimer) {
    window.clearTimeout(enterAnimTimer)
    enterAnimTimer = 0
  }
}

function apply(on: boolean) {
  const root = document.documentElement
  clearEnterAnimTimer()

  if (on) {
    root.dataset.xwVoice = '1'
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    if (reduceMotion) {
      delete root.dataset.xwVoiceAnim
      window.dispatchEvent(new CustomEvent(XW_VOICE_MODE_EVENT, { detail: { on: true } }))
      notifyLayoutChromeChanged('xw-voice-enter')
      return
    }
    root.dataset.xwVoiceAnim = 'enter'
    window.dispatchEvent(new CustomEvent(XW_VOICE_MODE_EVENT, { detail: { on: true } }))
    // 展开动画结束后再通知内嵌浏览器 rebind，避免半动画时 HWND 乱跳
    enterAnimTimer = window.setTimeout(() => {
      enterAnimTimer = 0
      if (root.dataset.xwVoice !== '1') return
      delete root.dataset.xwVoiceAnim
      notifyLayoutChromeChanged('xw-voice-enter')
    }, ENTER_ANIM_MS)
    return
  }

  delete root.dataset.xwVoice
  delete root.dataset.xwVoiceAnim
  window.dispatchEvent(new CustomEvent(XW_VOICE_MODE_EVENT, { detail: { on: false } }))
  notifyLayoutChromeChanged('xw-voice-exit')
}

export type EnterXwVoiceModeOpts = {
  /**
   * 是否展开右侧 right-stage（默认 true）。
   * 唤醒后以左侧语音域对话为主时传 false，避免右侧文字流面板干扰。
   */
  expandRightStage?: boolean
}

/** 进入语音全屏模式：左栏小V语音域；可选展开右栏（若停在小V标签则切到别的标签，避免右侧重复显示小V）。 */
export function enterXwVoiceMode(opts: EnterXwVoiceModeOpts = {}): void {
  if (isXwVoiceMode()) return
  const expandRight = opts.expandRightStage !== false
  if (expandRight) {
    rightStageStore.expand()
    const snap = rightStageStore.getSnapshot()
    if (String(snap.activeKey || '').startsWith('xiaomi:')) {
      const other = snap.tabs.find((t) => t.kind !== 'xiaomi')
      if (other) rightStageStore.activateTab(`${other.kind}:${other.id}`)
    }
  }
  apply(true)
  // 默认开语音播报 + prefer 小V（火山 TTS 已配即可听会说）
  void import('./xiaomi-voice-defaults.js')
    .then((m) => m.ensureXiaomiVoiceReplyOn())
    .catch(() => {})
}

/** 退出语音全屏模式，还原正常聊天布局，并停掉整套语音（Frame / continuous / ASR）。 */
export function exitXwVoiceMode(): void {
  if (!isXwVoiceMode()) return
  apply(false)
  // 必须停干净：否则面板关了 continuous 仍识别并灌「输入框」（见前端日志 source=输入框）
  void import('./background-voice.js')
    .then((m) => m.shutdownXiaomiVoiceRuntime?.())
    .catch(() => {})
}
