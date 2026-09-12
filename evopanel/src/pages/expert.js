/**
 * 专家页面 — 顶部：标题 + 分段一级导航 + 模块主操作
 * 子页：智能体 / 技能 / 连接器
 */

const TABS = [
  { id: 'agents', label: '智能体' },
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: '连接器' },
]

const PRIMARY_ACTIONS = {
  agents: { label: '新建智能体', title: '创建自定义智能体' },
  skills: { label: '导入本地技能', title: '从本地 zip 导入技能' },
  mcp: { label: '添加连接器', title: '添加 MCP 连接器' },
}

/** 字面量 import()，供 Vite/Rollup 静态分析并生成正确 chunk（勿用变量路径） */
const TAB_LOADERS = {
  agents: () => import('./agents.js'),
  skills: () => import('./skills.js'),
  mcp: () => import('./tools.js'),
}

let _activeTab = 'agents'
let _pageEl = null
let _contentEl = null
let _cleanupFn = null
const _moduleCache = {}

async function _loadModule(tabId) {
  if (_moduleCache[tabId]) return _moduleCache[tabId]
  const load = TAB_LOADERS[tabId]
  if (!load) throw new Error(`Unknown tab: ${tabId}`)
  const mod = await load()
  _moduleCache[tabId] = mod
  return mod
}

function _syncHeaderChrome({ clearAction = false } = {}) {
  if (!_pageEl) return
  _pageEl.querySelectorAll('.expert-seg-item[data-tab]').forEach((el) => {
    const on = el.dataset.tab === _activeTab
    el.classList.toggle('active', on)
    el.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  const btn = _pageEl.querySelector('#expert-primary-action')
  const cfg = PRIMARY_ACTIONS[_activeTab]
  if (btn && cfg) {
    btn.hidden = false
    btn.textContent = cfg.label
    btn.title = cfg.title
    btn.dataset.module = _activeTab
    // 仅在切换模块、子页尚未挂载时清空，避免串模块；挂载后由 _bindExpertHeader 绑定
    if (clearAction) btn.onclick = null
  }
}

async function _renderTab(tabId) {
  if (!_contentEl) return

  if (_cleanupFn) {
    try {
      _cleanupFn()
    } catch (_) {}
    _cleanupFn = null
  }
  _contentEl.innerHTML =
    '<div class="page-loader"><div class="page-loader-spinner"></div><div class="page-loader-text">加载中...</div></div>'

  try {
    const mod = await _loadModule(tabId)
    const renderFn = mod.render || mod.default
    if (!renderFn) {
      _contentEl.innerHTML = '<div style="padding:20px;color:var(--text-tertiary)">模块加载失败</div>'
      return
    }
    const result = await renderFn()
    _cleanupFn = mod.cleanup || null
    _contentEl.innerHTML = ''
    if (typeof result === 'string') {
      _contentEl.innerHTML = result
    } else if (result instanceof HTMLElement) {
      _contentEl.appendChild(result)
    }
    // 先同步文案，再绑定主操作，避免 sync 清空 onclick 导致「导入技能」等无反应
    _syncHeaderChrome()
    if (result instanceof HTMLElement && typeof result._bindExpertHeader === 'function') {
      try {
        result._bindExpertHeader()
      } catch (_) {}
    }
    if (result instanceof HTMLElement && typeof result._syncExpertPrimaryAction === 'function') {
      try {
        result._syncExpertPrimaryAction()
      } catch (_) {}
    } else if (result instanceof HTMLElement && typeof result._syncExpertNewAgent === 'function') {
      try {
        result._syncExpertNewAgent()
      } catch (_) {}
    }
  } catch (e) {
    console.error('[expert] tab render failed:', tabId, e)
    _contentEl.innerHTML = `<div style="padding:20px;color:var(--error)">加载失败: ${e.message || e}</div>`
  }
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page expert-page'
  _pageEl = page

  const initial = PRIMARY_ACTIONS[_activeTab]
  page.innerHTML = `
    <header class="expert-page-head">
      <div class="expert-head-row">
        <div class="expert-title-block">
          <h1 class="expert-page-title">智能体中心</h1>
          <p class="expert-page-desc">创建、配置和部署可复用的智能体能力</p>
        </div>
        <div class="expert-seg" id="expert-tabs" role="tablist" aria-label="模块导航">
          ${TABS.map(
            (t) => `
            <button
              type="button"
              class="expert-seg-item${t.id === _activeTab ? ' active' : ''}"
              data-tab="${t.id}"
              role="tab"
              aria-selected="${t.id === _activeTab ? 'true' : 'false'}"
            >${t.label}</button>`,
          ).join('')}
        </div>
        <button
          type="button"
          class="btn btn-primary"
          id="expert-primary-action"
          title="${initial.title}"
          data-module="${_activeTab}"
        >${initial.label}</button>
      </div>
    </header>
    <div id="expert-tab-content"></div>
  `

  _contentEl = page.querySelector('#expert-tab-content')

  page.querySelector('#expert-tabs')?.addEventListener('click', (e) => {
    const tabEl = e.target.closest('.expert-seg-item[data-tab]')
    if (!tabEl) return
    const tabId = tabEl.dataset.tab
    if (tabId === _activeTab) return
    _activeTab = tabId
    _syncHeaderChrome({ clearAction: true })
    void _renderTab(tabId)
  })

  await _renderTab(_activeTab)
  return page
}

export function cleanup() {
  if (_cleanupFn) {
    try {
      _cleanupFn()
    } catch (_) {}
    _cleanupFn = null
  }
  _contentEl = null
  _pageEl = null
}
