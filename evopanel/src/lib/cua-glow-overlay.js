/**
 * Computer Use 顶部操作提示 — 对齐 ZCode windowsCuaOperationIndicator。
 *
 * 优先走 Tauri 命令（cua_glow_overlay_*）；命令不可用时用 WebviewWindow 前端自建
 * （无需重编 Rust 也能亮）。非 Tauri 环境 no-op。
 */

import { isTauri } from './panel-login.js'

/** 对齐 ZCode AUTO_HIDE_MS：单 cell 可跑很久，30s 兜底。 */
export const CUA_GLOW_IDLE_TIMEOUT_MS = 30_000
const HIDE_ANIMATION_MS = 120
const INDICATOR_CARD_TOP_OFFSET = 12
const INDICATOR_SHADOW_INSET = { top: 6, right: 8, bottom: 12, left: 8 }
const WINDOW_LABEL = 'cua-glow-0'

let activeToolIds = new Set()
let visible = false
let idleTimer = null
let hideTimer = null
let showInFlight = null
/** @type {import('@tauri-apps/api/webviewWindow').WebviewWindow | null} */
let jsWindow = null

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

function clearHideTimer() {
  if (hideTimer != null) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function armIdleTimer() {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    activeToolIds = new Set()
    void hideCuaGlowOverlayForced()
  }, CUA_GLOW_IDLE_TIMEOUT_MS)
}

function indicatorSize() {
  const isZh =
    typeof navigator !== 'undefined' &&
    /^zh\b/i.test(String(navigator.language || navigator.languages?.[0] || ''))
  const width = (isZh ? 234 : 308) + INDICATOR_SHADOW_INSET.left + INDICATOR_SHADOW_INSET.right
  const height = INDICATOR_SHADOW_INSET.top + 38 + INDICATOR_SHADOW_INSET.bottom
  return { width, height }
}

async function ensureJsWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const { availableMonitors, primaryMonitor } = await import('@tauri-apps/api/window')
  const existing = await WebviewWindow.getByLabel(WINDOW_LABEL)
  if (existing) {
    jsWindow = existing
    return existing
  }

  const { width, height } = indicatorSize()
  const monitors = (await availableMonitors()) || []
  const monitor = monitors[0] || (await primaryMonitor())
  const area = monitor?.workArea || monitor?.size
  const pos = monitor?.position || { x: 0, y: 0 }
  const areaW = Number(area?.width || 1280)
  const areaH = Number(area?.height || 800)
  // workArea / size 在 Tauri 可能是物理像素；用 scaleFactor 转逻辑坐标。
  const scale = Number(monitor?.scaleFactor || 1) || 1
  const logicalW = areaW / scale
  const originX = Number(pos.x || 0) / scale
  const originY = Number(pos.y || 0) / scale
  const x = Math.round(originX + (logicalW - width) / 2)
  const y = Math.round(originY + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top)

  const win = new WebviewWindow(WINDOW_LABEL, {
    url: 'cua-glow-overlay.html',
    title: 'EvoFlow Computer Use',
    width,
    height,
    x,
    y,
    decorations: false,
    transparent: true,
    shadow: false,
    alwaysOnTop: true,
    focus: false,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    closable: false,
    visible: false,
    contentProtected: true,
  })

  await new Promise((resolve, reject) => {
    const onCreated = () => {
      win.unlisten?.('tauri://error')
      resolve(undefined)
    }
    const onError = (e) => reject(e?.payload || e || new Error('webview create failed'))
    void win.once('tauri://created', onCreated)
    void win.once('tauri://error', onError)
    setTimeout(() => resolve(undefined), 800)
  })

  try {
    await win.setIgnoreCursorEvents(true)
  } catch {
    /* ACL 缺失时仍显示，只是可能挡点击 */
  }
  try {
    await win.setContentProtected(true)
  } catch {
    /* optional */
  }
  try {
    await win.setAlwaysOnTop(true)
  } catch {
    /* optional */
  }

  jsWindow = win
  return win
}

async function showViaJsWindow() {
  const win = await ensureJsWindow()
  try {
    await win.eval?.('window.__cuaGlowOverlay?.setActive?.()')
  } catch {
    /* ignore */
  }
  await win.show()
  try {
    await win.setAlwaysOnTop(true)
  } catch {
    /* ignore */
  }
  visible = true
}

async function hideViaJsWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const target = jsWindow || (await WebviewWindow.getByLabel(WINDOW_LABEL))
  if (!target) {
    visible = false
    return
  }
  try {
    await target.eval?.('window.__cuaGlowOverlay?.setLeaving?.()')
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, HIDE_ANIMATION_MS))
  try {
    await target.hide()
  } catch {
    /* ignore */
  }
  visible = false
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
  clearHideTimer()
  // 1) Rust 命令（完整多屏 + 置顶修复）
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_overlay_show')
    visible = true
    void glowLog('show via invoke ok')
    return
  } catch (err) {
    void glowLog(`invoke show failed → WebviewWindow fallback: ${String(err?.message || err)}`)
  }
  // 2) 前端自建（现有桌面包无需重编 Rust）
  try {
    await showViaJsWindow()
    void glowLog('show via WebviewWindow ok')
  } catch (err) {
    void glowLog(`WebviewWindow show failed: ${String(err?.message || err)}`)
  }
}

async function hideNative() {
  if (!isTauri) return
  clearHideTimer()
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_overlay_hide')
    visible = false
    return
  } catch {
    /* fall through */
  }
  try {
    await hideViaJsWindow()
  } catch (err) {
    console.warn('[cua-glow] hide failed', err)
    visible = false
  }
}

/** Force-hide regardless of refcount (session abort / idle). */
export async function hideCuaGlowOverlayForced() {
  clearIdleTimer()
  clearHideTimer()
  activeToolIds = new Set()
  showInFlight = null
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
