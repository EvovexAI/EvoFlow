/**
 * 运维观测开启后的科技感性能浮窗：实时 CPU / 内存（本应用 + 本机 + LangGraph）。
 * 随 `evoflow:obs-enabled-changed` 显隐；可拖拽、可收起。
 */
import { api } from './tauri-api.js'
import { OBS_ENABLED_CHANGED_EVENT } from '../react/obs/lib/obs-api.js'

const HUD_ID = 'evoflow-perf-hud'
const POS_KEY = 'evoflow_perf_hud_pos'
const COLLAPSED_KEY = 'evoflow_perf_hud_collapsed'

let _host = null
let _timer = null
let _inFlight = false
let _installed = false
let _enabled = false
let _drag = null

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function clampPct(v) {
  const n = Number.isFinite(v) ? v : 0
  return Math.max(0, Math.min(100, n))
}

function ringSvg(pct, color) {
  const p = clampPct(pct)
  const r = 28
  const c = 2 * Math.PI * r
  const dash = (p / 100) * c
  return `<svg class="ef-hud-ring" viewBox="0 0 72 72" aria-hidden="true">
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(148,163,184,.18)" stroke-width="6"/>
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="${color}" stroke-width="6"
      stroke-linecap="round" stroke-dasharray="${dash} ${c}"
      transform="rotate(-90 36 36)"/>
  </svg>`
}

async function getSnapshot() {
  try {
    return await api.getResourceUsageSnapshot()
  } catch {
    return null
  }
}

function pickLanggraph(processes) {
  const list = Array.isArray(processes) ? processes : []
  const hit = list.find(
    (p) =>
      /langgraph/i.test(String(p.groupLabel || '')) ||
      /langgraph/i.test(String(p.groupKey || '')) ||
      /langgraph/i.test(String(p.name || '')),
  )
  if (hit) return hit
  // 未带新 Tauri 分类时：取最大内存的 gateway 进程（通常即 Agent Runtime）
  const gateways = list
    .filter(
      (p) =>
        /gateway/i.test(String(p.name || '')) ||
        String(p.groupLabel || '') === 'Gateway' ||
        String(p.groupLabel || '') === 'Gateway / Python',
    )
    .sort((a, b) => (b.memoryBytes || 0) - (a.memoryBytes || 0))
  return gateways[0] || null
}

function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    if (typeof j?.left === 'number' && typeof j?.top === 'number') return j
  } catch {
    /* ignore */
  }
  return null
}

function savePos(left, top) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ left, top }))
  } catch {
    /* ignore */
  }
}

function isCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function setCollapsed(v) {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function hudCss() {
  return `
      #${HUD_ID}{
        position:fixed;z-index:2147482900;left:auto;right:18px;bottom:18px;top:auto;
        width:292px;user-select:none;
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        color:#e2e8f0;
        filter:drop-shadow(0 10px 28px rgba(0,0,0,.28));
      }
      #${HUD_ID} .ef-hud-shell{
        position:relative;border-radius:16px;overflow:hidden;
        background:linear-gradient(155deg,rgba(15,23,42,.42),rgba(30,41,59,.36) 48%,rgba(15,23,42,.48));
        border:1px solid rgba(125,211,252,.22);
        backdrop-filter:blur(18px) saturate(1.35);
        -webkit-backdrop-filter:blur(18px) saturate(1.35);
        box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 0 1px rgba(56,189,248,.06);
      }
      #${HUD_ID} .ef-hud-shell::before{
        content:"";position:absolute;inset:0;pointer-events:none;
        background:
          linear-gradient(180deg,rgba(34,211,238,.06),transparent 32%),
          repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(148,163,184,.02) 3px);
        opacity:.7;
      }
      #${HUD_ID} .ef-hud-head{
        position:relative;display:flex;align-items:center;justify-content:space-between;
        gap:8px;padding:10px 12px 6px;cursor:grab;
      }
      #${HUD_ID} .ef-hud-head:active{cursor:grabbing}
      #${HUD_ID} .ef-hud-brand{
        display:flex;align-items:center;gap:8px;min-width:0;
      }
      #${HUD_ID} .ef-hud-pulse{
        width:8px;height:8px;border-radius:50%;background:#22d3ee;
        box-shadow:0 0 0 0 rgba(34,211,238,.7);
        animation:efHudPulse 1.6s ease-out infinite;
        flex:0 0 auto;
      }
      @keyframes efHudPulse{
        0%{box-shadow:0 0 0 0 rgba(34,211,238,.55)}
        70%{box-shadow:0 0 0 8px rgba(34,211,238,0)}
        100%{box-shadow:0 0 0 0 rgba(34,211,238,0)}
      }
      #${HUD_ID} .ef-hud-title{
        font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#67e8f9;font-weight:700;
      }
      #${HUD_ID} .ef-hud-sub{
        font-size:10px;color:#94a3b8;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      }
      #${HUD_ID} .ef-hud-actions{display:flex;gap:4px;flex:0 0 auto}
      #${HUD_ID} .ef-hud-btn{
        border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.28);
        color:#cbd5e1;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:12px;line-height:1;
      }
      #${HUD_ID} .ef-hud-btn:hover{border-color:rgba(34,211,238,.55);color:#67e8f9;background:rgba(15,23,42,.4)}
      #${HUD_ID} .ef-hud-body{position:relative;padding:4px 12px 12px}
      #${HUD_ID}.is-collapsed .ef-hud-body{display:none}
      #${HUD_ID} .ef-hud-gauges{
        display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;
      }
      #${HUD_ID} .ef-hud-gauge{
        position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;
        padding:8px 4px 6px;border-radius:12px;
        background:rgba(15,23,42,.22);border:1px solid rgba(148,163,184,.18);
      }
      #${HUD_ID} .ef-hud-ring-wrap{position:relative;width:72px;height:72px}
      #${HUD_ID} .ef-hud-ring{width:72px;height:72px;display:block}
      #${HUD_ID} .ef-hud-ring-val{
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        flex-direction:column;pointer-events:none;
      }
      #${HUD_ID} .ef-hud-ring-val strong{font-size:13px;color:#f8fafc;font-weight:700}
      #${HUD_ID} .ef-hud-ring-val span{font-size:9px;color:#94a3b8;letter-spacing:.08em}
      #${HUD_ID} .ef-hud-gauge-label{font-size:10px;color:#7dd3fc;letter-spacing:.08em}
      #${HUD_ID} .ef-hud-rows{display:flex;flex-direction:column;gap:6px}
      #${HUD_ID} .ef-hud-row{
        display:flex;justify-content:space-between;align-items:baseline;gap:8px;
        font-size:11px;padding:6px 8px;border-radius:8px;
        background:rgba(15,23,42,.2);border:1px solid rgba(148,163,184,.14);
      }
      #${HUD_ID} .ef-hud-row.is-warn{border-color:rgba(251,113,133,.55);color:#fda4af}
      #${HUD_ID} .ef-hud-row .k{color:#94a3b8}
      #${HUD_ID} .ef-hud-row .v{color:#e2e8f0;font-weight:650;white-space:nowrap}
      #${HUD_ID} .ef-hud-foot{
        margin-top:8px;display:flex;justify-content:space-between;gap:8px;align-items:center;
      }
      #${HUD_ID} .ef-hud-link{
        border:0;background:transparent;color:#38bdf8;font-size:11px;cursor:pointer;padding:0;
        font-family:inherit;
      }
      #${HUD_ID} .ef-hud-link:hover{text-decoration:underline;color:#7dd3fc}
      #${HUD_ID} .ef-hud-tick{font-size:10px;color:#64748b}
  `
}

function ensureHost() {
  if (_host && document.body.contains(_host)) {
    const styleEl = _host.querySelector('style')
    if (styleEl) styleEl.textContent = hudCss()
    return _host
  }
  const host = document.createElement('div')
  host.id = HUD_ID
  host.innerHTML = `
    <style>${hudCss()}</style>
    <div class="ef-hud-shell" data-hud-shell>
      <div class="ef-hud-head" data-hud-drag>
        <div class="ef-hud-brand">
          <i class="ef-hud-pulse" aria-hidden="true"></i>
          <div style="min-width:0">
            <div class="ef-hud-title">Perf HUD</div>
            <div class="ef-hud-sub" data-hud-sub>运维观测 · 实时采样</div>
          </div>
        </div>
        <div class="ef-hud-actions">
          <button type="button" class="ef-hud-btn" data-hud-collapse title="收起/展开">–</button>
          <button type="button" class="ef-hud-btn" data-hud-close title="关闭浮窗（调试模式仍开启）">×</button>
        </div>
      </div>
      <div class="ef-hud-body" data-hud-body>
        <div class="ef-hud-gauges">
          <div class="ef-hud-gauge" data-hud-cpu-gauge></div>
          <div class="ef-hud-gauge" data-hud-mem-gauge></div>
        </div>
        <div class="ef-hud-rows" data-hud-rows></div>
        <div class="ef-hud-foot">
          <button type="button" class="ef-hud-link" data-hud-obs>运维观测 →</button>
          <button type="button" class="ef-hud-link" data-hud-rm>资源管理器</button>
          <span class="ef-hud-tick" data-hud-tick>—</span>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(host)
  _host = host

  const pos = loadPos()
  if (pos) {
    host.style.left = `${Math.max(8, pos.left)}px`
    host.style.top = `${Math.max(8, pos.top)}px`
    host.style.right = 'auto'
    host.style.bottom = 'auto'
  }
  host.classList.toggle('is-collapsed', isCollapsed())

  host.querySelector('[data-hud-collapse]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const next = !host.classList.contains('is-collapsed')
    host.classList.toggle('is-collapsed', next)
    setCollapsed(next)
  })
  host.querySelector('[data-hud-close]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    hidePerfHud({ userDismissed: true })
  })
  host.querySelector('[data-hud-obs]')?.addEventListener('click', () => {
    window.location.hash = '/observability'
  })
  host.querySelector('[data-hud-rm]')?.addEventListener('click', () => {
    void import('./resource-manager-overlay.js').then((m) => m.openResourceManagerOverlay())
  })

  const dragEl = host.querySelector('[data-hud-drag]')
  dragEl?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if (e.target?.closest?.('.ef-hud-btn')) return
    const rect = host.getBoundingClientRect()
    _drag = {
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      pointerId: e.pointerId,
    }
    try {
      dragEl.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  })
  dragEl?.addEventListener('pointermove', (e) => {
    if (!_drag || _drag.pointerId !== e.pointerId) return
    const left = Math.min(window.innerWidth - 40, Math.max(0, e.clientX - _drag.ox))
    const top = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - _drag.oy))
    host.style.left = `${left}px`
    host.style.top = `${top}px`
    host.style.right = 'auto'
    host.style.bottom = 'auto'
  })
  const endDrag = (e) => {
    if (!_drag || (_drag.pointerId != null && e.pointerId !== _drag.pointerId)) return
    const rect = host.getBoundingClientRect()
    savePos(rect.left, rect.top)
    _drag = null
  }
  dragEl?.addEventListener('pointerup', endDrag)
  dragEl?.addEventListener('pointercancel', endDrag)

  return host
}

function render(host, snap) {
  const appCpu = clampPct(snap?.app?.cpuPercent)
  const sysCpu = clampPct(snap?.system?.cpuPercent)
  const appMem = Number(snap?.app?.memoryBytes) || 0
  const sysUsed = Number(snap?.system?.memoryUsedBytes) || 0
  const sysTotal = Number(snap?.system?.memoryTotalBytes) || 0
  const sysMemPct = sysTotal > 0 ? (sysUsed / sysTotal) * 100 : 0
  const appMemPct = sysTotal > 0 ? (appMem / sysTotal) * 100 : 0
  const lg = pickLanggraph(snap?.processes)
  const lgWarn = lg && lg.memoryBytes >= 4 * 1024 * 1024 * 1024

  const cpuGauge = host.querySelector('[data-hud-cpu-gauge]')
  const memGauge = host.querySelector('[data-hud-mem-gauge]')
  if (cpuGauge) {
    cpuGauge.innerHTML = `
      <div class="ef-hud-ring-wrap">
        ${ringSvg(appCpu, appCpu >= 80 ? '#fb7185' : '#22d3ee')}
        <div class="ef-hud-ring-val"><strong>${appCpu.toFixed(0)}%</strong><span>APP</span></div>
      </div>
      <div class="ef-hud-gauge-label">CPU</div>
    `
  }
  if (memGauge) {
    memGauge.innerHTML = `
      <div class="ef-hud-ring-wrap">
        ${ringSvg(sysMemPct, sysMemPct >= 85 ? '#fb7185' : '#34d399')}
        <div class="ef-hud-ring-val"><strong>${sysMemPct.toFixed(0)}%</strong><span>SYS</span></div>
      </div>
      <div class="ef-hud-gauge-label">内存</div>
    `
  }

  const rows = host.querySelector('[data-hud-rows]')
  if (rows) {
    rows.innerHTML = `
      <div class="ef-hud-row">
        <span class="k">本机 CPU</span><span class="v">${sysCpu.toFixed(1)}%</span>
      </div>
      <div class="ef-hud-row">
        <span class="k">EvoFlow 内存</span><span class="v">${formatBytes(appMem)}${sysTotal ? ` · ${appMemPct.toFixed(1)}%` : ''}</span>
      </div>
      <div class="ef-hud-row">
        <span class="k">本机内存</span><span class="v">${sysTotal ? `${formatBytes(sysUsed)} / ${formatBytes(sysTotal)}` : '—'}</span>
      </div>
      <div class="ef-hud-row ${lgWarn ? 'is-warn' : ''}">
        <span class="k">LangGraph RSS</span>
        <span class="v">${lg ? `${formatBytes(lg.memoryBytes)} · CPU ${clampPct(lg.cpuPercent).toFixed(1)}%` : '未采样到'}</span>
      </div>
    `
  }

  const sub = host.querySelector('[data-hud-sub]')
  if (sub) {
    const marker = snap?.instanceMarker || snap?.instance_marker || ''
    sub.textContent = marker
      ? `实例 ${marker} · ${(snap?.processes || []).length} 进程`
      : `运维观测 · ${(snap?.processes || []).length} 进程`
  }
  const tick = host.querySelector('[data-hud-tick]')
  if (tick) tick.textContent = new Date().toLocaleTimeString()
}

async function refresh() {
  if (!_host || _inFlight || !_enabled) return
  _inFlight = true
  try {
    const snap = await getSnapshot()
    if (snap && _host) render(_host, snap)
  } catch {
    /* ignore */
  } finally {
    _inFlight = false
  }
}

function startTimer() {
  stopTimer()
  _timer = window.setInterval(() => void refresh(), 1000)
}

function stopTimer() {
  if (_timer) {
    window.clearInterval(_timer)
    _timer = null
  }
}

let _userDismissed = false

export function showPerfHud() {
  _userDismissed = false
  _enabled = true
  const host = ensureHost()
  host.style.display = ''
  void refresh()
  startTimer()
}

export function hidePerfHud(opts = {}) {
  if (opts.userDismissed) _userDismissed = true
  _enabled = false
  stopTimer()
  if (_host) {
    _host.style.display = 'none'
  }
}

export function syncPerfHudWithObsEnabled(enabled) {
  if (enabled) {
    if (_userDismissed) return
    showPerfHud()
  } else {
    _userDismissed = false
    hidePerfHud()
  }
}

/** Boot once: listen for debug/obs toggle + restore if already on. */
export function installPerfHud() {
  if (_installed) return
  _installed = true
  window.addEventListener(OBS_ENABLED_CHANGED_EVENT, (ev) => {
    const on = !!ev?.detail?.enabled
    syncPerfHudWithObsEnabled(on)
  })
  void import('../react/obs/lib/obs-api.js')
    .then((m) => m.fetchObsEnabledStatus())
    .then((st) => {
      syncPerfHudWithObsEnabled(!!st?.enabled)
    })
    .catch(() => {
      /* gateway may be down at boot */
    })
}
