/**
 * 运维观测浮窗：三块人话状态卡（总览 / 对话能不能聊 / 本机负载）。
 * 不堆截断数字；卡住会写清「前端没发出 / 后端没开跑 / 等模型首字」。
 * 随 `evoflow:obs-enabled-changed` 显隐；可拖拽、可收起。
 */
import { api } from './tauri-api.js'
import { OBS_ENABLED_CHANGED_EVENT } from '../react/obs/lib/obs-api.js'

const HUD_ID = 'evoflow-perf-hud'
const HUD_SKIN = 'telemetry-v4-plain-dragsafe'
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

/** 标题栏 / 窗缘安全边距：顶边太贴时会被 Tauri drag-region 抢走指针，拖不动。 */
const HUD_EDGE = 8
const HUD_SAFE_TOP = 44

function clampHudPos(left, top, host) {
  const w = Math.max(120, host?.offsetWidth || 320)
  const h = Math.max(40, host?.offsetHeight || 80)
  const maxL = Math.max(HUD_EDGE, window.innerWidth - w - HUD_EDGE)
  const maxT = Math.max(HUD_SAFE_TOP, window.innerHeight - h - HUD_EDGE)
  return {
    left: Math.min(maxL, Math.max(HUD_EDGE, Number(left) || HUD_EDGE)),
    top: Math.min(maxT, Math.max(HUD_SAFE_TOP, Number(top) || HUD_SAFE_TOP)),
  }
}

function applyHudPos(host, left, top) {
  const p = clampHudPos(left, top, host)
  host.style.left = `${p.left}px`
  host.style.top = `${p.top}px`
  host.style.right = 'auto'
  host.style.bottom = 'auto'
  return p
}

