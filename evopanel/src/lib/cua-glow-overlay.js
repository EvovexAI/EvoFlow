/**
 * Computer Use 顶部操作提示 — 对齐 ZCode windowsCuaOperationIndicator.
 *
 * 只走 Rust ``cua_glow_overlay_show/hide``（不透明窗 + HWND_TOPMOST）。
 * 前端 WebviewWindow 在本机上会 ``failed to receive message from webview``，不可用。
 */

import { isTauri } from './panel-login.js'

/** 对齐 ZCode AUTO_HIDE_MS */
export const CUA_GLOW_IDLE_TIMEOUT_MS = 30_000

let activeToolIds = new Set()
let visible = false
let idleTimer = null
const SHOW_LOCK =
  typeof window !== 'undefined' ? (window.__evoflowCuaGlowShow ||= { inFlight: null }) : { inFlight: null }

async function tauriInvoke() {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

function clearIdleTimer() {
  if (idleTimer != null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function armIdleTimer() {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    activeToolIds = new Set()
    void hideCuaGlowOverlayForced()
  }, CUA_GLOW_IDLE_TIMEOUT_MS)
}

async function glowLog(message) {
  try {
    const { blog } = await import('./browser-unified-log.js')
    blog('info', `[cua-glow] ${message}`)
  } catch {
    console.info('[cua-glow]', message)
  }
}

async function showNative() {
  if (!isTauri) {
    void glowLog('show skipped: not Tauri')
    return
  }
  if (SHOW_LOCK.inFlight) {
    await SHOW_LOCK.inFlight
    return
  }
  SHOW_LOCK.inFlight = (async () => {
    try {
      const invoke = await tauriInvoke()
      await invoke('cua_glow_overlay_show')
      visible = true
      void glowLog('show via rust invoke ok')
    } catch (err) {
      visible = false
      void glowLog(`rust show failed: ${String(err?.message || err)}`)
    }
  })().finally(() => {
    SHOW_LOCK.inFlight = null
  })
  await SHOW_LOCK.inFlight
}

async function hideNative() {
  if (!isTauri) return
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_overlay_hide')
    void glowLog('hide via rust invoke ok')
  } catch (err) {
    void glowLog(`rust hide failed: ${String(err?.message || err)}`)
  }
  visible = false
}

/** Force-hide regardless of refcount (session abort / idle). */
export async function hideCuaGlowOverlayForced() {
  clearIdleTimer()
  activeToolIds = new Set()
  await hideNative()
}

/** Mark one Computer Use tool call as active (refcount). */
export function beginCuaGlowOverlay(toolCallId) {
  if (!isTauri) {
    void glowLog(`begin skipped: not Tauri id=${toolCallId || '-'}`)
    return
  }
  const id = String(toolCallId || '').trim() || `__anon_${Date.now()}`
  activeToolIds.add(id)
  armIdleTimer()
  void glowLog(`begin id=${id} visible=${visible} activeCount=${activeToolIds.size}`)
  void showNative()
}

/** Drop one tool call; hide when none remain. */
export function endCuaGlowOverlay(toolCallId) {
  if (!isTauri) return
  const id = String(toolCallId || '').trim()
  if (id) activeToolIds.delete(id)
  else activeToolIds = new Set()
  if (activeToolIds.size > 0) {
    armIdleTimer()
    return
  }
  clearIdleTimer()
  void hideNative()
}

/** Refresh idle deadline while the same turn keeps driving the desktop. */
export function touchCuaGlowOverlay(toolCallId) {
  if (!isTauri || activeToolIds.size === 0) return
  const id = String(toolCallId || '').trim()
  if (id) activeToolIds.add(id)
  armIdleTimer()
  void showNative()
}

export function isCuaGlowOverlayActive() {
  return visible || activeToolIds.size > 0
}
