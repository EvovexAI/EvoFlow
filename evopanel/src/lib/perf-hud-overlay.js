/**
 * 运维观测开启后的科技感性能浮窗：实时 CPU / 内存（本应用 + 本机 + LangGraph）。
 * 随 `evoflow:obs-enabled-changed` 显隐；可拖拽、可收起。
 */
import { api } from './tauri-api.js'
import { OBS_ENABLED_CHANGED_EVENT } from '../react/obs/lib/obs-api.js'

const HUD_ID = 'evoflow-perf-hud'
const HUD_SKIN = 'telemetry-v2'
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
  const r = 26
  const c = 2 * Math.PI * r
  const dash = (p / 100) * c
  return `<svg class="ef-hud-ring" viewBox="0 0 72 72" aria-hidden="true">
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(0,229,255,.12)" stroke-width="5"/>
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-linecap="butt" stroke-dasharray="${dash} ${c}"
      transform="rotate(-90 36 36)" style="filter:drop-shadow(0 0 4px ${color})"/>
  </svg>`
}

function barMeter(pct, color) {
  const p = clampPct(pct)
  return `<div class="ef-hud-bar" aria-hidden="true"><i style="width:${p.toFixed(1)}%;background:${color};box-shadow:0 0 10px ${color}"></i></div>`
}

