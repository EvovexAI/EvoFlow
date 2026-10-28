/**
 * Poll gateway ``/api/cua/glow-status`` and drive the ZCode-aligned top indicator.
 *
 * IMPORTANT:
 * - ``api.get`` does not exist — use ``gatewayProxy``.
 * - ``__probe__: true`` skips the gateway warm queue.
 * - Only ONE poll interval may run (HMR + bootstrap both call start).
 */

import { isTauri } from './panel-login.js'
import {
  beginCuaGlowOverlay,
  hideCuaGlowOverlayForced,
  isCuaGlowOverlayActive,
} from './cua-glow-overlay.js'

const POLL_MS = 500
const LOG_TAG = '[cua-glow]'
const GLOW_STATUS_PATH = '/cua/glow-status'

const ROOT =
  typeof window !== 'undefined'
    ? (window.__evoflowCuaGlowPoll ||= {
        epoch: 0,
        timer: null,
        lastActive: false,
        tickInFlight: false,
        fetchErrorLoggedAt: 0,
        starting: false,
      })
    : {
        epoch: 0,
        timer: null,
        lastActive: false,
        tickInFlight: false,
        fetchErrorLoggedAt: 0,
        starting: false,
      }

async function pluginLog(message) {
  try {
    const { blog } = await import('./browser-unified-log.js')
    blog('info', `${LOG_TAG} ${message}`)
  } catch {
    console.info(LOG_TAG, message)
  }
}

async function fetchGlowStatus() {
  const { gatewayProxy } = await import('./tauri-api.js')
  const res = await gatewayProxy('GET', GLOW_STATUS_PATH, null, null, {
    silent: true,
    skipRetry: true,
    skipDedup: true,
    __probe__: true,
  })
  return res && typeof res === 'object' ? res : null
}

async function tick(epoch) {
  if (!isTauri || epoch !== ROOT.epoch || ROOT.tickInFlight) return
  ROOT.tickInFlight = true
  try {
    let status
    try {
      status = await fetchGlowStatus()
    } catch (err) {
      const now = Date.now()
      if (now - ROOT.fetchErrorLoggedAt > 8000) {
        ROOT.fetchErrorLoggedAt = now
        void pluginLog(`poll fetch failed: ${String(err?.message || err)}`)
      }
      return
    }
    if (epoch !== ROOT.epoch) return
    if (!status || typeof status !== 'object') return
    const active = status.active === true
    const flipped = active !== ROOT.lastActive
    const needsReshow = active && !isCuaGlowOverlayActive()
    if (!flipped && !needsReshow) return
    ROOT.lastActive = active
    if (active) {
      await pluginLog(
        `poll active=true running=${status.running ?? '?'} grace=${status.grace_ms_left ?? '-'} keys=${JSON.stringify(status.keys || [])}`,
      )
      beginCuaGlowOverlay('glow-status-poll')
    } else {
      await pluginLog('poll active=false → hide')
      await hideCuaGlowOverlayForced()
    }
  } finally {
    if (epoch === ROOT.epoch) ROOT.tickInFlight = false
  }
}

/** Force-clear gateway glow state (user stop / RUN_ERROR). */
export async function clearCuaGlowStatusRemote() {
  try {
    const { gatewayProxy } = await import('./tauri-api.js')
    await gatewayProxy('POST', GLOW_STATUS_PATH, { active: false, key: '' }, null, {
      silent: true,
      skipRetry: true,
      skipDedup: true,
      __probe__: true,
    })
    ROOT.lastActive = false
    await pluginLog('remote clear posted')
  } catch (err) {
    await pluginLog(`remote clear failed: ${String(err?.message || err)}`)
  }
}

/** Start polling. Idempotent — concurrent/HMR callers share one interval. */
export function startCuaGlowStatusPoll() {
  if (!isTauri) return
  if (ROOT.timer != null) return
  if (ROOT.starting) return
  ROOT.starting = true
  try {
    ROOT.epoch += 1
    const epoch = ROOT.epoch
    ROOT.lastActive = false
    ROOT.tickInFlight = false
    void pluginLog(`poll started epoch=${epoch}`)
    void tick(epoch)
    ROOT.timer = setInterval(() => {
      if (epoch !== ROOT.epoch) {
        clearInterval(ROOT.timer)
        ROOT.timer = null
        return
      }
      void tick(epoch)
    }, POLL_MS)
  } finally {
    ROOT.starting = false
  }
}

export function stopCuaGlowStatusPoll() {
  ROOT.epoch += 1
  if (ROOT.timer != null) {
    clearInterval(ROOT.timer)
    ROOT.timer = null
  }
  ROOT.lastActive = false
  ROOT.tickInFlight = false
  ROOT.starting = false
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopCuaGlowStatusPoll()
  })
}

// Bootstrap also calls start (idempotent). Keep microtask so HMR dispose+reload
// recovers without a full remount. Singleton guard prevents dual intervals.
if (isTauri) {
  queueMicrotask(() => {
    startCuaGlowStatusPoll()
  })
}
