/**
 * 主窗口资源管理器：自绘面板（不依赖 ZCode Tailwind 是否扫到类名）。
 * 顶栏问号 / 设置 / 托盘共用 openResourceManagerOverlay()。
 */
import { api } from './tauri-api.js'
import {
  fetchObsEnabledStatus,
  setObsEnabled,
} from '../react/obs/lib/obs-api.js'

let _host = null
let _timer = null
let _inFlight = false

function closeResourceManagerOverlay() {
  if (_timer) {
    window.clearInterval(_timer)
    _timer = null
  }
  try {
    _host?.remove()
  } catch {
    /* ignore */
  }
  _host = null
}

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

function formatPercent(v) {
  const n = Number.isFinite(v) ? v : 0
  return `${Math.max(0, Math.min(100, n)).toFixed(1)}%`
}

function parseProcessTable(text) {
  const processes = []
  const lines = String(text || '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^id\b/i.test(line) || /^---/.test(line) || /^user\b/i.test(line)) continue
    const win = line.match(/^(\d+)\s+(\S+)\s+([\d.]+)?\s+(\d+)/)
    if (win) {
      processes.push({
        pid: Number(win[1]),
        name: win[2],
        cpuPercent: 0,
        memoryBytes: Number(win[4]) || 0,
        groupLabel: /python|uvicorn|langgraph/i.test(win[2]) ? 'Gateway / Python' : 'EvoFlow',
      })
      continue
    }
    const parts = line.split(/\s+/)
    if (parts.length >= 11 && /^\d+$/.test(parts[1])) {
      const rss = Number(parts[5]) || 0
      processes.push({
        pid: Number(parts[1]),
        name: parts.slice(10).join(' ') || 'process',
        cpuPercent: Number(parts[2]) || 0,
        memoryBytes: rss > 0 && rss < 50_000_000 ? rss * 1024 : rss,
        groupLabel: 'EvoFlow',
      })
    }
  }
  return processes
}

async function getSnapshotFallback() {
  let text = ''
  try {
    text = await api.assistantListProcesses('evoflow')
  } catch {
    text = ''
  }
  if (!text || /未找到匹配/.test(text)) {
    try {
      text = await api.assistantListProcesses('python')
    } catch {
      try {
        text = await api.assistantListProcesses(null)
      } catch {
        text = ''
      }
    }
  }
  const processes = parseProcessTable(text)
  const memoryBytes = processes.reduce((s, p) => s + (p.memoryBytes || 0), 0)
  const cpuPercent = processes.reduce((s, p) => s + (p.cpuPercent || 0), 0)
  return {
    sampledAt: Date.now(),
    logicalCpuCount: navigator.hardwareConcurrency || 1,
    system: { cpuPercent: 0, memoryTotalBytes: 0, memoryUsedBytes: 0 },
    app: { cpuPercent, memoryBytes },
    processes: processes.map((p) => ({
      ...p,
      category: 'base',
      groupKey: 'main',
      sampled: true,
    })),
  }
}

async function getSnapshot() {
  try {
    return await api.getResourceUsageSnapshot()
  } catch {
    return getSnapshotFallback()
  }
}

function meterHtml(label, appText, systemText, appPct, systemPct) {
  const a = Math.max(0, Math.min(100, Number(appPct) || 0))
  const s = Math.max(0, Math.min(100, Number(systemPct) || 0))
  return `
    <div class="ef-rm-card">
      <div class="ef-rm-card-title">${label}</div>
      <div class="ef-rm-meter-row">
        <span>EvoFlow</span><strong>${appText}</strong>
      </div>
      <div class="ef-rm-bar"><i style="width:${a}%"></i></div>
      <div class="ef-rm-meter-row">
        <span>本机</span><strong>${systemText}</strong>
      </div>
      <div class="ef-rm-bar ef-rm-bar--sys"><i style="width:${s}%"></i></div>
    </div>
  `
}

