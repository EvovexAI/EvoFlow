/**
 * Poll gateway ``/api/cua/glow-status`` and drive the ZCode-aligned top indicator.
 *
 * IMPORTANT:
 * - ``api.get`` does not exist — use ``gatewayProxy``.
 * - ``__probe__: true`` skips the gateway warm queue.
 * - Only ONE poll loop may run (HMR + bootstrap both call start).
 * - Idle / background: slow poll；CUA 活跃或顶栏亮着：500ms。
 */

import { isTauri } from './panel-login.js'
import {
  beginCuaGlowOverlay,
  hideCuaGlowOverlayForced,
  isCuaGlowOverlayActive,
  updateCuaGlowStep,
} from './cua-glow-overlay.js'

/** CUA 进行中 / 顶栏亮着：跟手 */
const POLL_ACTIVE_MS = 500
/** 没事干：降频，别刷爆 OPTIONS+GET */
const POLL_IDLE_MS = 4000
/** 窗口隐藏：再降 */
const POLL_HIDDEN_MS = 15000

const LOG_TAG = '[cua-glow]'
const GLOW_STATUS_PATH = '/cua/glow-status'

const ROOT =
  typeof window !== 'undefined'
    ? (window.__evoflowCuaGlowPoll ||= {
        epoch: 0,
        timer: null,
        lastActive: false,
        lastStepSeq: 0,
        // 【self-evolution-bot · 2026-11-19 · 第72轮】秒表起/停的比较基准；
        // 缺这个字段会让 runChanged 恒为 true（undefined !== bool），每个 tick 都推。
        lastRunning: false,
        tickInFlight: false,
        fetchErrorLoggedAt: 0,
        starting: false,
        onVisibility: null,
      })
    : {
        epoch: 0,
        timer: null,
        lastActive: false,
        lastStepSeq: 0,
        // 【self-evolution-bot · 2026-11-19 · 第72轮】秒表起/停的比较基准；
        // 缺这个字段会让 runChanged 恒为 true（undefined !== bool），每个 tick 都推。
        lastRunning: false,
        tickInFlight: false,
        fetchErrorLoggedAt: 0,
        starting: false,
        onVisibility: null,
      }

function desiredIntervalMs() {
  if (typeof document !== 'undefined' && document.hidden) return POLL_HIDDEN_MS
  if (ROOT.lastActive || isCuaGlowOverlayActive()) return POLL_ACTIVE_MS
  return POLL_IDLE_MS
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

function clearTimer() {
  if (ROOT.timer != null) {
    clearTimeout(ROOT.timer)
    ROOT.timer = null
  }
}

function armTimer(epoch) {
  if (epoch !== ROOT.epoch) return
  clearTimer()
  const ms = desiredIntervalMs()
  ROOT.timer = setTimeout(() => {
    ROOT.timer = null
    void tick(epoch).finally(() => {
      if (epoch === ROOT.epoch) armTimer(epoch)
    })
  }, ms)
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
    // 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    // 原来这里 `!flipped && !needsReshow` 直接 return —— 于是 active 没翻转时
    // 「做到第几步」永远不会更新（用户只能看到一句固定文案）。
    // 现在多一条：step_seq 变了也要继续走下去。
    const stepSeq = Number(status.step_seq) || 0
    const stepChanged = active && stepSeq !== ROOT.lastStepSeq
    // 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
    // 秒表的起/停也必须放行：cell 结束时 running 1→0、步骤文案却没变，
    // 若只在 stepChanged 时继续，卡片永远收不到「停表」信号，
    // 用户就会看到「已停止操作、秒数还在跳」。
    const runNow = (Number(status.running) || 0) > 0
    const runChanged = active && runNow !== ROOT.lastRunning
    if (!flipped && !needsReshow && !stepChanged && !runChanged) return
    ROOT.lastStepSeq = active ? stepSeq : 0
    ROOT.lastRunning = active ? runNow : false
    ROOT.lastActive = active
    if (active) {
      await pluginLog(
        `poll active=true running=${status.running ?? '?'} grace=${status.grace_ms_left ?? '-'} keys=${JSON.stringify(status.keys || [])}`,
      )
      // 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
      // 先推进度再亮条：show 时会带上当前步骤，避免首屏只有「正在操作电脑」。
      // 【self-evolution-bot · 2026-11-19 · 第72轮】透传时长与秒表状态（grace 期间 running=0 ⇒ 停表）。
      updateCuaGlowStep(status.step, status.steps_done, status.elapsed_ms, runNow)
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
    // 清完立刻按 idle 节奏重排，别继续 500ms 狂刷
    if (ROOT.timer != null || ROOT.epoch > 0) {
      armTimer(ROOT.epoch)
    }
  } catch (err) {
    await pluginLog(`remote clear failed: ${String(err?.message || err)}`)
  }
}

/**
 * CUA 刚开 / 顶栏亮起时调用：立刻切到快轮询（不必等下一个 idle tick）。
 */
export function kickCuaGlowStatusPoll() {
  if (!isTauri) return
  if (ROOT.epoch <= 0) {
    startCuaGlowStatusPoll()
    return
  }
  armTimer(ROOT.epoch)
}

/** Start polling. Idempotent — concurrent/HMR callers share one loop. */
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
    void pluginLog(`poll started epoch=${epoch} idle=${POLL_IDLE_MS}ms active=${POLL_ACTIVE_MS}ms`)
    void tick(epoch).finally(() => {
      if (epoch === ROOT.epoch) armTimer(epoch)
    })
    if (typeof document !== 'undefined' && !ROOT.onVisibility) {
      ROOT.onVisibility = () => {
        if (ROOT.epoch > 0) armTimer(ROOT.epoch)
      }
      document.addEventListener('visibilitychange', ROOT.onVisibility)
    }
  } finally {
    ROOT.starting = false
  }
}

export function stopCuaGlowStatusPoll() {
  ROOT.epoch += 1
  clearTimer()
  ROOT.lastActive = false
  ROOT.tickInFlight = false
  ROOT.starting = false
  if (typeof document !== 'undefined' && ROOT.onVisibility) {
    document.removeEventListener('visibilitychange', ROOT.onVisibility)
    ROOT.onVisibility = null
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopCuaGlowStatusPoll()
  })
}

// Bootstrap also calls start (idempotent). Keep microtask so HMR dispose+reload
// recovers without a full remount. Singleton guard prevents dual loops.
if (isTauri) {
  queueMicrotask(() => {
    startCuaGlowStatusPoll()
  })
}
