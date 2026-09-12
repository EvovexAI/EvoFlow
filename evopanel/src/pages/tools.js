/**
 * 连接器页（MCP）— 已安装 / 市场
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm, showModal } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import {
  closeDrawer,
  esc,
  openDrawer,
  renderModuleSubtabs,
  selectHtml,
  setBtnState,
} from './expert-center-shared.js'

function unwrapMcpServers(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const inner = parsed.mcpServers || parsed.mcp_servers
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    const values = Object.values(inner)
    if (values.length && values.every((v) => v && typeof v === 'object')) return inner
  }
  const out = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (key === 'mcpServers' || key === 'mcp_servers' || key === 'skills') continue
    if (val && typeof val === 'object' && (val.command || val.url || val.args)) out[key] = val
  }
  return Object.keys(out).length ? out : parsed
}

let _loadSeq = 0
let _statusPollTimer = null

const STATUS_UI = {
  ready: { key: 'ready', label: '可用' },
  disabled: { key: 'disabled', label: '已停用' },
  pending: { key: 'pending', label: '连接中' },
  error: { key: 'error', label: '连接失败' },
  auth: { key: 'auth', label: '需要认证' },
  config: { key: 'config', label: '配置异常' },
}

const STATUS_FILTERS = [
  { key: 'ready', label: '可用' },
  { key: 'disabled', label: '已停用' },
  { key: 'pending', label: '连接中' },
  { key: 'error', label: '连接失败' },
  { key: 'auth', label: '需要认证' },
  { key: 'config', label: '配置异常' },
]

const MCP_ICON_MAP = [
  [/filesystem|file|local/i, '📁'],
  [/fetch|web|http|request/i, '🌐'],
  [/brave-search|search|google|bing/i, '🔍'],
  [/github|git|repo|commit/i, '💻'],
  [/slack|discord|chat|message/i, '💬'],
  [/database|postgres|mysql|mongo|sqlite|supabase/i, '🗄️'],
  [/memory|context|store|redis/i, '🧠'],
  [/puppeteer|playwright|browser/i, '🌍'],
  [/aws|azure|gcp|cloud/i, '☁️'],
  [/docker|k8s|kubernetes/i, '🐳'],
  [/notion|obsidian|wiki/i, '📝'],
  [/everything|mcp|server|tool/i, '🔌'],
]
const DEFAULT_MCP_ICON = '🔌'

function getMcpIcon(name, type) {
  const combined = `${name} ${type}`
  for (const [regex, ico] of MCP_ICON_MAP) {
    if (regex.test(combined)) return ico
  }
  return DEFAULT_MCP_ICON
}

function stopStatusPoll() {
  if (_statusPollTimer) {
    clearInterval(_statusPollTimer)
    _statusPollTimer = null
  }
}

function scheduleStatusPoll(page) {
  stopStatusPoll()
  _statusPollTimer = setInterval(() => {
    if (!page.isConnected) {
      stopStatusPoll()
      return
    }
    const installed = page.querySelector('#mcp-tab-installed')
    if (!installed || installed.hidden) return
    void loadTools(page, { silent: true })
  }, 4000)
}

function resolveUiStatus(name, config, runtimeStatus) {
  const enabled = config?.enabled !== false
  if (!enabled) return 'disabled'
  const load = runtimeStatus?.load_status
  if (load === 'ready') return 'ready'
  if (load === 'pending') return 'pending'
  if (load === 'error') {
    const err = String(runtimeStatus?.error || '').toLowerCase()
    if (/auth|oauth|token|unauthorized|401|403/.test(err)) return 'auth'
    if (/config|invalid|missing|parse|json/.test(err)) return 'config'
    return 'error'
  }
  if (config?.oauth && !runtimeStatus) return 'auth'
  return 'pending'
}

function transportLabel(config) {
  const t = String(config?.type || 'stdio').toLowerCase()
  if (t === 'sse') return 'SSE'
  if (t === 'http') return 'HTTP'
  return 'Stdio'
}

function authLabel(config) {
  if (config?.oauth) return 'OAuth'
  if (config?.headers && Object.keys(config.headers).length) return 'Header'
  if (config?.env && Object.keys(config.env).length) return '环境变量'
  return '无'
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page ec-module-page ec-mcp-page'
  page._mcpState = {
    view: 'installed',
    data: null,
    filter: '',
    status: '',
    sort: 'name',
  }

  page.innerHTML = `
    ${renderModuleSubtabs(
      [
        { id: 'installed', label: '已安装' },
        { id: 'market', label: '市场' },
      ],
      'installed',
    )}

    <div id="mcp-tab-installed" class="ec-tab-panel">
      <div class="role-toolbar role-toolbar--agents ec-toolbar">
        <div class="role-filters-row">
          <div class="role-search-wrap">
            <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input class="role-search-input" id="mcp-filter-input" placeholder="搜索连接器" autocomplete="off">
          </div>
          ${selectHtml('mcp-filter-status', STATUS_FILTERS, '状态：全部')}
          <select class="role-filter-select" id="mcp-filter-sort" aria-label="排序">
            <option value="name">名称</option>
            <option value="status">状态</option>
            <option value="tools">工具数</option>
          </select>
        </div>
        <div class="role-toolbar-actions">
          <span class="role-total" id="mcp-count"></span>
        </div>
      </div>
      <div id="mcp-banners"></div>
      <div id="tools-content"><div class="ec-loading">加载中…</div></div>
    </div>

    <div id="mcp-tab-market" class="ec-tab-panel" hidden>
      <div class="role-toolbar role-toolbar--agents ec-toolbar">
        <div class="role-filters-row">
          <div class="role-search-wrap">
            <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input class="role-search-input" id="market-search-input" placeholder="搜索连接器市场" autocomplete="off">
          </div>
        </div>
        <div class="role-toolbar-actions">
          <span class="role-total" id="market-hint">连接器目录</span>
        </div>
      </div>
      <p class="ec-muted" style="margin:8px 0 0;font-size:12px;color:var(--text-tertiary,#888);line-height:1.5">连接器来自公开目录（含精选列表、MCP Registry、Glama），遵循各自上游许可证；一键安装不等于官方背书。</p>
      <div id="market-banner" class="mcp-status-banner mcp-status-banner--pending" hidden></div>
      <div id="market-results" class="ec-market-scroll market-results">
        <div class="ec-empty">输入关键词搜索连接器，或等待推荐列表</div>
      </div>
    </div>
  `

  bindPageEvents(page)
  page._bindExpertHeader = () => {
    const btn = page.closest('.expert-page')?.querySelector('#expert-primary-action')
    if (!btn) return
    btn.onclick = () => openAddConnectorWizard(page)
    btn.hidden = false
  }
  page._syncExpertPrimaryAction = () => {
    const btn = page.closest('.expert-page')?.querySelector('#expert-primary-action')
    if (!btn) return
    btn.hidden = false
    btn.onclick = () => openAddConnectorWizard(page)
  }

  void loadTools(page)
  return page
}

export function cleanup() {
  stopStatusPoll()
}

function bindPageEvents(page) {
  page.querySelector('.ec-subtabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-main-tab]')
    if (!tab) return
    const id = tab.dataset.mainTab
    page._mcpState.view = id
    page.querySelectorAll('.ec-subtabs .role-subtab').forEach((t) => {
      t.classList.toggle('role-subtab--active', t.dataset.mainTab === id)
    })
    page.querySelector('#mcp-tab-installed').hidden = id !== 'installed'
    page.querySelector('#mcp-tab-market').hidden = id !== 'market'
    if (id === 'market' && !page._marketLoaded) {
      page._marketLoaded = true
      void searchMarket(page, true)
    }
  })

  page.querySelector('#mcp-filter-input')?.addEventListener('input', (e) => {
    page._mcpState.filter = String(e.target.value || '').trim().toLowerCase()
    if (page._mcpState.data) renderInstalled(page, page._mcpState.data)
  })
  page.querySelector('#mcp-filter-status')?.addEventListener('change', (e) => {
    page._mcpState.status = e.target.value
    if (page._mcpState.data) renderInstalled(page, page._mcpState.data)
  })
  page.querySelector('#mcp-filter-sort')?.addEventListener('change', (e) => {
    page._mcpState.sort = e.target.value || 'name'
    if (page._mcpState.data) renderInstalled(page, page._mcpState.data)
  })

  let debounce = null
  page.querySelector('#market-search-input')?.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void searchMarket(page, false), 400)
  })
  page.querySelector('#market-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void searchMarket(page, false)
  })
}

async function loadTools(page, opts = {}) {
  const silent = !!opts.silent
  const contentEl = page.querySelector('#tools-content')
  if (!silent && contentEl) contentEl.innerHTML = `<div class="ec-loading">加载中…</div>`
  const seq = ++_loadSeq
  try {
    const data = await api.getMCPConfig()
    if (seq !== _loadSeq) return
    page._mcpState.data = data
    renderInstalled(page, data)
    const servers = data?.mcp_servers || {}
    const hasPending = Object.values(data?.server_status || {}).some((s) => s?.load_status === 'pending')
      || (!data?.cache_initialized && Object.values(servers).some((c) => c.enabled !== false))
    if (hasPending) scheduleStatusPoll(page)
    else stopStatusPoll()
  } catch (e) {
    if (seq !== _loadSeq) return
    stopStatusPoll()
    if (!silent && contentEl) {
      contentEl.innerHTML = `<div class="ec-error">加载失败: ${esc(e?.message || e)}</div>`
    }
    if (!silent) toast('加载连接器失败: ' + e, 'error')
  }
}

function renderInstalled(page, data) {
  const contentEl = page.querySelector('#tools-content')
  const banners = page.querySelector('#mcp-banners')
  const countEl = page.querySelector('#mcp-count')
  const servers = data?.mcp_servers || {}
  const toolCounts = data?.tool_counts || {}
  const serverStatus = data?.server_status || {}
  let list = Object.entries(servers)

  const q = page._mcpState.filter
  const statusF = page._mcpState.status
  list = list.filter(([name, config]) => {
    const st = resolveUiStatus(name, config, serverStatus[name])
    if (statusF && st !== statusF) return false
    if (!q) return true
    const text = `${name} ${config.description || ''} ${config.command || ''} ${config.url || ''}`.toLowerCase()
    return text.includes(q)
  })

  list.sort((a, b) => {
    if (page._mcpState.sort === 'tools') {
      const ca = serverStatus[a[0]]?.tool_count ?? toolCounts[a[0]] ?? 0
      const cb = serverStatus[b[0]]?.tool_count ?? toolCounts[b[0]] ?? 0
      return cb - ca
    }
    if (page._mcpState.sort === 'status') {
      return resolveUiStatus(a[0], a[1], serverStatus[a[0]]).localeCompare(
        resolveUiStatus(b[0], b[1], serverStatus[b[0]]),
      )
    }
    return String(a[0]).localeCompare(String(b[0]), 'zh')
  })

  let bannerHtml = ''
  if (!data?.cache_initialized && list.some(([, c]) => c.enabled !== false)) {
    bannerHtml += `<div class="mcp-status-banner mcp-status-banner--pending">正在后台连接连接器…</div>`
  }
  if (data?.config_stale) {
    bannerHtml += `<div class="mcp-status-banner mcp-status-banner--pending">配置已更新，正在重新加载…</div>`
  }
  if (data?.init_error) {
    bannerHtml += `<div class="mcp-status-banner mcp-status-banner--error">${esc(data.init_error)}</div>`
  }
  if (banners) banners.innerHTML = bannerHtml

  if (countEl) countEl.textContent = `共 ${list.length} 个连接器`
  if (!list.length) {
    contentEl.innerHTML = `<div class="ec-empty">暂无连接器，点击右上角「添加连接器」开始</div>`
    return
  }

  contentEl.innerHTML = `<div class="mcp-server-list ec-connector-list">${list
    .map(([name, config]) => renderConnectorCard(name, config, toolCounts[name] || 0, serverStatus[name]))
    .join('')}</div>`

  bindInstalledEvents(page, contentEl, data)
}

function renderConnectorCard(name, config, toolCount, runtimeStatus) {
  const ui = resolveUiStatus(name, config, runtimeStatus)
  const label = STATUS_UI[ui]?.label || ui
  const count = runtimeStatus?.tool_count ?? toolCount
  const lastCheck = esc(runtimeStatus?.checked_at || runtimeStatus?.updated_at || '—')
  const lastErr = esc(runtimeStatus?.error || '—')
  const enabled = config.enabled !== false
  const type = esc(config.type || 'stdio')

  return `
    <article class="mcp-server-row mcp-server-row--${ui} ec-connector-card" data-name="${esc(name)}" data-ui-status="${ui}" tabindex="0">
      <span class="mcp-status-dot mcp-status-dot--${ui === 'auth' || ui === 'config' ? 'error' : ui}"></span>
      <span class="mcp-row-icon">${getMcpIcon(name, type)}</span>
      <div class="mcp-row-info">
        <div class="mcp-row-name-row">
          <div class="mcp-row-name">${esc(name)}</div>
          <span class="mcp-load-label mcp-load-label--${ui === 'auth' || ui === 'config' ? 'error' : ui}">${label}</span>
          <span class="ec-tech-type">MCP · ${type}</span>
        </div>
        <div class="mcp-row-meta">${esc(config.description || `${transportLabel(config)} · ${authLabel(config)}`)}</div>
        <div class="ec-card-meta">
          <span>${transportLabel(config)}</span>
          <span>${authLabel(config)}</span>
          <span>${count} 个工具</span>
          <span>检测 ${lastCheck}</span>
        </div>
        ${ui === 'error' || ui === 'auth' || ui === 'config' ? `<div class="ec-card-meta ec-card-meta--error">最近错误：${lastErr}</div>` : ''}
      </div>
      <div class="ec-row-actions" data-stop="1">
        <button type="button" class="btn btn-secondary btn-sm" data-act="test">测试连接</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="config">配置</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="logs">查看日志</button>
        <label class="mcp-row-toggle" title="${enabled ? '停用' : '启用'}">
          <input type="checkbox" class="mcp-toggle" data-name="${esc(name)}" ${enabled ? 'checked' : ''}>
          <span class="mcp-toggle-track"><span class="mcp-toggle-thumb"></span></span>
        </label>
        <button type="button" class="mcp-row-delete skill-delete-btn" data-act="delete" title="删除">${icon('trash', 12)}</button>
      </div>
    </article>`
}

function bindInstalledEvents(page, contentEl, data) {
  contentEl.querySelectorAll('.ec-connector-card').forEach((card) => {
    const name = card.dataset.name
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return
      openConnectorDetail(page, name)
    })
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openConnectorDetail(page, name)
      }
    })

    card.querySelector('[data-act="test"]')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const btn = e.currentTarget
      setBtnState(btn, 'loading', { loading: '测试中…', idle: '测试连接' })
      try {
        await loadTools(page, { silent: true })
        const st = page._mcpState.data?.server_status?.[name]
        const ui = resolveUiStatus(name, page._mcpState.data?.mcp_servers?.[name], st)
        if (ui === 'ready') {
          setBtnState(btn, 'success', { success: '可用' })
          toast(`连接器「${name}」可用`, 'success')
        } else if (ui === 'pending') {
          setBtnState(btn, 'idle', { idle: '测试连接' })
          toast('仍在连接中，请稍候', 'info')
        } else {
          setBtnState(btn, 'error', { error: '失败', idle: '测试连接' })
          toast(st?.error || '连接失败', 'error')
        }
        setTimeout(() => setBtnState(btn, 'idle', { idle: '测试连接' }), 1600)
      } catch (err) {
        setBtnState(btn, 'error', { error: '失败', idle: '测试连接' })
        toast('测试失败: ' + (err?.message || err), 'error')
      }
    })

    card.querySelector('[data-act="config"]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      openEditConnectorModal(page, name)
    })

    card.querySelector('[data-act="logs"]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const err = data?.server_status?.[name]?.error || '暂无错误日志'
      openDrawer(page, {
        title: `${name} · 日志`,
        body: `<pre class="mcp-error-detail">${esc(err)}</pre>`,
        foot: `<button type="button" class="btn btn-secondary" data-act="close">关闭</button>`,
      })
      page.querySelector('#ecDrawer [data-act="close"]')?.addEventListener('click', () => closeDrawer(page))
    })

    card.querySelector('[data-act="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const yes = await showConfirm(`确定删除连接器「${name}」？`)
      if (!yes) return
      try {
        const current = await api.getMCPConfig()
        const servers = { ...(current?.mcp_servers || {}) }
        delete servers[name]
        await api.updateMCPConfig(servers)
        toast(`连接器「${name}」已删除`, 'success')
        void loadTools(page)
      } catch (err) {
        toast('删除失败: ' + (err?.message || err), 'error')
      }
    })

    const toggle = card.querySelector('.mcp-toggle')
    if (toggle) {
      toggle.addEventListener('click', (e) => e.stopPropagation())
      toggle.onchange = async () => {
        const enabled = toggle.checked
        try {
          const current = await api.getMCPConfig()
          const servers = { ...(current?.mcp_servers || {}) }
          servers[name] = { ...servers[name], enabled }
          await api.updateMCPConfig(servers)
          toast(`连接器「${name}」已${enabled ? '启用' : '停用'}`, 'success')
          void loadTools(page)
        } catch (err) {
          toggle.checked = !enabled
          toast('操作失败: ' + (err?.message || err), 'error')
        }
      }
    }
  })
}

function openConnectorDetail(page, name) {
  const data = page._mcpState.data
  const config = data?.mcp_servers?.[name]
  if (!config) return
  const st = data?.server_status?.[name]
  const ui = resolveUiStatus(name, config, st)
  const tools = st?.tools || []
  openDrawer(page, {
    title: name,
    subtitle: `${STATUS_UI[ui]?.label || ui} · MCP Server`,
    body: `
      <section class="role-drawer-section"><h4>基本信息</h4>
        <dl class="role-drawer-dl">
          <div><dt>类型</dt><dd>MCP Server · ${esc(config.type || 'stdio')}</dd></div>
          <div><dt>连接方式</dt><dd>${esc(transportLabel(config))}</dd></div>
          <div><dt>认证</dt><dd>${esc(authLabel(config))}</dd></div>
          <div><dt>工具数</dt><dd>${st?.tool_count ?? tools.length ?? 0}</dd></div>
        </dl>
      </section>
      <section class="role-drawer-section"><h4>描述</h4><p>${esc(config.description || '暂无描述')}</p></section>
      <section class="role-drawer-section"><h4>最近错误</h4><pre class="mcp-error-detail">${esc(st?.error || '无')}</pre></section>
      <section class="role-drawer-section"><h4>工具</h4>
        <ul class="role-drawer-list">${
          tools.length
            ? tools.slice(0, 20).map((t) => `<li>${esc(t.name || t.full_name)}</li>`).join('')
            : '<li>暂无</li>'
        }</ul>
      </section>
    `,
    foot: `
      <button type="button" class="btn btn-secondary" data-act="config">配置</button>
      <button type="button" class="btn btn-primary" data-act="test">测试连接</button>`,
  })
  const root = page.querySelector('#ecDrawer')
  root.querySelector('[data-act="config"]')?.addEventListener('click', () => {
    closeDrawer(page)
    openEditConnectorModal(page, name)
  })
  root.querySelector('[data-act="test"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    setBtnState(btn, 'loading', { loading: '测试中…', idle: '测试连接' })
    try {
      await loadTools(page, { silent: true })
      const next = resolveUiStatus(name, page._mcpState.data?.mcp_servers?.[name], page._mcpState.data?.server_status?.[name])
      if (next === 'ready') {
        setBtnState(btn, 'success', { success: '可用' })
        toast('连接可用', 'success')
      } else {
        setBtnState(btn, 'error', { error: '失败', idle: '测试连接' })
        toast(page._mcpState.data?.server_status?.[name]?.error || '连接失败', 'error')
      }
    } catch (err) {
      setBtnState(btn, 'error', { error: '失败', idle: '测试连接' })
      toast(String(err), 'error')
    }
  })
}

function openEditConnectorModal(page, name) {
  const config = page._mcpState.data?.mcp_servers?.[name] || {}
  showModal({
    title: `配置连接器 · ${name}`,
    width: 720,
    fields: [
      {
        name: 'json',
        type: 'textarea',
        label: '连接器配置（JSON）',
        value: JSON.stringify(config, null, 2),
        rows: 18,
      },
    ],
    onConfirm: async (vals) => {
      let parsed
      try {
        parsed = JSON.parse(vals.json || '{}')
      } catch (e) {
        toast('JSON 格式错误: ' + e.message, 'warning')
        return
      }
      try {
        const current = await api.getMCPConfig()
        const servers = { ...(current?.mcp_servers || {}) }
        servers[name] = parsed
        await api.updateMCPConfig(servers)
        toast('配置已保存', 'success')
        void loadTools(page)
      } catch (e) {
        toast('保存失败: ' + e, 'error')
      }
    },
  })
}

function openAddConnectorWizard(page) {
  const state = {
    step: 0,
    name: '',
    type: 'stdio',
    command: '',
    args: '',
    url: '',
    description: '',
    auth: 'none',
    scope: 'global',
  }
  const steps = ['基本信息', '连接配置', '身份认证', '测试连接', '使用范围', '完成']

  const renderStep = () => {
    const step = state.step
    let body = `<div class="ec-wizard-steps">${steps
      .map((s, i) => `<span class="ec-wizard-step${i === step ? ' is-on' : ''}${i < step ? ' is-done' : ''}">${i + 1}. ${s}</span>`)
      .join('')}</div>`

    if (step === 0) {
      body += `
        <div class="form-group"><label class="form-label">名称</label>
          <input class="form-input" data-f="name" value="${esc(state.name)}" placeholder="例如 github"></div>
        <div class="form-group"><label class="form-label">描述</label>
          <input class="form-input" data-f="description" value="${esc(state.description)}" placeholder="可选"></div>
        <div class="form-group"><label class="form-label">技术类型</label>
          <select class="form-input" data-f="type">
            <option value="stdio"${state.type === 'stdio' ? ' selected' : ''}>stdio（MCP Server）</option>
            <option value="sse"${state.type === 'sse' ? ' selected' : ''}>sse</option>
            <option value="http"${state.type === 'http' ? ' selected' : ''}>http</option>
          </select></div>`
    } else if (step === 1) {
      body += state.type === 'stdio'
        ? `<div class="form-group"><label class="form-label">命令</label>
            <input class="form-input" data-f="command" value="${esc(state.command)}" placeholder="npx / uvx / 可执行文件"></div>
           <div class="form-group"><label class="form-label">参数（空格分隔）</label>
            <input class="form-input" data-f="args" value="${esc(state.args)}" placeholder="-y @modelcontextprotocol/server-github"></div>`
        : `<div class="form-group"><label class="form-label">URL</label>
            <input class="form-input" data-f="url" value="${esc(state.url)}" placeholder="https://..."></div>`
    } else if (step === 2) {
      body += `
        <div class="form-group"><label class="form-label">认证方式</label>
          <select class="form-input" data-f="auth">
            <option value="none">无</option>
            <option value="env">环境变量（稍后在配置中补充）</option>
            <option value="oauth">OAuth</option>
          </select></div>
        <p class="form-hint">敏感凭证建议写入本机环境或配置文件，勿硬编码到对话中。</p>`
    } else if (step === 3) {
      body += `<p>将写入连接器配置并触发后台连接。保存后可在列表中查看「连接中 / 可用 / 失败」状态。</p>`
    } else if (step === 4) {
      body += `
        <div class="form-group"><label class="form-label">使用范围</label>
          <select class="form-input" data-f="scope">
            <option value="global">全局可用</option>
            <option value="assign">稍后分配给智能体</option>
          </select></div>`
    } else {
      body += `<p>连接器已添加。可在详情中查看发现的工具，并分配给智能体。</p>`
    }

    const foot =
      step < 5
        ? `<button type="button" class="btn btn-secondary" data-act="prev"${step === 0 ? ' disabled' : ''}>上一步</button>
           <button type="button" class="btn btn-primary" data-act="next">${step === 3 ? '保存并测试' : '下一步'}</button>`
        : `<button type="button" class="btn btn-secondary" data-act="close">完成</button>
           <button type="button" class="btn btn-primary" data-act="assign">分配给智能体</button>`

    openDrawer(page, {
      title: '添加连接器',
      subtitle: steps[step],
      body,
      foot,
    })

    const root = page.querySelector('#ecDrawer')
    root.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('change', () => {
        state[el.dataset.f] = el.value
      })
      el.addEventListener('input', () => {
        state[el.dataset.f] = el.value
      })
    })
    root.querySelector('[data-act="prev"]')?.addEventListener('click', () => {
      state.step = Math.max(0, state.step - 1)
      renderStep()
    })
    root.querySelector('[data-act="next"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget
      if (state.step === 0 && !String(state.name || '').trim()) {
        toast('请填写名称', 'warning')
        return
      }
      if (state.step === 3) {
        setBtnState(btn, 'loading', { loading: '保存中…', idle: '保存并测试' })
        try {
          await saveWizardConnector(page, state)
          setBtnState(btn, 'success', { success: '已保存' })
          state.step = 4
          renderStep()
        } catch (err) {
          setBtnState(btn, 'error', { error: '失败，重试', idle: '保存并测试' })
          toast('添加失败: ' + (err?.message || err), 'error')
        }
        return
      }
      if (state.step === 4) {
        state.step = 5
        renderStep()
        return
      }
      state.step += 1
      renderStep()
    })
    root.querySelector('[data-act="close"]')?.addEventListener('click', () => closeDrawer(page))
    root.querySelector('[data-act="assign"]')?.addEventListener('click', () => {
      closeDrawer(page)
      toast('请在智能体编辑页的连接器 / MCP 中勾选分配', 'info')
    })
  }

  renderStep()
}

async function saveWizardConnector(page, state) {
  const name = String(state.name || '').trim()
  if (!name) throw new Error('名称不能为空')
  const cfg = {
    enabled: true,
    type: state.type || 'stdio',
    description: state.description || '',
  }
  if (cfg.type === 'stdio') {
    cfg.command = state.command || ''
    cfg.args = String(state.args || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
  } else {
    cfg.url = state.url || ''
  }
  if (state.auth === 'oauth') cfg.oauth = {}
  const current = await api.getMCPConfig()
  const servers = { ...(current?.mcp_servers || {}) }
  if (servers[name]) throw new Error('同名连接器已存在')
  servers[name] = cfg
  await api.updateMCPConfig(servers)
  toast(`连接器「${name}」已添加`, 'success')
  await loadTools(page)
  const tools = page._mcpState.data?.server_status?.[name]?.tool_count
  if (typeof tools === 'number') toast(`已发现 ${tools} 个工具（可能仍在连接中）`, 'info')
}

// —— 市场 ——
async function searchMarket(page, isAutoLoad = false, append = false) {
  const input = page.querySelector('#market-search-input')
  const resultsEl = page.querySelector('#market-results')
  const query = (input?.value || '').trim()

  if (!query && !isAutoLoad && !append) {
    resultsEl.innerHTML = `<div class="ec-empty">输入关键词搜索连接器</div>`
    return
  }
  if (!append) {
    page._marketCursor = null
    page._marketItems = []
    resultsEl.innerHTML = `<div class="ec-loading">${isAutoLoad ? '正在加载推荐…' : '正在搜索…'}</div>`
  }

  try {
    const data = await api.mcpMarketSearch(isAutoLoad && !append ? '' : query, append ? page._marketCursor : null)
    let items = []
    if (Array.isArray(data)) items = data
    else if (data?.servers) items = data.servers
    else if (data?.results) items = data.results
    else if (data?.data) items = data.data
    items = items.map(normalizeMarketItem).filter((i) => i.slug || i.name)
    page._marketCursor = data?.cursor || null
    page._marketHasMore = !!data?.has_more
    page._marketItems = append ? [...(page._marketItems || []), ...items] : items

    const hint = page.querySelector('#market-hint')
    const banner = page.querySelector('#market-banner')
    const sourceLabel =
      data?.source === 'hot' ? '精选' : data?.source === 'registry' ? '官方 Registry' : 'Glama'
    if (hint) hint.textContent = `数据源：${sourceLabel} · ${page._marketItems.length} 项`
    if (banner) {
      if (data?.warning) {
        banner.hidden = false
        banner.textContent = data.warning
        banner.className = 'mcp-status-banner mcp-status-banner--pending'
      } else {
        banner.hidden = true
        banner.textContent = ''
      }
    }

    if (!page._marketItems.length) {
      resultsEl.innerHTML = `<div class="ec-empty">${isAutoLoad ? '暂无推荐' : '未找到匹配连接器'}</div>`
      return
    }

    const installed = new Set(Object.keys(page._mcpState.data?.mcp_servers || {}))
    const hotItems = page._marketItems.filter((i) => i.source === 'hot')
    const otherItems = page._marketItems.filter((i) => i.source !== 'hot')
    const sections = []
    if (hotItems.length) {
      sections.push(
        `<div class="market-section-label">精选连接器</div>` +
          `<div class="market-card-grid">${hotItems.map((item) => renderMarketCard(item, installed)).join('')}</div>`,
      )
    }
    if (otherItems.length) {
      const label =
        data?.source === 'registry'
          ? '官方 MCP Registry'
          : data?.source === 'glama'
            ? 'Glama 目录'
            : '更多连接器'
      sections.push(
        `<div class="market-section-label">${label}</div>` +
          `<div class="market-card-grid">${otherItems.map((item) => renderMarketCard(item, installed)).join('')}</div>`,
      )
    }
    resultsEl.innerHTML =
      sections.join('') +
      (page._marketHasMore
        ? `<div class="market-load-more"><button class="btn btn-secondary btn-sm" id="market-load-more">加载更多</button></div>`
        : '')
    bindMarketEvents(page)
  } catch (e) {
    resultsEl.innerHTML = `<div class="ec-error">${String(e).includes('rate_limited') ? '搜索频率超限，请稍后再试' : '搜索失败: ' + esc(String(e))}</div>`
  }
}

function normalizeMarketItem(raw) {
  if (typeof raw === 'string') return { slug: raw, name: raw, description: '', source: 'glama' }
  return {
    slug: raw.slug || raw.name || raw.id || '',
    name: raw.name || raw.title || raw.slug || '',
    title: raw.title || raw.name || '',
    description: raw.description || raw.summary || '',
    author: raw.author || raw.glama_namespace || '',
    repository_url: raw.repository_url || raw.repositoryUrl || '',
    registry_name: raw.registry_name || '',
    glama_namespace: raw.glama_namespace || '',
    glama_slug: raw.glama_slug || '',
    source: raw.source || 'glama',
    verified: !!raw.verified,
    stars: raw.stars || 0,
    tool_count: raw.tool_count || raw.tools_count || raw.toolCount,
    transport: raw.transport || raw.type || 'stdio',
    auth: raw.auth || (raw.oauth ? 'OAuth' : '无'),
  }
}

function renderMarketCard(item, installed) {
  const name = esc(item.name || item.slug)
  const exists = installed.has(item.name) || installed.has(item.slug) || (item.registry_name && installed.has(item.registry_name))
  const source = String(item.source || 'glama')
  const sourceBadge =
    source === 'hot'
      ? '<span class="market-badge market-badge--hot">精选</span>'
      : source === 'registry'
        ? '<span class="market-badge market-badge--registry">Registry</span>'
        : '<span class="market-badge">Glama</span>'
  const author = item.author ? `@${esc(item.author)}` : ''
  const trust = item.verified ? '已认证' : source === 'hot' ? '推荐' : '社区'
  const tools =
    item.tool_count != null && item.tool_count !== ''
      ? `${item.tool_count} 工具`
      : ''
  const metaBits = [author, trust, tools, item.transport, item.auth].filter(Boolean)
  return `
    <article class="mcp-server-card market-item skill-card" data-slug="${esc(item.slug)}" data-name="${name}"
      data-source="${esc(source)}"
      data-registry-name="${esc(item.registry_name || '')}"
      data-glama-namespace="${esc(item.glama_namespace || '')}"
      data-glama-slug="${esc(item.glama_slug || '')}"
      data-repository-url="${esc(item.repository_url || '')}">
      <div class="mcp-server-main skill-card-main">
        <div class="skill-card-head">
          <span class="skill-card-icon">${getMcpIcon(item.slug, item.title)}</span>
          <strong class="skill-card-name">${name}</strong>
          ${sourceBadge}
        </div>
        <p class="skill-card-desc">${esc(item.description || '暂无描述')}</p>
        <div class="ec-card-meta">${metaBits.map((b) => `<span>${b}</span>`).join('')}</div>
      </div>
      <div class="skill-card-actions ec-card-actions">
        ${exists
          ? '<span class="install-badge-installed">已添加</span>'
          : '<button type="button" class="btn btn-primary btn-sm market-add-btn">添加连接器</button>'}
      </div>
    </article>`
}

function bindMarketEvents(page) {
  page.querySelector('#market-load-more')?.addEventListener('click', () => void searchMarket(page, false, true))
  page.querySelectorAll('.market-add-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const card = btn.closest('.market-item')
      openMarketAddWizard(page, card, btn)
    })
  })
  page.querySelectorAll('.market-item').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.market-add-btn')) return
      openMarketAddWizard(page, card, null)
    })
  })
}

function openMarketAddWizard(page, card, triggerBtn) {
  if (!card) return
  const slug = card.dataset.slug || ''
  const name = card.dataset.name || slug
  openDrawer(page, {
    title: '添加连接器',
    subtitle: esc(name),
    body: `
      <div class="ec-wizard-steps">
        <span class="ec-wizard-step is-on">1. 基本信息</span>
        <span class="ec-wizard-step">2. 连接配置</span>
        <span class="ec-wizard-step">3. 身份认证</span>
        <span class="ec-wizard-step">4. 测试连接</span>
        <span class="ec-wizard-step">5. 使用范围</span>
        <span class="ec-wizard-step">6. 完成</span>
      </div>
      <section class="role-drawer-section"><h4>将安装</h4>
        <p><strong>${esc(name)}</strong>（${esc(slug)}）</p>
        <p class="role-drawer-muted">系统将从官方 Registry 拉取推荐配置并写入本机连接器列表。</p>
      </section>
      <section class="role-drawer-section"><h4>使用范围</h4>
        <p>默认全局可用，添加后可在智能体中分配。</p>
      </section>
    `,
    foot: `
      <button type="button" class="btn btn-secondary" data-act="close">取消</button>
      <button type="button" class="btn btn-primary" data-act="confirm">确认添加</button>`,
  })
  const root = page.querySelector('#ecDrawer')
  root.querySelector('[data-act="close"]')?.addEventListener('click', () => closeDrawer(page))
  root.querySelector('[data-act="confirm"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    setBtnState(btn, 'loading', { loading: '添加中…', idle: '确认添加' })
    if (triggerBtn) setBtnState(triggerBtn, 'loading', { loading: '添加中…', idle: '添加连接器' })
    try {
      const current = await api.getMCPConfig()
      const servers = { ...(current?.mcp_servers || {}) }
      if (servers[name] || servers[slug]) {
        toast('该连接器已存在', 'warning')
        setBtnState(btn, 'idle', { idle: '确认添加' })
        return
      }
      const installed = await api.mcpMarketInstall({
        slug,
        source: card.dataset.source || '',
        registry_name: card.dataset.registryName || '',
        glama_namespace: card.dataset.glamaNamespace || '',
        glama_slug: card.dataset.glamaSlug || '',
        repository_url: card.dataset.repositoryUrl || '',
      })
      const key = installed?.name || installed?.registry_name || name || slug
      const cfg = installed?.config || installed
      if (cfg && typeof cfg === 'object') servers[key] = { enabled: true, ...cfg }
      await api.updateMCPConfig(servers)
      setBtnState(btn, 'success', { success: '已添加' })
      toast(`连接器「${key}」已添加`, 'success')
      await loadTools(page)
      const toolN = page._mcpState.data?.server_status?.[key]?.tool_count
      openDrawer(page, {
        title: '添加成功',
        subtitle: esc(key),
        body: `<p>已发现工具：${toolN != null ? toolN : '连接中，稍后在列表查看'}。</p>`,
        foot: `
          <button type="button" class="btn btn-secondary" data-act="close">完成</button>
          <button type="button" class="btn btn-primary" data-act="assign">分配给智能体</button>`,
      })
      const r2 = page.querySelector('#ecDrawer')
      r2.querySelector('[data-act="close"]')?.addEventListener('click', () => closeDrawer(page))
      r2.querySelector('[data-act="assign"]')?.addEventListener('click', () => {
        closeDrawer(page)
        toast('请在智能体编辑页分配该连接器', 'info')
      })
      if (page._marketLoaded) void searchMarket(page, true)
    } catch (err) {
      setBtnState(btn, 'error', { error: '失败，重试', idle: '确认添加' })
      if (triggerBtn) setBtnState(triggerBtn, 'error', { error: '失败', idle: '添加连接器' })
      toast('添加失败: ' + (err?.message || err), 'error')
    }
  })
}