function resetHudPos(host) {
  host.style.left = 'auto'
  host.style.top = 'auto'
  host.style.right = '18px'
  host.style.bottom = '18px'
  try {
    localStorage.removeItem(POS_KEY)
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
        width:360px;user-select:none;
        font-family:"Segoe UI","PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif;
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
        font-size:13px;letter-spacing:.06em;color:#00e5ff;font-weight:800;
        text-shadow:0 0 12px rgba(0,229,255,.45);
      }
      #${HUD_ID} .ef-hud-sub{
        font-size:11px;color:#b6eaf5;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        opacity:.95;font-variant-numeric:tabular-nums;
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
      #${HUD_ID} .ef-hud-cards{display:flex;flex-direction:column;gap:10px}
      #${HUD_ID} .ef-hud-card{
        padding:12px 12px 10px;
        background:rgba(0,16,28,.82);
        border:1px solid rgba(0,229,255,.25);
        border-left:4px solid rgba(0,229,255,.55);
      }
      #${HUD_ID} .ef-hud-card.is-ok{border-left-color:#34d399}
      #${HUD_ID} .ef-hud-card.is-warn{border-left-color:#ffc14d;background:rgba(40,28,8,.55)}
      #${HUD_ID} .ef-hud-card.is-bad{border-left-color:#ff5c7a;background:rgba(48,8,18,.55)}
      #${HUD_ID} .ef-hud-card-h{
        display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;
      }
      #${HUD_ID} .ef-hud-card-h .t{font-size:12px;color:#9adcec;font-weight:700}
      #${HUD_ID} .ef-hud-card-h .s{
        font-size:13px;font-weight:800;color:#fff;white-space:nowrap;
      }
      #${HUD_ID} .ef-hud-card.is-ok .s{color:#6ee7b7}
      #${HUD_ID} .ef-hud-card.is-warn .s{color:#ffc14d}
      #${HUD_ID} .ef-hud-card.is-bad .s{color:#fda4af}
      #${HUD_ID} .ef-hud-card-p{
        font-size:12px;line-height:1.55;color:#d7f7ff;word-break:break-word;
      }
      #${HUD_ID} .ef-hud-card-p em{
        font-style:normal;color:#7ddcf0;font-weight:700;
      }
      #${HUD_ID} .ef-hud-foot{
        margin-top:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;
        padding-top:10px;border-top:1px solid rgba(0,229,255,.18);
      }
      #${HUD_ID} .ef-hud-link{
        border:1px solid rgba(0,229,255,.3);background:rgba(0,229,255,.06);
        color:#7ef0ff;font-size:11px;cursor:pointer;padding:4px 8px;
        font-family:inherit;font-weight:700;
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
    const hadCustomPos = left && left !== 'auto'
    const prevLeft = hadCustomPos ? parseFloat(left) : null
    const prevTop = hadCustomPos ? parseFloat(top || '0') : null
    _host.remove()
    _host = null
    const rebuilt = ensureHost()
    if (display) rebuilt.style.display = display
    if (hadCustomPos && Number.isFinite(prevLeft) && Number.isFinite(prevTop)) {
      applyHudPos(rebuilt, prevLeft, prevTop)
    }
    return rebuilt
  }
  const host = document.createElement('div')
  host.id = HUD_ID
  // 整窗禁止 Tauri 标题栏拖拽抢事件；否则贴顶后标题条拖不动浮窗、只拖窗口
  host.setAttribute('data-tauri-no-drag', '')
  host.innerHTML = `
    <style>${hudCss()}</style>
    <div class="ef-hud-shell" data-hud-shell data-tauri-no-drag>
      <i class="ef-hud-corner tl" aria-hidden="true"></i>
      <i class="ef-hud-corner tr" aria-hidden="true"></i>
      <i class="ef-hud-corner bl" aria-hidden="true"></i>
      <i class="ef-hud-corner br" aria-hidden="true"></i>
      <div class="ef-hud-head" data-hud-drag data-tauri-no-drag>
        <div class="ef-hud-brand">
          <i class="ef-hud-pulse" aria-hidden="true"></i>
          <div style="min-width:0">
            <div class="ef-hud-title">本机运行监控</div>
            <div class="ef-hud-sub" data-hud-sub>采样中…</div>
          </div>
        </div>
        <div class="ef-hud-actions" data-tauri-no-drag>
          <button type="button" class="ef-hud-btn" data-hud-reset title="复位到右下角">↺</button>
          <button type="button" class="ef-hud-btn" data-hud-collapse title="收起/展开">–</button>
          <button type="button" class="ef-hud-btn" data-hud-close title="关闭浮窗（运维观测仍开启）">×</button>
        </div>
      </div>
      <div class="ef-hud-body" data-hud-body data-hud-drag-secondary>
        <div class="ef-hud-cards" data-hud-cards></div>
        <div class="ef-hud-foot">
          <button type="button" class="ef-hud-link" data-hud-obs>运维观测</button>
          <button type="button" class="ef-hud-link" data-hud-life>回合日志</button>
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
    applyHudPos(host, pos.left, pos.top)
  }
  // 新皮肤默认展开，避免只剩一行标题啥都看不见
  setCollapsed(false)
  host.classList.remove('is-collapsed')

  host.querySelector('[data-hud-collapse]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const next = !host.classList.contains('is-collapsed')
    host.classList.toggle('is-collapsed', next)
    setCollapsed(next)
    // 收起后高度变小，重新夹紧以免贴死顶边
    if (host.style.left && host.style.left !== 'auto') {
      const r = host.getBoundingClientRect()
      const p = applyHudPos(host, r.left, r.top)
      savePos(p.left, p.top)
    }
  })
  host.querySelector('[data-hud-close]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    hidePerfHud({ userDismissed: true })
  })
  host.querySelector('[data-hud-reset]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    resetHudPos(host)
  })
  host.querySelector('[data-hud-obs]')?.addEventListener('click', () => {
    window.location.hash = '/observability'
  })
  host.querySelector('[data-hud-life]')?.addEventListener('click', () => {
    window.location.hash = '/system-logs?source=chat-turn-lifecycle'
  })

  const beginDrag = (e, captureEl) => {
    if (e.button !== 0) return
    if (e.target?.closest?.('.ef-hud-btn, .ef-hud-link, a, button')) return
    const rect = host.getBoundingClientRect()
    _drag = {
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      pointerId: e.pointerId,
    }
    try {
      captureEl.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const onDragMove = (e) => {
    if (!_drag || _drag.pointerId !== e.pointerId) return
    applyHudPos(host, e.clientX - _drag.ox, e.clientY - _drag.oy)
  }
  const endDrag = (e) => {
    if (!_drag || (_drag.pointerId != null && e.pointerId !== _drag.pointerId)) return
    const rect = host.getBoundingClientRect()
    const p = applyHudPos(host, rect.left, rect.top)
    savePos(p.left, p.top)
    _drag = null
  }
  const bindDrag = (el) => {
    if (!el) return
    el.addEventListener('pointerdown', (e) => beginDrag(e, el))
    el.addEventListener('pointermove', onDragMove)
    el.addEventListener('pointerup', endDrag)
    el.addEventListener('pointercancel', endDrag)
  }
  bindDrag(host.querySelector('[data-hud-drag]'))
  // 标题被顶栏挡住时，可从卡片区拖走
  bindDrag(host.querySelector('[data-hud-drag-secondary]'))

  window.addEventListener(
    'resize',
    () => {
      if (!host.style.left || host.style.left === 'auto') return
      const r = host.getBoundingClientRect()
      const p = applyHudPos(host, r.left, r.top)
      savePos(p.left, p.top)
    },
    { passive: true },
  )

  return host
}

async function readChatOpsSnapshot() {
  try {
    const [{ getActiveChatTurnStall, listChatTurnAnomalies }, { isSessionHistoryWatchActive }] =
      await Promise.all([
        import('../react/lib/chat-turn-timing-log.js'),
        import('../react/lib/session-reattach.js'),
      ])
    const sk = String(
      (typeof window !== 'undefined' && window.__evoflowSelectedSessionKey) || '',
    ).trim()
    const stall = getActiveChatTurnStall(sk || null)
    const anomalies = listChatTurnAnomalies()
    const deadCount = anomalies.filter((a) => a.event === 'first_token_dead').length
    const stallCount = anomalies.filter((a) => a.event === 'first_token_stall').length
    const watch = sk ? isSessionHistoryWatchActive(sk) : false
    const latest = anomalies.length ? anomalies[anomalies.length - 1] : null
    return {
      sk,
      stall,
      watch,
      deadCount,
      stallCount,
      anomalyCount: anomalies.length,
      latestZh: latest?.zh || '',
    }
  } catch {
    return null
  }
}

async function probeAgentRuntime() {
  const ports = [8384, 2024, 8123]
  for (const port of ports) {
    try {
      const ctrl = new AbortController()
      const t = window.setTimeout(() => ctrl.abort(), 700)
      const res = await fetch(`http://127.0.0.1:${port}/ok`, {
        signal: ctrl.signal,
        cache: 'no-store',
      })
      window.clearTimeout(t)
      if (res.ok) return { ok: true, port, label: `在线 · :${port}` }
    } catch {
      /* try next */
    }
  }
  return { ok: false, port: null, label: '不可达' }
}