function renderSnapshot(body, snapshot, error, metric) {
  if (error) {
    body.innerHTML = `<div class="ef-rm-error">${error}</div>`
    return
  }
  if (!snapshot) {
    body.innerHTML = `<div class="ef-rm-loading">正在读取资源占用…</div>`
    return
  }
  const processes = [...(snapshot.processes || [])].sort(
    (a, b) =>
      (b.cpuPercent || 0) - (a.cpuPercent || 0) ||
      (b.memoryBytes || 0) - (a.memoryBytes || 0),
  )
  const appCpu = snapshot.app?.cpuPercent ?? 0
  const sysCpu = snapshot.system?.cpuPercent ?? 0
  const appMem = snapshot.app?.memoryBytes ?? 0
  const sysUsed = snapshot.system?.memoryUsedBytes ?? 0
  const sysTotal = snapshot.system?.memoryTotalBytes ?? 0
  const memPct =
    sysTotal > 0 ? (appMem / sysTotal) * 100 : 0
  const sysMemPct = sysTotal > 0 ? (sysUsed / sysTotal) * 100 : 0

  const left =
    metric === 'memory'
      ? meterHtml(
          '内存',
          formatBytes(appMem),
          sysTotal > 0 ? `${formatBytes(sysUsed)} / ${formatBytes(sysTotal)}` : '—',
          memPct,
          sysMemPct,
        )
      : meterHtml('CPU', formatPercent(appCpu), formatPercent(sysCpu), appCpu, sysCpu)

  const rows = processes
    .map((p) => {
      const value =
        metric === 'memory' ? formatBytes(p.memoryBytes || 0) : formatPercent(p.cpuPercent || 0)
      return `<tr>
        <td class="ef-rm-name">${escapeHtml(p.name || 'process')}</td>
        <td class="ef-rm-pid">${p.pid ?? '—'}</td>
        <td class="ef-rm-group">${escapeHtml(p.groupLabel || p.category || '')}</td>
        <td class="ef-rm-val">${p.sampled === false ? '—' : value}</td>
      </tr>`
    })
    .join('')

  const byGroup = {}
  for (const p of processes) {
    const g = p.groupLabel || p.category || '其他'
    byGroup[g] = (byGroup[g] || 0) + 1
  }
  const groupSummary = Object.entries(byGroup)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')

  body.innerHTML = `
    <div class="ef-rm-grid">
      ${left}
      <div class="ef-rm-table-wrap">
        <div class="ef-rm-table-head">
          归属 EvoFlow 的进程（${processes.length}）
          <div class="ef-rm-table-sub">${escapeHtml(groupSummary || '暂无')}；电脑插件多为进程内能力，不一定有独立 PID</div>
        </div>
        <table class="ef-rm-table">
          <thead><tr><th>进程</th><th>PID</th><th>分组</th><th>${metric === 'memory' ? '内存' : 'CPU'}</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">暂无进程</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `
}