function toneForPct(pct, warnAt = 80) {
  const p = clampPct(pct)
  if (p >= warnAt) return '#ff5c7a'
  if (p >= warnAt - 20) return '#ffc14d'
  return '#00e5ff'
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
        width:320px;user-select:none;
        font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,monospace;
        color:#d7f7ff;
        filter:drop-shadow(0 16px 40px rgba(0,0,0,.55));
      }
      #${HUD_ID} .ef-hud-shell{
        position:relative;overflow:hidden;
        clip-path:polygon(0 10px,10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%);
        background:
          linear-gradient(165deg,rgba(4,14,24,.96) 0%,rgba(6,22,36,.94) 48%,rgba(3,12,22,.97) 100%);
        border:1px solid rgba(0,229,255,.45);
        box-shadow:
          inset 0 0 0 1px rgba(0,229,255,.08),
          inset 0 1px 0 rgba(255,255,255,.08),
          0 0 24px rgba(0,229,255,.12);
      }
      #${HUD_ID} .ef-hud-shell::before{
        content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
        background:
          linear-gradient(90deg,rgba(0,229,255,.04) 1px,transparent 1px) 0 0 / 16px 16px,
          linear-gradient(0deg,rgba(0,229,255,.04) 1px,transparent 1px) 0 0 / 16px 16px,
          linear-gradient(180deg,rgba(0,229,255,.14),transparent 28%);
        opacity:.9;
      }
      #${HUD_ID} .ef-hud-shell::after{
        content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
        background:repeating-linear-gradient(
          180deg,
          transparent 0,transparent 2px,
          rgba(0,0,0,.12) 3px
        );
        mix-blend-mode:multiply;opacity:.35;
        animation:efHudScan 7s linear infinite;
      }
      @keyframes efHudScan{
        0%{transform:translateY(-8%)}
        100%{transform:translateY(8%)}
      }
      #${HUD_ID} .ef-hud-corner{
        position:absolute;width:12px;height:12px;z-index:2;pointer-events:none;
        border:2px solid #00e5ff;opacity:.85;
      }
      #${HUD_ID} .ef-hud-corner.tl{top:6px;left:6px;border-right:0;border-bottom:0}
      #${HUD_ID} .ef-hud-corner.tr{top:6px;right:6px;border-left:0;border-bottom:0}
      #${HUD_ID} .ef-hud-corner.bl{bottom:6px;left:6px;border-right:0;border-top:0}
      #${HUD_ID} .ef-hud-corner.br{bottom:6px;right:6px;border-left:0;border-top:0}
      #${HUD_ID} .ef-hud-head{
        position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;
        gap:8px;padding:14px 14px 8px;cursor:grab;
        border-bottom:1px solid rgba(0,229,255,.18);
      }
      #${HUD_ID} .ef-hud-head:active{cursor:grabbing}
      #${HUD_ID} .ef-hud-brand{display:flex;align-items:center;gap:10px;min-width:0}
      #${HUD_ID} .ef-hud-pulse{
        width:9px;height:9px;border-radius:1px;background:#00e5ff;transform:rotate(45deg);
        box-shadow:0 0 0 0 rgba(0,229,255,.65);
        animation:efHudPulse 1.4s ease-out infinite;flex:0 0 auto;
      }
      @keyframes efHudPulse{
        0%{box-shadow:0 0 0 0 rgba(0,229,255,.6);opacity:1}
        70%{box-shadow:0 0 0 9px rgba(0,229,255,0);opacity:.85}
        100%{box-shadow:0 0 0 0 rgba(0,229,255,0);opacity:1}
      }
      #${HUD_ID} .ef-hud-title{
        font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#00e5ff;font-weight:800;
        text-shadow:0 0 12px rgba(0,229,255,.45);
      }
      #${HUD_ID} .ef-hud-sub{
        font-size:10px;color:#8fd9ea;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        opacity:.92;
      }
      #${HUD_ID} .ef-hud-actions{display:flex;gap:6px;flex:0 0 auto}
      #${HUD_ID} .ef-hud-btn{
        border:1px solid rgba(0,229,255,.35);background:rgba(0,229,255,.08);
        color:#b8f4ff;border-radius:2px;width:28px;height:28px;cursor:pointer;font-size:13px;line-height:1;
      }
      #${HUD_ID} .ef-hud-btn:hover{
        border-color:#00e5ff;color:#fff;background:rgba(0,229,255,.2);
        box-shadow:0 0 12px rgba(0,229,255,.25);
      }
      #${HUD_ID} .ef-hud-body{position:relative;z-index:1;padding:10px 14px 14px}
      #${HUD_ID}.is-collapsed .ef-hud-body{display:none}
      #${HUD_ID} .ef-hud-gauges{
        display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;
      }
      #${HUD_ID} .ef-hud-gauge{
        position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;
        padding:10px 6px 8px;
        background:rgba(0,20,32,.72);
        border:1px solid rgba(0,229,255,.28);
        clip-path:polygon(0 6px,6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%);
      }
      #${HUD_ID} .ef-hud-ring-wrap{position:relative;width:72px;height:72px}
      #${HUD_ID} .ef-hud-ring{width:72px;height:72px;display:block}
      #${HUD_ID} .ef-hud-ring-val{
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        flex-direction:column;pointer-events:none;
      }
      #${HUD_ID} .ef-hud-ring-val strong{
        font-size:15px;color:#ffffff;font-weight:800;letter-spacing:-.02em;
        text-shadow:0 0 10px rgba(0,229,255,.35);
      }
      #${HUD_ID} .ef-hud-ring-val span{
        font-size:9px;color:#7ddcf0;letter-spacing:.14em;font-weight:700;
      }
      #${HUD_ID} .ef-hud-gauge-label{
        font-size:10px;color:#00e5ff;letter-spacing:.16em;font-weight:700;text-transform:uppercase;
      }
      #${HUD_ID} .ef-hud-rows{display:flex;flex-direction:column;gap:8px}
      #${HUD_ID} .ef-hud-row{
        display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;
        font-size:11px;padding:8px 10px;
        background:rgba(0,16,28,.78);
        border:1px solid rgba(0,229,255,.22);
        border-left:3px solid rgba(0,229,255,.55);
      }
      #${HUD_ID} .ef-hud-row.is-warn{
        border-color:rgba(255,92,122,.65);border-left-color:#ff5c7a;
        background:rgba(48,8,18,.55);
      }
      #${HUD_ID} .ef-hud-row .k{
        color:#9adcec;font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;
      }
      #${HUD_ID} .ef-hud-row .v{
        color:#ffffff;font-weight:800;white-space:nowrap;font-size:12px;
        text-shadow:0 0 8px rgba(0,229,255,.2);
      }
      #${HUD_ID} .ef-hud-row .ef-hud-bar{
        grid-column:1 / -1;height:4px;margin-top:2px;
        background:rgba(0,229,255,.12);overflow:hidden;
      }
      #${HUD_ID} .ef-hud-row .ef-hud-bar i{
        display:block;height:100%;min-width:2px;transition:width .35s ease;
      }
      #${HUD_ID} .ef-hud-foot{
        margin-top:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;
        padding-top:10px;border-top:1px solid rgba(0,229,255,.18);
      }
      #${HUD_ID} .ef-hud-link{
        border:1px solid rgba(0,229,255,.3);background:rgba(0,229,255,.06);
        color:#7ef0ff;font-size:10px;cursor:pointer;padding:4px 8px;
        font-family:inherit;letter-spacing:.04em;text-transform:uppercase;font-weight:700;
      }
      #${HUD_ID} .ef-hud-link:hover{
        border-color:#00e5ff;color:#fff;background:rgba(0,229,255,.18);
        box-shadow:0 0 14px rgba(0,229,255,.2);
      }
      #${HUD_ID} .ef-hud-tick{
        font-size:10px;color:#5ec8dc;letter-spacing:.06em;font-variant-numeric:tabular-nums;
      }
  `
}

function ensureHost() {
  if (_host && document.body.contains(_host)) {
    if (_host.dataset.hudSkin === HUD_SKIN) {
      const styleEl = _host.querySelector('style')
      if (styleEl) styleEl.textContent = hudCss()
      return _host
    }
    // Skin revision: rebuild DOM so new chrome (corners / bars) appears without refresh.
    const display = _host.style.display
    const left = _host.style.left
    const top = _host.style.top
    _host.remove()
    _host = null
    const rebuilt = ensureHost()
    if (display) rebuilt.style.display = display
    if (left) {
      rebuilt.style.left = left
      rebuilt.style.top = top || '0px'
      rebuilt.style.right = 'auto'
      rebuilt.style.bottom = 'auto'
    }
    return rebuilt
  }
  const host = document.createElement('div')
  host.id = HUD_ID
  host.innerHTML = `
    <style>${hudCss()}</style>
    <div class="ef-hud-shell" data-hud-shell>
      <i class="ef-hud-corner tl" aria-hidden="true"></i>
      <i class="ef-hud-corner tr" aria-hidden="true"></i>
      <i class="ef-hud-corner bl" aria-hidden="true"></i>
      <i class="ef-hud-corner br" aria-hidden="true"></i>
      <div class="ef-hud-head" data-hud-drag>
        <div class="ef-hud-brand">
          <i class="ef-hud-pulse" aria-hidden="true"></i>
          <div style="min-width:0">
            <div class="ef-hud-title">SYS TELEMETRY</div>
            <div class="ef-hud-sub" data-hud-sub>运维观测 · CPU/内存 · 对话链路看顶部信息条</div>
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
          <button type="button" class="ef-hud-link" data-hud-obs>观测台</button>
          <button type="button" class="ef-hud-link" data-hud-rm>资源</button>
          <span class="ef-hud-tick" data-hud-tick>—</span>
        </div>
      </div>
    </div>
  `
  host.dataset.hudSkin = HUD_SKIN
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

  const cpuTone = toneForPct(appCpu, 80)
  const memTone = toneForPct(sysMemPct, 85)
  const sysCpuTone = toneForPct(sysCpu, 85)
  const lgCpu = lg ? clampPct(lg.cpuPercent) : 0

  const cpuGauge = host.querySelector('[data-hud-cpu-gauge]')
  const memGauge = host.querySelector('[data-hud-mem-gauge]')
  if (cpuGauge) {
    cpuGauge.innerHTML = `
      <div class="ef-hud-ring-wrap">
        ${ringSvg(appCpu, cpuTone)}
        <div class="ef-hud-ring-val"><strong>${appCpu.toFixed(0)}%</strong><span>APP</span></div>
      </div>
      <div class="ef-hud-gauge-label">CPU</div>
    `
  }
  if (memGauge) {
    memGauge.innerHTML = `
      <div class="ef-hud-ring-wrap">
        ${ringSvg(sysMemPct, memTone)}
        <div class="ef-hud-ring-val"><strong>${sysMemPct.toFixed(0)}%</strong><span>SYS</span></div>
      </div>
      <div class="ef-hud-gauge-label">MEM</div>
    `
  }

  const rows = host.querySelector('[data-hud-rows]')
  if (rows) {
    rows.innerHTML = `
      <div class="ef-hud-row">
        <span class="k">Host CPU</span><span class="v">${sysCpu.toFixed(1)}%</span>
        ${barMeter(sysCpu, sysCpuTone)}
      </div>
      <div class="ef-hud-row">
        <span class="k">EvoFlow RSS</span>
        <span class="v">${formatBytes(appMem)}${sysTotal ? ` · ${appMemPct.toFixed(1)}%` : ''}</span>
        ${barMeter(appMemPct || Math.min(100, appMem / (512 * 1024 * 1024) * 100), toneForPct(appMemPct || 0, 40))}
      </div>
      <div class="ef-hud-row">
        <span class="k">Host MEM</span>
        <span class="v">${sysTotal ? `${formatBytes(sysUsed)} / ${formatBytes(sysTotal)}` : '—'}</span>
        ${barMeter(sysMemPct, memTone)}
      </div>
      <div class="ef-hud-row ${lgWarn ? 'is-warn' : ''}">
        <span class="k">LangGraph</span>
        <span class="v">${lg ? `${formatBytes(lg.memoryBytes)} · ${lgCpu.toFixed(1)}%` : 'OFFLINE'}</span>
        ${lg ? barMeter(Math.min(100, (lg.memoryBytes / (4 * 1024 * 1024 * 1024)) * 100), lgWarn ? '#ff5c7a' : '#00e5ff') : ''}
      </div>
    `
  }

  const sub = host.querySelector('[data-hud-sub]')
  if (sub) {
    const marker = snap?.instanceMarker || snap?.instance_marker || ''
    const n = (snap?.processes || []).length
    sub.textContent = marker
      ? `INST ${marker} · ${n} PROC · LIVE`
      : `TELEMETRY LIVE · ${n} PROC`
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
