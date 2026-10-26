/**
 * 小V → right-stage 常驻页（替代 body 外挂 dock）。
 */
import { rightStageStore } from './right-stage-store.js'
import { normalizeRightStageKind } from './right-stage-types.js'

export const XIAOMI_STAGE_KIND = 'xiaomi'
export const XIAOMI_STAGE_ID = 'global'
export const XIAOMI_STAGE_TAB_KEY = `${XIAOMI_STAGE_KIND}:${XIAOMI_STAGE_ID}`

/** ChatApp 监听：打开小V 时钉住，避免 auto-steal / idle hide。 */
export const XIAOMI_STAGE_PIN_EVENT = 'evopanel:right-stage-user-pin'

let _hintSubscribed = false
function ensureXiaomiStageHintSync() {
  if (_hintSubscribed) return
  _hintSubscribed = true
  rightStageStore.subscribe(() => {
    const snap = rightStageStore.getSnapshot()
    const open =
      !snap.collapsed &&
      snap.tabs.some((t) => normalizeRightStageKind(t.kind) === XIAOMI_STAGE_KIND)
    try {
      const was = document.documentElement.dataset.xmStage === '1'
      if (open) document.documentElement.dataset.xmStage = '1'
      else delete document.documentElement.dataset.xmStage
      if (was !== open) {
        window.dispatchEvent(
          new CustomEvent('evopanel:xiaomi-stage-changed', { detail: { open } }),
        )
      }
    } catch {
      /* ignore */
    }
  })
}
ensureXiaomiStageHintSync()

export type OpenXiaomiRightStageOpts = {
  /** 非 /chat 时先导航到工作台（right-stage 挂在 ChatApp） */
  navigateToChat?: boolean
  /**
   * 打开后直接进入语音全屏（默认 true：壳按钮 / 快捷键 / 唤醒「呼叫小V」主路径）。
   * 右栏「文字」标签等需要文字态时传 false。
   */
  voiceMode?: boolean
  /**
   * 是否打开右侧小V 流式文字面板（默认 true）。
   * 唤醒词路径传 false：只进左侧语音域，右侧不抢焦点。
   */
  showRightStage?: boolean
}

function tabKeyOf(kind: string, id: string): string {
  return `${normalizeRightStageKind(kind)}:${String(id || 'primary').trim() || 'primary'}`
}

function syncXiaomiStageDomHint(open: boolean) {
  try {
    if (open) document.documentElement.dataset.xmStage = '1'
    else delete document.documentElement.dataset.xmStage
  } catch {
    /* ignore */
  }
}

export function isXiaomiRightStageVisible(): boolean {
  const snap = rightStageStore.getSnapshot()
  if (snap.collapsed) {
    syncXiaomiStageDomHint(false)
    return false
  }
  const open = snap.tabs.some((t) => normalizeRightStageKind(t.kind) === XIAOMI_STAGE_KIND)
  syncXiaomiStageDomHint(open)
  return open
}

export function isXiaomiRightStageActive(): boolean {
  const snap = rightStageStore.getSnapshot()
  if (snap.collapsed) return false
  return snap.activeKey === XIAOMI_STAGE_TAB_KEY
}

function requestUserPin(kind: string) {
  try {
    window.dispatchEvent(
      new CustomEvent(XIAOMI_STAGE_PIN_EVENT, { detail: { kind: normalizeRightStageKind(kind) } }),
    )
  } catch {
    /* ignore */
  }
}

async function ensureChatRoute(navigateToChat: boolean) {
  if (!navigateToChat) return
  try {
    const { getCurrentRoute, navigate } = await import('../../router.js')
    const route = String(getCurrentRoute() || '')
      .split('?')[0]
      .replace(/\/$/, '')
    if (route !== '/chat' && route !== '/chat-react') {
      navigate('/chat')
    }
  } catch {
    /* ignore */
  }
}