function loadLevel(cpu, memPct) {
  if (cpu >= 85 || memPct >= 90) return { cls: 'is-bad', s: '偏高', tip: '机器负载偏高，对话可能变慢' }
  if (cpu >= 65 || memPct >= 80) return { cls: 'is-warn', s: '略高', tip: '机器有点忙，一般还能聊' }
  return { cls: 'is-ok', s: '正常', tip: '本机 CPU / 内存都还好' }
}

function chatVerdict(chatOps, lgProbe) {
  if (!lgProbe?.ok) {
    return {
      cls: 'is-bad',
      s: '聊不了',
      tip: '对话引擎没起来（Agent 运行时探测失败）。先看网关 / LangGraph 是否在跑。',
    }
  }
  const stall = chatOps?.stall
  if (stall?.stalled) {
    const sec = Math.round(stall.sinceMs / 1000)
    const stage =
      stall.stage === 'fe_prep'
        ? '前端还没把消息发出去'
        : stall.stage === 'be_accept'
          ? '消息已发出，后端还没开跑'
          : stall.stage === 'await_first_token'
            ? '后端已开跑，还在等模型吐出第一个字'
            : '还在等回复'
    if (sec >= 30) {
      return {
        cls: 'is-bad',
        s: `卡住 ${sec} 秒`,
        tip: `${stage}。已记入「回合日志」，可点下面按钮查看。`,
      }
    }
    return {
      cls: 'is-warn',
      s: `等待中 ${sec} 秒`,
      tip: `${stage}。再等等；超过约 30 秒会记成异常。`,
    }
  }
  if (chatOps?.watch) {
    return {
      cls: 'is-ok',
      s: '旁观轮询',
      tip: '当前不是本机实时流，在定时拉历史（常见于飞书等渠道旁观）。',
    }
  }
  if ((chatOps?.deadCount || 0) > 0) {
    return {
      cls: 'is-warn',
      s: '曾超时',
      tip: `本机已记下 ${chatOps.deadCount} 次「发了很久没出字」。点「回合日志」看详情。`,
    }
  }
  return {
    cls: 'is-ok',
    s: '可对话',
    tip: '引擎在线。发消息后若迟迟无字，这里会改成「等待中 / 卡住」。',
  }
}

