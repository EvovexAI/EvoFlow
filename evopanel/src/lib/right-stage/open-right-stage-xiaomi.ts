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
  /**
   * 非 /chat 时是否先导航到工作台（right-stage 挂在 ChatApp）。
   * 默认 false：知识库/自动化等页应留在原页用 GlobalAssistant dock，勿强行跳主对话。
   * 语音唤醒等显式传 true。
   */
  navigateToChat?: boolean
  /**
   * 打开后是否进入语音全屏（默认 false）。
   * 点侧栏 / 壳按钮 / 启动器 → 只开文字小V，不自动开麦、不播「在呢」。
   * 语音唤醒须显式传 true（见 background-voice openXiaomiForWake）。
   * 面板内「语音模式」chip 走 enterXwVoiceMode，不经本开关。
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
      // 跳到工作台前钉住当前页快照，否则 send 时只剩「主对话」、丢 session/模块上下文
      try {
        const {
          collectXiaomiPageSnapshot,
          stashXiaomiPageContextForOpen,
        } = await import('../../components/global-assistant/assistant-context.js')
        stashXiaomiPageContextForOpen(collectXiaomiPageSnapshot())
      } catch {
        /* ignore */
      }
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

function isChatWorkbenchVisibleNow(): boolean {
  try {
    const host = document.getElementById('chat-persistent-host')
    return !!(host && !host.hasAttribute('hidden'))
  } catch {
    return false
  }
}

async function syncXiaomiPageContextNow() {
  try {
    const sessionMod = await import('../../components/global-assistant/assistant-session.js')
    const { getState } = await import('../../components/global-assistant/assistant-store.js')
    const { api } = await import('../tauri-api.js')
    await sessionMod.ensureXiaomiSession({ reloadHistory: false })
    sessionMod.bindXiaomiStreamListener()
    const snap = await sessionMod.syncXiaomiPageContext()
    const key = String(getState().sessionKey || '').trim()
    if (!key || !snap) return
    const fp = sessionMod.fingerprintXiaomiPageSnap(snap) || ''
    await api.chatUpdateContext(key, {
      agent_name: 'xiaomi',
      agent_id: 'xiaomi',
      xiaomi_global_assistant: true,
      xiaomi_page_context: snap,
      xiaomi_page_context_fp: fp || null,
    })
  } catch (e) {
    console.warn('[xiaomi-stage] page context sync failed', e)
  }
}

/** 打开/激活小V 并钉住；默认仅文字侧栏。语音全屏须 opts.voiceMode === true。 */
export async function openXiaomiRightStage(opts: OpenXiaomiRightStageOpts = {}): Promise<void> {
  // 默认不跳主对话；语音唤醒仍显式 navigateToChat:true
  const navigateToChat = opts.navigateToChat === true || opts.voiceMode === true
  // 边界：UI 打开 ≠ 语音唤醒。仅显式 voiceMode:true（唤醒词）才进语音全屏。
  const voiceMode = opts.voiceMode === true
  const showRightStage = opts.showRightStage !== false

  // 功能页（知识库/自动化…）：ChatApp 藏着时不要 rightStageStore.show → 否则 xmStage=1
  // 把边缘条藏掉，右栏却看不见 →「闪一下就没了」。改挂本页 V4 dock。
  if (!navigateToChat && !isChatWorkbenchVisibleNow()) {
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
    // 清掉误标的 xmStage（否则边缘条永久不回来）
    try {
      rightStageStore.collapse()
      delete document.documentElement.dataset.xmStage
    } catch {
      try {
        delete document.documentElement.dataset.xmStage
      } catch {
        /* ignore */
      }
    }
    if (showRightStage) {
      const dock = await import('../../components/global-assistant/mount-xiaomi-v4-dock.js')
      dock.openXiaomiV4Dock()
      syncShellXiaomiButton(true)
    }
    void syncXiaomiPageContextNow()
    return
  }

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
  // 进主对话 right-stage：关掉功能页 V4 dock，避免双右栏
  try {
    const dock = await import('../../components/global-assistant/mount-xiaomi-v4-dock.js')
    if (dock.isXiaomiV4DockOpen()) dock.closeXiaomiV4Dock()
  } catch {
    /* ignore */
  }
  try {
    if (document.documentElement.dataset.xmV4Dock !== '1') {
      document.documentElement.classList.remove('is-xm-docked')
      document.documentElement.style.setProperty('--xm-dock-width', '0px')
    }
  } catch {
    /* ignore */
  }

  hydrateXiaomiSessionInBackground()
  void syncXiaomiPageContextNow()

  if (showRightStage) {
    // 先亮右侧小V 文字面板 / 语音全屏（壳按钮、快捷键等显式打开路径）
    // forceExpand：用户点小V / 壳按钮是显式打开；否则收起锁会让「点了没撑开」。
    rightStageStore.show({
      kind: XIAOMI_STAGE_KIND,
      id: XIAOMI_STAGE_ID,
      title: '小V',
      layout: 'narrow',
      data: { globalAssistant: true },
      // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
      // 小V 签的打开来源：用户点侧栏 / 唤醒词都是用户侧动作 → 'user'。
      // 这样签上显示「我」，不会被误当成某个员工智能体在动右栏。
      openedBy: 'user',
      forceExpand: true,
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
          // 仅当 ChatApp 尚未挂上、DOM 没标上语音态时再补一次；已在动画中勿再派发/重进
          window.setTimeout(() => {
            if (m.isXwVoiceMode()) return
            m.enterXwVoiceMode({ expandRightStage: showRightStage })
          }, 120)
        })
        .catch((e) => console.warn('[xiaomi-stage] enter voice mode failed', e))
    }
    // 等右栏 / collapse 布局 commit 后再进语音全屏，弧形展开才有稳定可裁切主体
    requestAnimationFrame(() => {
      requestAnimationFrame(enter)
    })
  }
}

