/**
 * EvoFlow 启动期后端就绪轮询 + 离线兜底（v3.5 阶段 F1 commit 3 抽出）。
 *
 * 1. **showBackendWarmingBanner** — 在 `#tauri-main-chrome` 拖拽区域右侧
 *    插一行"引擎加载中…"文字提示。仅 Tauri 桌面端生效。
 *    **不要**插 body 顶 fixed bar —— 桌面无边框 chrome 顶部是窗口拖拽区,
 *    遮挡会导致用户拖不动窗口。
 *
 * 2. **startBackendReadyPoll** — 桌面端启动后立即开 500ms 轮询
 *    `checkBackendReady()`,最多 ~120s(240 attempts)。
 *    状态机:
 *      - ready → 隐藏 banner + removeBootSplash + 停轮询
 *      - 健康但未 ready → markGatewayColdStartHold(90s) + prewarm
 *      - 之前健康过现在挂了 → showBackendDownOverlay
 *      - 从未健康过且超 90s → showBackendDownOverlay(超时)
 *
 * 3. **showBackendDownOverlay** — 全屏覆盖层,显示后端离线错误 + 重试按钮
 *    + 系统日志路径(Tauri 模式) / 启动命令(Web 模式)。点击重试每 2s
 *    自动轮询,直到后端就绪后 reload 页面。
 *
 * 这些逻辑之前散在 main.js 中,现封装为单一模块,内部维护两个 timer
 * 句柄(_backendReadyPollTimer / _backendRetryTimer),外部只调
 * `startBackendReadyPoll()`。
 */
import { isTauri, LOGIN_LOGO_SVG as _logoSvg } from '../lib/panel-login.js'
import { removeBootSplash } from '../router.js'
import { bootMark } from '../lib/startup-trace.js'
import { checkBackendHealth, checkBackendReady, kickAppServerPrewarm } from '../lib/tauri-api.js'
import { version as APP_VERSION } from '../../package.json'

// 内部 timer 句柄 —— 不 export,所有重启/清理都走模块内部
let _backendRetryTimer = null
let _backendReadyPollTimer = null

function showBackendWarmingBanner() {
  // Do NOT insert a fixed full-width bar at body top — it covers the frameless
  // title drag region and blocks window move. Status lives in chat header /
  // composer (engineReady) and optionally in #tauri-main-chrome.
  const chrome = document.getElementById('tauri-main-chrome')
  if (!chrome) return
  let el = document.getElementById('backend-warming-banner')
  if (!el) {
    el = document.createElement('div')
    el.id = 'backend-warming-banner'
    el.className = 'tauri-main-chrome-status'
    el.setAttribute('role', 'status')
    el.setAttribute('data-tauri-drag-region', '')
    el.textContent = '引擎加载中…'
    const drag = chrome.querySelector('.tauri-main-chrome-drag')
    if (drag) drag.appendChild(el)
    else chrome.insertBefore(el, chrome.firstChild)
  }
}

function hideBackendWarmingBanner() {
  document.getElementById('backend-warming-banner')?.remove()
}

export function startBackendReadyPoll() {
  if (!isTauri || _backendReadyPollTimer) return
  // Prefer injecting into chrome after boot; retry a few times if chrome not yet mounted.
  const tryShow = () => {
    showBackendWarmingBanner()
    if (!document.getElementById('backend-warming-banner') && document.getElementById('tauri-main-chrome')) {
      showBackendWarmingBanner()
    }
  }
  tryShow()
  setTimeout(tryShow, 400)
  let attempts = 0
  let everHealthy = false
  const maxAttempts = 240 // ~120s at 500ms
  const WARMING_TIMEOUT_ATTEMPTS = 180 // ~90s at 500ms
  const tick = async () => {
    attempts += 1
    if (await checkBackendReady()) {
      everHealthy = true
      hideBackendWarmingBanner()
      try {
        removeBootSplash()
      } catch {
        /* ignore */
      }
      if (_backendReadyPollTimer) {
        clearInterval(_backendReadyPollTimer)
        _backendReadyPollTimer = null
      }
      bootMark('backend ready ok (async poll)')
      void import('../lib/startup-trace.js')
        .then((m) => m.bootMarkEngineReady?.({ source: 'ready-poll' }))
        .catch(() => {})
      return
    }
    const healthOk = await checkBackendHealth()
    if (healthOk) {
      everHealthy = true
      // 仍未 /ready：续冷启动 hold，避免 LG lifespan 卡事件循环时被 guardian 杀掉
      void import('../lib/gateway-guardian-busy.js')
        .then((m) => m.markGatewayColdStartHold?.(90_000))
        .catch(() => {})
      // Runtime: warm stdio as soon as alive; /ready stays async for send gate only.
      void kickAppServerPrewarm('ready-poll-liveness').then((ok) => {
        if (ok) bootMark('app-server prewarm ok (liveness)')
      })
      return
    }
    if (everHealthy) {
      // 真故障（起过又挂了）
      hideBackendWarmingBanner()
      if (_backendReadyPollTimer) {
        clearInterval(_backendReadyPollTimer)
        _backendReadyPollTimer = null
      }
      showBackendDownOverlay()
      return
    }
    if (attempts >= WARMING_TIMEOUT_ATTEMPTS) {
      // 超时故障：从未健康过且超过 90s
      hideBackendWarmingBanner()
      if (_backendReadyPollTimer) {
        clearInterval(_backendReadyPollTimer)
        _backendReadyPollTimer = null
      }
      bootMark('backend ready timeout (async poll)')
      showBackendDownOverlay()
    }
    // 其余：保持 warming 横幅继续轮询
  }
  void tick()
  _backendReadyPollTimer = setInterval(tick, 500)
}

