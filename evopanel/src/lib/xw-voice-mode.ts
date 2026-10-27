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

/**
 * 语音全屏下是否允许浮出状态卡（智能体/进程/产物/平台/调试）。
 * 默认关：刚进语音域时这张卡叠在球上很难看；平台工具落地后再 allow。
 */
export function isXwVoiceSummaryAllowed(): boolean {
  try {
    return document.documentElement.dataset.xwVoiceSummary === '1'
  } catch {
    return false
  }
}

/** 平台工具有结果后调用：允许状态卡在语音全屏里出现。 */
export function allowXwVoiceSummary(): void {
  try {
    if (!isXwVoiceMode()) return
    document.documentElement.dataset.xwVoiceSummary = '1'
  } catch {
    /* ignore */
  }
}

export function clearXwVoiceSummary(): void {
  try {
    delete document.documentElement.dataset.xwVoiceSummary
  } catch {
    /* ignore */
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
    // 进语音域先藏状态卡；等平台工具再 allowXwVoiceSummary
    delete root.dataset.xwVoiceSummary
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
  delete root.dataset.xwVoiceSummary
  window.dispatchEvent(new CustomEvent(XW_VOICE_MODE_EVENT, { detail: { on: false } }))
  // 立刻通知一次（MutationObserver / 早监听）；再补 settle，等 flex 收成普通分栏后再贴 HWND。
  notifyLayoutChromeChanged('xw-voice-exit')
  void import('./xw-voice-embed-settle.js')
    .then((m) => m.afterXwVoiceExitSettle?.())
    .catch(() => {})
}

export type EnterXwVoiceModeOpts = {
  /**
   * 是否展开右侧 right-stage（默认 true）。
   * 唤醒后以左侧语音域对话为主时传 false，避免右侧文字流面板干扰。
   */
  expandRightStage?: boolean
}

function noteGate(
  phase: 'enter' | 'closing' | 'exited',
  opts: { reason?: string; source?: string; message?: string; force?: boolean } = {},
) {
  void import('./xiaomi-voice/voice-file-log.js')
    .then((m) => m.noteVoiceModeGate?.(phase, opts))
    .catch(() => {})
}

function afterXiaomiSessionAdopted(expandRight: boolean): void {
  const snap = rightStageStore.getSnapshot()
  // adopt 已不带主对话 workspace 签；此处只认小V 自己会话里的非 xiaomi 签
  // （平台工具在语音域内新开的员工/任务），勿把主对话残留当成「该展开」。
  const sideContent = snap.tabs.find((t) => String(t.kind || '') !== 'xiaomi')
  if (expandRight) {
    rightStageStore.expand()
    // 左栏已是小V语音域：右栏若还停在小V文字签，切到同会话其它签（截图/文件/壳页）。
    if (String(snap.activeKey || '').startsWith('xiaomi:') && sideContent) {
      rightStageStore.activateTab(`${sideContent.kind}:${sideContent.id}`)
    }
  } else if (sideContent) {
    // 唤醒 left-only 期间：仅当「本轮语音会话」里已有平台开签才展开；
    // 主对话缓存签不应再出现在这里（adopt carryWorkspace:false）。
    rightStageStore.expand()
    rightStageStore.activateTab(`${sideContent.kind}:${sideContent.id}`)
  } else {
    // 唤醒 left-only：必须收起右侧。否则对话列被 CSS 藏掉、语音域只剩左栏 440px，
    // 整窗几乎空白，用户会以为「面板没弹出来」。
    // 只用 store.collapse()，勿走 collapseRightStageShell（那条会 exit 语音模式）。
    rightStageStore.collapse()
  }
}

/** 进入语音全屏模式：左栏小V语音域；可选展开右栏（若停在小V标签则切到别的标签，避免右侧重复显示小V）。 */
export function enterXwVoiceMode(opts: EnterXwVoiceModeOpts = {}): void {
  const expandRight = opts.expandRightStage !== false
  // 先占用小V 右栏会话表，再展开——避免主对话的浏览器/截图签留在右侧。
  void import('./right-stage/xiaomi-right-stage-session.js')
    .then(async (m) => {
      await m.adoptXiaomiRightStageSession()
      afterXiaomiSessionAdopted(expandRight)
    })
    .catch(() => {
      afterXiaomiSessionAdopted(expandRight)
    })
  if (isXwVoiceMode()) {
    // 再进语音（唤醒）：仍先藏状态卡，等本轮平台工具再放行
    clearXwVoiceSummary()
    // 已在语音态仍要通知 React：可能 DOM 已标 data-xw-voice，但 ChatApp 当时未挂载漏听了事件。
    window.dispatchEvent(new CustomEvent(XW_VOICE_MODE_EVENT, { detail: { on: true } }))
    notifyLayoutChromeChanged('xw-voice-reenter')
    noteGate('enter', {
      source: 'enterXwVoiceMode',
      reason: expandRight ? 'reenter' : 'reenter-left-only',
    })
    return
  }
  apply(true)
  noteGate('enter', {
    source: 'enterXwVoiceMode',
    reason: expandRight ? 'enter' : 'enter-left-only',
  })
  // 默认开语音播报 + prefer 小V（火山 TTS 已配即可听会说）
  void import('./xiaomi-voice-defaults.js')
    .then((m) => m.ensureXiaomiVoiceReplyOn())
    .catch(() => {})
}

/**
 * 退出语音全屏模式，还原正常聊天布局，并停掉整套语音（Frame / continuous / ASR）。
 * 关闭语音对话区 ≡ 退出这套体系；日志会写「关闭退出」→「已经退出」。
 */
function releaseXiaomiRightStageOnVoiceExit(): void {
  void import('./right-stage/xiaomi-right-stage-session.js')
    .then((m) => m.releaseXiaomiRightStageSession?.())
    .catch(() => {})
  void import('../zcode-ui/v4/xiaomiVoiceReadAutoOpen.js')
    .then((m) => m.resetXiaomiVoiceReadAutoOpen?.())
    .catch(() => {})
  void import('./xiaomi-voice/platform-auto-open.js')
    .then((m) => m.resetXiaomiPlatformAutoOpen?.())
    .catch(() => {})
}

export function exitXwVoiceMode(): void {
  if (!isXwVoiceMode()) {
    // 面板已关仍被点退出：强制落「已经退出」，日志里一眼能确认不在岗
    noteGate('exited', {
      source: 'exitXwVoiceMode',
      reason: 'already-off',
      force: true,
      message: '关闭时语音对话区已不在岗',
    })
    // 语音 DOM 已关仍可能占着小V 右栏表——一并释放，避免主对话继续看到小V 缓存
    releaseXiaomiRightStageOnVoiceExit()
    return
  }
  noteGate('closing', { source: 'exitXwVoiceMode', reason: 'close-panel' })
  apply(false)
  releaseXiaomiRightStageOnVoiceExit()
  // 必须停干净：否则面板关了 continuous 仍识别并灌「输入框」（见前端日志 source=输入框）
  void import('./background-voice.js')
    .then((m) => m.shutdownXiaomiVoiceRuntime?.())
    .catch(() => {})
}