function render(host, snap, chatOps, lgProbe) {
  const appCpu = clampPct(snap?.app?.cpuPercent)
  const sysCpu = clampPct(snap?.system?.cpuPercent)
  const appMem = Number(snap?.app?.memoryBytes) || 0
  const sysUsed = Number(snap?.system?.memoryUsedBytes) || 0
  const sysTotal = Number(snap?.system?.memoryTotalBytes) || 0
  const sysMemPct = sysTotal > 0 ? (sysUsed / sysTotal) * 100 : 0
  const lg = pickLanggraph(snap?.processes)
  const load = loadLevel(Math.max(appCpu, sysCpu), sysMemPct)
  const chat = chatVerdict(chatOps, lgProbe)

  let overall = { cls: 'is-ok', s: '一切正常', tip: '本机与对话引擎看起来都正常。' }
  if (chat.cls === 'is-bad' || load.cls === 'is-bad') {
    overall = {
      cls: 'is-bad',
      s: '有问题',
      tip: chat.cls === 'is-bad' ? chat.tip : load.tip,
    }
  } else if (chat.cls === 'is-warn' || load.cls === 'is-warn') {
    overall = {
      cls: 'is-warn',
      s: '需留意',
      tip: chat.cls === 'is-warn' ? chat.tip : load.tip,
    }
  }

  const cards = host.querySelector('[data-hud-cards]')
  if (cards) {
    const memLine = sysTotal
      ? `本机内存约用了 ${sysMemPct.toFixed(0)}%（${formatBytes(sysUsed)} / ${formatBytes(sysTotal)}）`
      : `本应用内存 ${formatBytes(appMem)}`
    const lgLine = lgProbe?.ok
      ? `对话引擎在线（端口 ${lgProbe.port}）${lg ? `，占用 ${formatBytes(lg.memoryBytes)}` : ''}`
      : '对话引擎探测失败——这通常就是「发了没回」的根因之一'
    cards.innerHTML = `
      <div class="ef-hud-card ${overall.cls}">
        <div class="ef-hud-card-h"><span class="t">总览</span><span class="s">${overall.s}</span></div>
        <div class="ef-hud-card-p">${overall.tip}</div>
      </div>
      <div class="ef-hud-card ${chat.cls}">
        <div class="ef-hud-card-h"><span class="t">对话</span><span class="s">${chat.s}</span></div>
        <div class="ef-hud-card-p">${chat.tip}<br/><em>${lgLine}</em></div>
      </div>
      <div class="ef-hud-card ${load.cls}">
        <div class="ef-hud-card-h"><span class="t">本机负载</span><span class="s">${load.s}</span></div>
        <div class="ef-hud-card-p">${load.tip}<br/>CPU 约 ${Math.max(appCpu, sysCpu).toFixed(0)}% · ${memLine}</div>
      </div>
    `
  }

  const sub = host.querySelector('[data-hud-sub]')
  if (sub) {
    sub.textContent = `${overall.s} · 对话${chat.s} · 负载${load.s}`
  }
  const tick = host.querySelector('[data-hud-tick]')
  if (tick) tick.textContent = new Date().toLocaleTimeString()
}

async function refresh() {
  if (!_host || _inFlight || !_enabled) return
  _inFlight = true
  try {
    const [snap, chatOps, lgProbe] = await Promise.all([
      getSnapshot(),
      readChatOpsSnapshot(),
      probeAgentRuntime(),
    ])
    if (_host) render(_host, snap || {}, chatOps, lgProbe)
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

/**
 * 「本机运行监控」已退役：调试态改看 V4 视口调试浮层（运行 SSE / 旁观轮询）。
 * 保留 API 以免旧调用炸；永远隐藏。
 */
export function syncPerfHudWithObsEnabled(_enabled) {
  _userDismissed = false
  hidePerfHud()
}

/** Boot once: ensure any leftover HUD is hidden. */
export function installPerfHud() {
  if (_installed) return
  _installed = true
  hidePerfHud()
  window.addEventListener(OBS_ENABLED_CHANGED_EVENT, () => {
    hidePerfHud()
  })
}