/** 语音全屏中 / 小V 标签激活 / 功能页 V4 dock → 退出并收起；否则打开小V。 */
export async function toggleXiaomiRightStage(opts: OpenXiaomiRightStageOpts = {}): Promise<void> {
  let voiceOn = false
  try {
    const { isXwVoiceMode } = await import('../xw-voice-mode.js')
    voiceOn = isXwVoiceMode()
  } catch {
    /* ignore */
  }

  let v4DockOpen = false
  try {
    const dock = await import('../../components/global-assistant/mount-xiaomi-v4-dock.js')
    v4DockOpen = dock.isXiaomiV4DockOpen()
  } catch {
    v4DockOpen = document.documentElement.dataset.xmV4Dock === '1'
  }

  // 关语音对话区 = 退出整套语音（停听/停播）；走 closeXiaomiVoice 才会落「关闭退出→已经退出」
  if (voiceOn) {
    try {
      const { closeXiaomiVoice } = await import('../xiaomi-voice-close.js')
      await closeXiaomiVoice({ reason: 'button' })
    } catch {
      try {
        const { exitXwVoiceMode } = await import('../xw-voice-mode.js')
        exitXwVoiceMode()
      } catch {
        /* ignore */
      }
    }
  }

  if (voiceOn || isXiaomiRightStageActive() || v4DockOpen) {
    const finishClose = async () => {
      try {
        const dock = await import('../../components/global-assistant/mount-xiaomi-v4-dock.js')
        dock.closeXiaomiV4Dock()
      } catch {
        /* ignore */
      }
      rightStageStore.collapse()
      syncXiaomiStageDomHint(false)
      syncShellXiaomiButton(false)
      try {
        delete document.documentElement.dataset.xmStage
      } catch {
        /* ignore */
      }
      try {
        window.dispatchEvent(new CustomEvent('evopanel:xiaomi-stage-changed', { detail: { open: false } }))
      } catch {
        /* ignore */
      }
    }
    // 语音刚退：等窄槽位贴上再 collapse/park，避免大 HWND 盖住随后打开的图片预览。
    if (voiceOn) {
      const { afterXwVoiceExitSettle } = await import('../xw-voice-embed-settle.js')
      afterXwVoiceExitSettle({ then: () => void finishClose() })
      return
    }
    await finishClose()
    return
  }
  if (isXiaomiRightStageVisible()) {
    // 已有小V 标签但未激活：按 opts 打开（默认文字侧栏）
    await openXiaomiRightStage(opts)
    return
  }
  await openXiaomiRightStage(opts)
}