function syncShellXiaomiButton(active: boolean) {
  try {
    const btn = document.getElementById('shell-btn-xiaomi')
    btn?.classList.toggle('is-active', active)
    btn?.setAttribute('aria-pressed', active ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

/** 后台补会话 / 语音配置：不挡面板首帧。 */
function hydrateXiaomiSessionInBackground() {
  void import('../../components/global-assistant/assistant-session.js')
    .then(async (m) => {
      // 已有 sessionKey 时勿强制拉历史（发送热路径同款），首开仍 reload
      let hasKey = false
      try {
        const { getState } = await import('../../components/global-assistant/assistant-store.js')
        hasKey = !!String(getState().sessionKey || '').trim()
      } catch {
        /* ignore */
      }
      await m.ensureXiaomiSession({ reloadHistory: !hasKey })
      m.bindXiaomiStreamListener()
    })
    .catch((e) => console.warn('[xiaomi-stage] ensure session failed', e))
}

/** 打开/激活小V，并钉住；默认直接进入语音全屏。 */
export async function openXiaomiRightStage(opts: OpenXiaomiRightStageOpts = {}): Promise<void> {
  const navigateToChat = opts.navigateToChat !== false
  const voiceMode = opts.voiceMode !== false
  const showRightStage = opts.showRightStage !== false
  await ensureChatRoute(navigateToChat)

  try {
    const { ensureRightStageKindsRegistered } = await import(
      '../../react/right-stage/register-kinds.js'
    )
    ensureRightStageKindsRegistered()
  } catch {
    /* ignore */
  }

  // 外挂 dock 不再占用右缘（轻量同步，先于 show）
  try {
    const { patchState, getState } = await import(
      '../../components/global-assistant/assistant-store.js'
    )
    if (getState().isOpen) {
      patchState({ isOpen: false, isMinimized: false }, { persistUi: true, silent: true })
    }
  } catch {
    /* ignore */
  }
  try {
    document.documentElement.classList.remove('is-xm-docked')
    document.documentElement.style.setProperty('--xm-dock-width', '0px')
  } catch {
    /* ignore */
  }

  hydrateXiaomiSessionInBackground()

  if (showRightStage) {
    // 先亮右侧小V 文字面板 / 语音全屏（壳按钮、快捷键等显式打开路径）
    rightStageStore.show({
      kind: XIAOMI_STAGE_KIND,
      id: XIAOMI_STAGE_ID,
      title: '小V',
      layout: 'narrow',
      data: { globalAssistant: true },
    })
    syncXiaomiStageDomHint(true)
    requestUserPin(XIAOMI_STAGE_KIND)

    syncShellXiaomiButton(true)
    try {
      window.dispatchEvent(
        new CustomEvent('evopanel:xiaomi-stage-changed', { detail: { open: true } }),
      )
    } catch {
      /* ignore */
    }
  } else {
    // 唤醒词：只进左侧语音域，不弹右侧流式面板
    syncXiaomiStageDomHint(false)
    syncShellXiaomiButton(true)
  }

  if (voiceMode) {
    const enter = () => {
      void import('../xw-voice-mode.js')
        .then((m) => {
          m.enterXwVoiceMode({ expandRightStage: showRightStage })
          // 再补一拍：navigate('/chat') 后 ChatApp 可能晚一帧才挂上订阅
          window.setTimeout(() => {
            if (!m.isXwVoiceMode()) {
              m.enterXwVoiceMode({ expandRightStage: showRightStage })
            } else {
              window.dispatchEvent(
                new CustomEvent(m.XW_VOICE_MODE_EVENT, { detail: { on: true } }),
              )
            }
          }, 80)
        })
        .catch((e) => console.warn('[xiaomi-stage] enter voice mode failed', e))
    }
    if (showRightStage) {
      // 等右栏 DOM 挂上再进语音全屏，弧形展开动画才有可裁切的主体
      requestAnimationFrame(() => {
        requestAnimationFrame(enter)
      })
    } else {
      // left-only 也等两帧：collapse 右侧后 React 去掉 is-right-stage-open，再进语音态铺满
      requestAnimationFrame(() => {
        requestAnimationFrame(enter)
      })
    }
  }
}

/** 语音全屏中 / 小V 标签激活 → 退出并收起；否则打开并进语音全屏。 */
export async function toggleXiaomiRightStage(opts: OpenXiaomiRightStageOpts = {}): Promise<void> {
  let voiceOn = false
  try {
    const { isXwVoiceMode, exitXwVoiceMode } = await import('../xw-voice-mode.js')
    voiceOn = isXwVoiceMode()
    if (voiceOn) exitXwVoiceMode()
  } catch {
    /* ignore */
  }

  if (voiceOn || isXiaomiRightStageActive()) {
    rightStageStore.collapse()
    syncXiaomiStageDomHint(false)
    syncShellXiaomiButton(false)
    try {
      window.dispatchEvent(new CustomEvent('evopanel:xiaomi-stage-changed', { detail: { open: false } }))
    } catch {
      /* ignore */
    }
    return
  }
  if (isXiaomiRightStageVisible()) {
    // 已有小V 标签但未激活：呼叫仍走语音全屏（与 open 默认一致）
    await openXiaomiRightStage(opts)
    return
  }
  await openXiaomiRightStage(opts)
}
