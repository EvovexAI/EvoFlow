/**
 * 会话调试独立页：直接打开 /agent-trace.html（开发：http://localhost:1421/agent-trace.html）
 * 与主应用共用 hash 路由片段 #/debug/agent-trace?thread_id=…
 * 可选查询参数：?thread_id=…&turn=…（无 hash 时自动写入 hash）
 */
import { initTheme, attachSystemThemeListener } from './lib/theme.js'
import { checkAuth, showLoginOverlay, installEvopanelGlobalLoginHandler, isTauri } from './lib/panel-login.js'
import { checkGatewayHealth, probeGatewayBaseUrl, setGatewayBaseUrlOverride } from './lib/tauri-api.js'

import './style/variables.css'
import './style/reset.css'
import './style/layout.css'
import './style/components.css'
import './style/pages.css'
import './style/debug.css'
import './style/agent-trace.css'
import './style/obs-dashboard.css'

if (typeof document !== 'undefined' && isTauri) {
  document.documentElement.classList.add('evopanel-tauri')
}
document.documentElement.classList.add('agent-trace-standalone')

initTheme()
attachSystemThemeListener()
installEvopanelGlobalLoginHandler()

function syncHashFromSearch() {
  const raw = window.location.hash.replace(/^#/, '').trim()
  if (raw) return
  const sp = new URLSearchParams(window.location.search)
  const tid = (sp.get('thread_id') || '').trim()
  const turn = (sp.get('turn') || '').trim()
  if (!tid && !turn) return
  const q = new URLSearchParams()
  if (tid) q.set('thread_id', tid)
  if (turn) q.set('turn', turn)
  const qs = q.toString()
  window.location.replace(`${window.location.pathname}#/debug/agent-trace${qs ? `?${qs}` : ''}`)
}

syncHashFromSearch()
if (!window.location.hash || window.location.hash === '#') {
  window.location.replace(`${window.location.pathname}#/debug/agent-trace`)
}

;(async () => {
  // 独立页优先直连 Gateway（8070/8012），避免经 Vite :1521 代理多一跳且易误配
  if (!import.meta.env?.VITE_EVOFLOW_GATEWAY_URL && !import.meta.env?.VITE_EVOFLOW_GATEWAY_PORT) {
    const probed = await probeGatewayBaseUrl()
    if (probed) setGatewayBaseUrlOverride(probed)
  }

  const maxChecks = isTauri ? 12 : 3
  let gatewayOk = false
  for (let i = 0; i < maxChecks; i++) {
    gatewayOk = await checkGatewayHealth()
    if (gatewayOk) break
    if (i + 1 < maxChecks) await new Promise((r) => setTimeout(r, 1000))
  }
  if (!gatewayOk) {
    const root = document.getElementById('agent-trace-root')
    const hint = isTauri
      ? 'Gateway 未就绪，无法加载会话调试。请确认桌面端后端已启动后刷新本页。'
      : 'Gateway 未就绪，无法加载会话调试。请先启动 Gateway（默认 8012；隔离开发环境见 dev-stack-isolated.bat 的 8070），并确认 Vite 代理目标与之匹配，然后刷新本页。'
    root.innerHTML =
      `<div class="login-card" style="margin:24px auto;max-width:520px;text-align:center"><p class="login-desc">${hint}</p></div>`
    return
  }

  const auth = await checkAuth()
  if (!auth.ok) await showLoginOverlay(auth.mustChangePassword)

  const { render } = await import('./pages/agent-trace.js')
  const root = document.getElementById('agent-trace-root')
  const page = await render()
  root.appendChild(page)
})()
