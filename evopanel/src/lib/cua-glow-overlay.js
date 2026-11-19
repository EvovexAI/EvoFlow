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
// 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
// 上一次推给提示条的进度。只在变化时重推，避免 500ms 轮询每次都 eval 一遍页面。
let lastStep = ''
let lastStepsDone = -1
// 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
// 秒表状态翻转必须推一次（起表/停表），所以它也要参与「有没有变化」的判断。
let lastRunning = false
// 已操作时长基数：只在起表/换轮时更新（每次推送都更新也无害，卡片会重置锚点）。
let lastElapsedMs = 0
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
    // 【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
    // 真实缺陷（现网日志取证）：原来 showRing() 写在 `await cua_glow_overlay_show`
    // **之后**，而顶部卡片在现网 5 次 show 全失败（hwnd timeout / label already exists）
    // ⇒ 抛异常直接跳 catch ⇒ showRing() 一次都没执行到 ⇒ 用户「没有蓝光」。
    //
    // 判据：环和卡片是**两个独立视觉通道**，卡片挂了不能拖死环。
    // 用户的原始诉求就是「电脑周围要有蓝光」，所以环必须**先起、且不依赖卡片结果**。
    await showRing()

    try {
      const invoke = await tauriInvoke()
      await invoke('cua_glow_overlay_show', {
        step: lastStep,
        stepsDone: lastStepsDone > 0 ? lastStepsDone : 0,
        elapsedMs: lastElapsedMs,
        running: lastRunning,
      })
      visible = true
      void glowLog(`show via rust invoke ok step=${lastStep || '-'} done=${lastStepsDone}`)
    } catch (err) {
      visible = false
      void glowLog(`rust show failed (ring unaffected): ${String(err?.message || err)}`)
    }
  })().finally(() => {
    SHOW_LOCK.inFlight = null
  })
  await SHOW_LOCK.inFlight
}

/**
 * 推进「当前做到哪一步」（供提示条显示）。
 * 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
 * 判据：step 没变就不重复下发。
 * 变了走 **cua_glow_overlay_step**（只 eval 一次文案），不走 showNative ——
 * 后者会重跑 show/force_topmost/入场动画，500ms 一次会让整条提示条一直抖。
 * 若窗口还没亮，退回 showNative 让它带着步骤一起起来。
 */
export function updateCuaGlowStep(step, stepsDone, elapsedMs, running) {
  const text = String(step || '').trim()
  const done = Number(stepsDone) || 0
  const elapsed = Number(elapsedMs) || 0
  const isRunning = running === true
  // 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
  // 早退条件里必须带上 running：秒数由卡片自己走，所以 elapsed 变化不需要推送；
  // 但 running 翻转（收工/新一轮）**必须**推一次去停表或重起锚点，否则
  // 用户会看到「会话已停、秒数还在跳」或「新一轮开始了但秒数接着上轮继续」。
  if (text === lastStep && done === lastStepsDone && isRunning === lastRunning) return
  lastStep = text
  lastStepsDone = done
  lastRunning = isRunning
  lastElapsedMs = elapsed
  void glowLog(`step update step=${text || '-'} done=${done} elapsed=${elapsed}ms running=${isRunning}`)
  if (!visible && activeToolIds.size === 0) return
  void (async () => {
    try {
      const invoke = await tauriInvoke()
      const applied = await invoke('cua_glow_overlay_step', {
        step: lastStep,
        stepsDone: lastStepsDone > 0 ? lastStepsDone : 0,
        elapsedMs: elapsed,
        running: isRunning,
      })
      if (applied === false) void showNative()
    } catch (err) {
      void glowLog(`step push failed: ${String(err?.message || err)}`)
    }
  })()
}

async function hideNative() {
  if (!isTauri) return
  // 先收环：卡片与环必须同生共死，否则引用计数归零这条路径会把环留亮。
  await hideRing()
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
  await hideRing()
}

// 【self-evolution-bot · 2026-11-19 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
// 缺陷：四周蓝光环 cua_glow_ring_show/hide 早已注册进 lib.rs，但前端**一次都没调过**
// —— 用户反馈「电脑周围没有蓝光」，不是画得不像，是压根没被调用。
// 修法：蓝光环与顶部卡片同生共死（同一开关、同一轮 DOM 事件），单独一个 flag
// 防止 show 重复 invoke 造成线程反复起停。
let ringOn = false

async function showRing() {
  if (!isTauri || ringOn) return
  ringOn = true
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_ring_show')
    void glowLog('ring show ok')
  } catch (err) {
    ringOn = false
    void glowLog(`ring show failed: ${String(err?.message || err)}`)
  }
}

async function hideRing() {
  if (!isTauri || !ringOn) return
  ringOn = false
  try {
    const invoke = await tauriInvoke()
    await invoke('cua_glow_ring_hide')
    void glowLog('ring hide ok')
  } catch (err) {
    void glowLog(`ring hide failed: ${String(err?.message || err)}`)
  }
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
  // 亮顶栏后立刻切到快轮询（idle 默认 4s，否则要等下一拍才跟手）
  void import('./cua-glow-poll.js')
    .then((m) => m.kickCuaGlowStatusPoll?.())
    .catch(() => {})
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
