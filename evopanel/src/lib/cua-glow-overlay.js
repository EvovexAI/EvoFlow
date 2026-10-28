/**
 * Computer Use screen-edge glow — show while the agent is driving the desktop.
 * Tauri desktop only; no-op in browser.
 */

import { isTauri } from './panel-login.js'

/** Safety idle hide if END/RESULT never arrives (ms). */
export const CUA_GLOW_IDLE_TIMEOUT_MS = 90_000

let activeToolIds = new Set()
let visible = false
let idleTimer = null
let showInFlight = null

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

async function showNative() {
  if (!isTauri) return
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_overlay_show')
    visible = true
  } catch (err) {
    console.warn('[cua-glow] show failed', err)
  }
}

async function hideNative() {
  if (!isTauri) return
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_overlay_hide')
  } catch (err) {
    console.warn('[cua-glow] hide failed', err)
  } finally {
    visible = false
  }
}

/** Force-hide regardless of refcount (session abort / idle). */
export async function hideCuaGlowOverlayForced() {
  clearIdleTimer()
  activeToolIds = new Set()
  showInFlight = null
  await hideNative()
}

/** Mark one Computer Use tool call as active (refcount). */
export function beginCuaGlowOverlay(toolCallId) {
  if (!isTauri) return
  const id = String(toolCallId || '').trim() || `__anon_${Date.now()}`
  activeToolIds.add(id)
  armIdleTimer()
  if (visible) return
  if (!showInFlight) {
    showInFlight = showNative().finally(() => {
      showInFlight = null
      if (activeToolIds.size === 0) void hideNative()
    })
  }
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
}

export function isCuaGlowOverlayActive() {
  return visible || activeToolIds.size > 0
}