function showBackendDownOverlay() {
  hideBackendWarmingBanner()
  removeBootSplash()
  if (document.getElementById('backend-down-overlay')) return
  const desktopHint = isTauri
    ? `
      <div style="background:var(--bg-tertiary);border-radius:var(--radius-md,8px);padding:14px 18px;margin:16px 0;text-align:left;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;user-select:all;color:var(--text-secondary)">
        <div style="color:var(--text-tertiary);margin-bottom:4px"># 全周期时序（打开→引擎就绪）</div>
        <code style="display:block;white-space:pre-wrap;word-break:break-all;background:var(--bg-tertiary);padding:8px;border-radius:6px;font-size:11px;line-height:1.5">%USERPROFILE%\\.evoflow\\logs\\boot-cycle.log
# 搜 [BOOT-CYCLE] ；同时可看 gateway-startup / evopanel-startup / [BOOT]</code>
        ~/.evoflow/logs/evopanel-startup.log<br>
        ~/.evoflow/logs/evoflow-gateway-&lt;日期&gt;.log<br>
        ~/.evoflow/logs/langgraph-&lt;日期&gt;.log<br>
        ~/.evoflow/logs/frontend-&lt;日期&gt;.log
      </div>
      <button class="login-btn" id="btn-open-system-logs" type="button" style="margin-top:4px;background:transparent;border:1px solid var(--border);color:var(--text-secondary)">
        打开系统日志
      </button>
    `
    : `
      <div style="background:var(--bg-tertiary);border-radius:var(--radius-md,8px);padding:14px 18px;margin:16px 0;text-align:left;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;user-select:all;color:var(--text-secondary)">
        <div style="color:var(--text-tertiary);margin-bottom:4px"># 开发模式</div>
        npm run dev<br>
        <div style="color:var(--text-tertiary);margin-top:8px;margin-bottom:4px"># 生产模式</div>
        npm run preview
      </div>
    `
  const overlay = document.createElement('div')
  overlay.id = 'backend-down-overlay'
  overlay.innerHTML = `
    <div class="login-card" style="text-align:center">
      ${_logoSvg}
      <div class="login-title" style="color:var(--error,#ef4444)">后端未启动</div>
      <div class="login-desc" style="line-height:1.8">
        ${isTauri ? '内置后端仍在启动或已异常退出。' : 'EvoFlow 后端服务未运行，无法获取真实数据。'}<br>
        <span style="font-size:12px;color:var(--text-tertiary)">${isTauri ? '请点击重新检测，或查看日志定位启动失败原因。' : '请在服务器上启动后端服务后刷新页面。'}</span>
      </div>
      ${desktopHint}
      <button class="login-btn" id="btn-backend-retry" style="margin-top:8px">
        <span id="backend-retry-text">重新检测</span>
      </button>
      <div id="backend-retry-status" style="font-size:12px;color:var(--text-tertiary);margin-top:12px"></div>
      ${isTauri && window.__yt_last_gateway_error ? `
        <div style="margin-top:10px;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;font-size:12px;color:var(--error,#ef4444);text-align:left;line-height:1.6;word-break:break-all">
          最近错误：${String(window.__yt_last_gateway_error).replace(/</g, '&lt;')}
        </div>
      ` : ''}
      <div style="margin-top:16px;font-size:11px;color:#aaa">
        v${APP_VERSION}
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  let retrying = false
  const btn = overlay.querySelector('#btn-backend-retry')
  const statusEl = overlay.querySelector('#backend-retry-status')
  const textEl = overlay.querySelector('#backend-retry-text')

  btn.addEventListener('click', async () => {
    if (retrying) return
    retrying = true
    btn.disabled = true
    textEl.textContent = '检测中...'
    statusEl.textContent = ''

    const ok = await checkBackendHealth()
    if (ok) {
      const ready = await checkBackendReady()
      statusEl.textContent = ready ? '后端已连接，正在加载...' : 'Agent 引擎仍在加载…'
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); if (ready) location.reload() }, 600)
    } else {
      statusEl.textContent = '后端仍未响应，请确认服务已启动'
      statusEl.style.color = 'var(--error,#ef4444)'
      textEl.textContent = '重新检测'
      btn.disabled = false
      retrying = false
    }
  })

  overlay.querySelector('#btn-open-system-logs')?.addEventListener('click', () => {
    try {
      if (_backendRetryTimer) {
        clearInterval(_backendRetryTimer)
        _backendRetryTimer = null
      }
    } catch (_) {}
    overlay.remove()
    window.location.hash = '/logs'
  })

  // 自动轮询：每 5 秒检测一次
  if (_backendRetryTimer) clearInterval(_backendRetryTimer)
  _backendRetryTimer = setInterval(async () => {
    const ok = await checkBackendHealth()
    if (ok) {
      clearInterval(_backendRetryTimer)
      _backendRetryTimer = null
      const ready = await checkBackendReady()
      statusEl.textContent = ready ? '后端已连接，正在加载...' : 'Agent 引擎仍在加载…'
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); if (ready) location.reload() }, 600)
    }
  }, 2000)
}
