/**
 * Poll gateway ``/api/cua/glow-status`` and drive the ZCode-aligned top indicator.
 *
 * Why poll: panel-stream / AG-UI sidebands are easy to miss under V4; node_repl
 * already sets in-process glow state on the gateway — this is the reliable path.
 */

import { isTauri } from './panel-login.js'
import {
  beginCuaGlowOverlay,
  hideCuaGlowOverlayForced,
  isCuaGlowOverlayActive,
} from './cua-glow-overlay.js'

const POLL_MS = 400
const LOG_TAG = '[cua-glow]'

let pollTimer = null
let lastActive = false
let started = false

async function pluginLog(message) {
  try {
    const { blog } = await import('./browser-unified-log.js')
    blog('info', `${LOG_TAG} ${message}`)
  } catch {
    console.info(LOG_TAG, message)
  }
}

async function fetchGlowStatus() {
  try {
    const { api } = await import('./tauri-api.js')
    const res = await api.get('/api/cua/glow-status')
    return res && typeof res === 'object' ? res : null
  } catch (err) {
    // Keep quiet on transient gateway blips; log occasionally.
    return { __error: String(err?.message || err || 'fetch failed') }
  }
}

async function tick() {
  if (!isTauri) return
  const status = await fetchGlowStatus()
  if (!status || status.__error) return
  const active = status.active === true
  if (active === lastActive && !(active && !isCuaGlowOverlayActive())) return
  lastActive = active
  if (active) {
    await pluginLog(
      `poll active=true running=${status.running ?? '?'} grace=${status.grace_ms_left ?? '-'} keys=${JSON.stringify(status.keys || [])}`,
    )
    beginCuaGlowOverlay('glow-status-poll')
  } else {
    await pluginLog('poll active=false → hide')
    await hideCuaGlowOverlayForced()
  }
}

/** Force-clear gateway glow state (user stop / RUN_ERROR). */
export async function clearCuaGlowStatusRemote() {
  try {
    const { api } = await import('./tauri-api.js')
    await api.post('/api/cua/glow-status', { active: false, key: '' })
    lastActive = false
    await pluginLog('remote clear posted')
  } catch (err) {
    await pluginLog(`remote clear failed: ${String(err?.message || err)}`)
  }
}

/** Start polling (idempotent). Call once from desktop chat boot. */
export function startCuaGlowStatusPoll() {
  if (!isTauri || started) return
  started = true
  void pluginLog('poll started')
  void tick()
  pollTimer = setInterval(() => {
    void tick()
  }, POLL_MS)
}

export function stopCuaGlowStatusPoll() {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  started = false
  lastActive = false
}