function applyDebugSwitch(host, { enabled, lockedByEnv, busy }) {
  const btn = host?.querySelector?.('[data-rm-debug-toggle]')
  if (!btn) return
  btn.classList.toggle('is-on', !!enabled)
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false')
  btn.disabled = !!(busy || lockedByEnv)
  btn.title = lockedByEnv
    ? '被环境变量 EVOFLOW_OBSERVABILITY 锁定'
    : '开启后对话摘要显示可点击的调试信息'
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export { closeResourceManagerOverlay }

/** 在主窗口打开资源管理器面板 */
export async function openResourceManagerOverlay() {
  closeResourceManagerOverlay()

  const host = document.createElement('div')
  host.id = 'evoflow-resource-manager-overlay'
  host.innerHTML = `
    <style>
      #evoflow-resource-manager-overlay{
        position:fixed;inset:0;z-index:2147483000;
        display:flex;align-items:center;justify-content:center;
        background:rgba(15,18,28,.45);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      }
      #evoflow-resource-manager-overlay .ef-rm-panel{
        width:min(960px,94vw);height:min(680px,90vh);
        background:#f7f8fc;color:#12141a;border-radius:14px;
        box-shadow:0 24px 80px rgba(0,0,0,.28);
        display:flex;flex-direction:column;overflow:hidden;
      }
      #evoflow-resource-manager-overlay .ef-rm-top{
        display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:12px 16px;border-bottom:1px solid #e6e8ef;background:#fff;flex:0 0 auto;
      }
      #evoflow-resource-manager-overlay .ef-rm-title{font-size:15px;font-weight:650}
      #evoflow-resource-manager-overlay .ef-rm-sub{font-size:12px;color:#6b7280;margin-top:2px}
      #evoflow-resource-manager-overlay .ef-rm-tabs{display:flex;gap:6px}
      #evoflow-resource-manager-overlay .ef-rm-tab{
        border:0;background:#eef0f6;color:#374151;border-radius:999px;
        padding:6px 12px;font-size:12px;cursor:pointer;
      }
      #evoflow-resource-manager-overlay .ef-rm-tab.is-active{background:#4f46e5;color:#fff}
      #evoflow-resource-manager-overlay .ef-rm-close{
        border:1px solid #d7dbe7;background:#fff;border-radius:8px;
        padding:6px 12px;cursor:pointer;font-size:13px;
      }
      #evoflow-resource-manager-overlay .ef-rm-body{flex:1;min-height:0;overflow:auto;padding:16px}
      #evoflow-resource-manager-overlay .ef-rm-grid{
        display:grid;grid-template-columns:260px minmax(0,1fr);gap:14px;
      }
      @media (max-width:800px){
        #evoflow-resource-manager-overlay .ef-rm-grid{grid-template-columns:1fr}
      }
      #evoflow-resource-manager-overlay .ef-rm-card{
        background:#fff;border:1px solid #e6e8ef;border-radius:12px;padding:14px;
      }
      #evoflow-resource-manager-overlay .ef-rm-card-title{font-weight:650;margin-bottom:12px}
      #evoflow-resource-manager-overlay .ef-rm-meter-row{
        display:flex;justify-content:space-between;font-size:12px;margin:8px 0 4px;color:#4b5563;
      }
      #evoflow-resource-manager-overlay .ef-rm-bar{
        height:8px;background:#eef0f6;border-radius:999px;overflow:hidden;
      }
      #evoflow-resource-manager-overlay .ef-rm-bar > i{
        display:block;height:100%;background:#4f46e5;border-radius:999px;
      }
      #evoflow-resource-manager-overlay .ef-rm-bar--sys > i{background:#64748b}
      #evoflow-resource-manager-overlay .ef-rm-table-wrap{
        background:#fff;border:1px solid #e6e8ef;border-radius:12px;overflow:auto;min-height:280px;
      }
      #evoflow-resource-manager-overlay .ef-rm-table-head{
        padding:12px 14px;font-weight:650;border-bottom:1px solid #eef0f6;
      }
      #evoflow-resource-manager-overlay .ef-rm-table-sub{
        margin-top:4px;font-size:12px;font-weight:500;color:#6b7280;
      }
      #evoflow-resource-manager-overlay .ef-rm-table{width:100%;border-collapse:collapse;font-size:13px}
      #evoflow-resource-manager-overlay .ef-rm-table th,
      #evoflow-resource-manager-overlay .ef-rm-table td{
        text-align:left;padding:10px 12px;border-bottom:1px solid #f1f3f8;vertical-align:top;
      }
      #evoflow-resource-manager-overlay .ef-rm-table th{color:#6b7280;font-weight:600;font-size:12px}
      #evoflow-resource-manager-overlay .ef-rm-name{word-break:break-all}
      #evoflow-resource-manager-overlay .ef-rm-pid,#evoflow-resource-manager-overlay .ef-rm-val{white-space:nowrap}
      #evoflow-resource-manager-overlay .ef-rm-group{color:#6b7280}
      #evoflow-resource-manager-overlay .ef-rm-error{
        background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;padding:12px 14px;
      }
      #evoflow-resource-manager-overlay .ef-rm-loading{color:#6b7280;padding:24px;text-align:center}
      #evoflow-resource-manager-overlay .ef-rm-debug{
        margin:0 16px 16px;background:#fff;border:1px solid #e6e8ef;border-radius:12px;padding:12px 14px;flex:0 0 auto;
      }
      #evoflow-resource-manager-overlay .ef-rm-debug-row{
        display:flex;align-items:center;justify-content:space-between;gap:12px;
      }
      #evoflow-resource-manager-overlay .ef-rm-debug-title{font-weight:650;font-size:13px}
      #evoflow-resource-manager-overlay .ef-rm-debug-hint{margin-top:2px;font-size:12px;color:#6b7280}
      #evoflow-resource-manager-overlay .ef-rm-switch{
        width:40px;height:22px;border:none;border-radius:999px;background:#d1d5db;cursor:pointer;padding:0;position:relative;flex-shrink:0;
      }
      #evoflow-resource-manager-overlay .ef-rm-switch > i{
        position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;
        box-shadow:0 1px 2px rgba(15,23,42,.25);transition:transform .15s ease;
      }
      #evoflow-resource-manager-overlay .ef-rm-switch.is-on{background:#4f46e5}
      #evoflow-resource-manager-overlay .ef-rm-switch.is-on > i{transform:translateX(18px)}
      #evoflow-resource-manager-overlay .ef-rm-switch:disabled{opacity:.55;cursor:not-allowed}
      #evoflow-resource-manager-overlay .ef-rm-ops-link{
        margin-top:10px;border:none;background:transparent;color:#4f46e5;font-size:13px;cursor:pointer;padding:0;
      }
      #evoflow-resource-manager-overlay .ef-rm-ops-link:hover{text-decoration:underline}
    </style>
    <div class="ef-rm-panel" role="dialog" aria-modal="true" aria-label="资源管理器">
      <div class="ef-rm-top">
        <div>
          <div class="ef-rm-title">资源管理器</div>
          <div class="ef-rm-sub" data-rm-sub>读取中…</div>
        </div>
        <div class="ef-rm-tabs">
          <button type="button" class="ef-rm-tab is-active" data-rm-tab="cpu">CPU</button>
          <button type="button" class="ef-rm-tab" data-rm-tab="memory">内存</button>
        </div>
        <button type="button" class="ef-rm-close" data-rm-close>关闭</button>
      </div>
      <div class="ef-rm-body" data-rm-body></div>
      <div class="ef-rm-debug" data-rm-debug>
        <div class="ef-rm-debug-row">
          <div class="ef-rm-debug-copy">
            <div class="ef-rm-debug-title">开启调试模式</div>
            <div class="ef-rm-debug-hint">开启后对话摘要会出现可点击的「调试」信息</div>
          </div>
          <button type="button" class="ef-rm-switch" data-rm-debug-toggle aria-pressed="false" title="开启调试模式">
            <i></i>
          </button>
        </div>
        <button type="button" class="ef-rm-ops-link" data-rm-ops>进入运维观测 →</button>
      </div>
    </div>
  `
  document.body.appendChild(host)
  _host = host

  let metric = 'cpu'
  let debugOn = false
  let debugLocked = false
  let debugBusy = false
  const body = host.querySelector('[data-rm-body]')
  const sub = host.querySelector('[data-rm-sub]')
  const tabs = [...host.querySelectorAll('[data-rm-tab]')]

  const syncDebugUi = () => applyDebugSwitch(host, { enabled: debugOn, lockedByEnv: debugLocked, busy: debugBusy })

  const onKey = (e) => {
    if (e.key === 'Escape') {
      window.removeEventListener('keydown', onKey)
      closeResourceManagerOverlay()
    }
  }
  window.addEventListener('keydown', onKey)

  host.querySelector('[data-rm-close]')?.addEventListener('click', () => {
    window.removeEventListener('keydown', onKey)
    closeResourceManagerOverlay()
  })
  host.addEventListener('click', (e) => {
    if (e.target === host) {
      window.removeEventListener('keydown', onKey)
      closeResourceManagerOverlay()
    }
  })
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      metric = btn.getAttribute('data-rm-tab') || 'cpu'
      tabs.forEach((b) => b.classList.toggle('is-active', b === btn))
      void refresh()
    })
  })

  host.querySelector('[data-rm-ops]')?.addEventListener('click', () => {
    window.removeEventListener('keydown', onKey)
    closeResourceManagerOverlay()
    window.location.hash = '/observability'
  })

  host.querySelector('[data-rm-debug-toggle]')?.addEventListener('click', () => {
    if (debugBusy || debugLocked) return
    const next = !debugOn
    debugBusy = true
    syncDebugUi()
    void import('../react/obs/lib/obs-api.js')
      .then(async (m) => {
        const st = await m.setObsEnabled(next)
        debugOn = !!st.enabled
        debugLocked = !!st.lockedByEnv
        try {
          const { toast } = await import('../components/toast.js')
          toast(
            st.enabled
              ? '调试模式已开启：对话摘要会出现可点击的「调试」'
              : '调试模式已关闭',
            'success',
          )
        } catch {
          /* ignore */
        }
      })
      .catch(async (e) => {
        const msg = String(e?.message || e || '')
        try {
          const { toast } = await import('../components/toast.js')
          if (/org_admin|403|forbidden/i.test(msg)) {
            toast('需要管理员权限才能开启调试模式', 'error')
          } else if (/locked_by_env|EVOFLOW_OBSERVABILITY/i.test(msg)) {
            debugLocked = true
            toast('调试模式被环境变量锁定，无法在界面切换', 'error')
          } else {
            toast(`切换调试模式失败：${msg || 'unknown'}`, 'error')
          }
        } catch {
          /* ignore */
        }
      })
      .finally(() => {
        debugBusy = false
        syncDebugUi()
      })
  })

  void import('../react/obs/lib/obs-api.js')
    .then((m) => m.fetchObsEnabledStatus())
    .then((st) => {
      debugOn = !!st.enabled
      debugLocked = !!st.lockedByEnv
      syncDebugUi()
    })
    .catch(() => syncDebugUi())

  let lastSnapshot = null
  async function refresh() {
    if (_inFlight) return
    _inFlight = true
    try {
      const snap = await getSnapshot()
      lastSnapshot = snap
      if (sub) {
        const marker = snap.instanceMarker || snap.instance_marker || ''
        const profile = snap.instanceProfile || snap.instance_profile || ''
        const tag = marker || profile ? `实例 ${marker || profile} · ` : ''
        sub.textContent = `${tag}仅本客户端进程树 ${snap.processes?.length || 0} 个 · 每秒刷新`
      }
      renderSnapshot(body, snap, null, metric)
    } catch (e) {
      const msg = e?.message || String(e)
      if (sub) sub.textContent = '读取失败'
      renderSnapshot(body, lastSnapshot, msg, metric)
    } finally {
      _inFlight = false
    }
  }

  renderSnapshot(body, null, null, metric)
  await refresh()
  _timer = window.setInterval(() => void refresh(), 1000)
}
