/**
 * 从 hash 路由提取页面上下文（仅 ID / 类型，不读 DOM）
 */
import { getCurrentRoute } from '../../router.js'
import { getRecentUiActivities } from '../../lib/ui-focus.js'

/**
 * @param {string} [rawRoute]
 * @returns {{ route: string, contextType: string, contextId: string, label: string, module?: string }}
 */
export function extractPageContext(rawRoute) {
  const route = String(rawRoute ?? getCurrentRoute() ?? '')
    .split('?')[0]
    .trim() || '/'
  const path = route.startsWith('/') ? route : `/${route}`

  let m
  if ((m = path.match(/^\/task\/([^/]+)$/))) {
    return {
      route: path,
      contextType: 'task',
      contextId: decodeURIComponent(m[1]),
      label: `任务 · ${m[1].slice(-8)}`,
      module: 'tasks',
    }
  }
  if ((m = path.match(/^\/proactive\/([^/]+)\/work\/([^/]+)$/))) {
    return {
      route: path,
      contextType: 'task',
      contextId: decodeURIComponent(m[2]),
      label: `岗位工作项 · ${decodeURIComponent(m[2]).slice(-8)}`,
      module: 'employees',
    }
  }
  if ((m = path.match(/^\/proactive\/([^/]+)\/item\/([^/]+)$/))) {
    return {
      route: path,
      contextType: 'task',
      contextId: decodeURIComponent(m[2]),
      label: `事项 · ${decodeURIComponent(m[2]).slice(-8)}`,
      module: 'employees',
    }
  }
  if ((m = path.match(/^\/proactive\/([^/]+)$/)) && m[1] !== 'board') {
    return {
      route: path,
      contextType: 'agent',
      contextId: decodeURIComponent(m[1]),
      label: `员工 · ${decodeURIComponent(m[1])}`,
      module: 'employees',
    }
  }
  if (path === '/proactive' || path === '/proactive/board') {
    return {
      route: path,
      contextType: 'workspace',
      contextId: 'proactive',
      label: '智能体员工',
      module: 'employees',
    }
  }
  if (path.startsWith('/knowledge')) {
    if ((m = path.match(/^\/knowledge\/owned\/([^/]+)$/))) {
      const kbId = decodeURIComponent(m[1])
      let kbTitle = ''
      try {
        const titleEl =
          document.querySelector('[data-kb-id][data-kb-title]') ||
          document.querySelector('.ko-detail-title, .ko-header-title, [data-page-title]')
        kbTitle = String(
          titleEl?.getAttribute?.('data-kb-title') || titleEl?.textContent || '',
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
      } catch {
        kbTitle = ''
      }
      return {
        route: path,
        contextType: 'knowledge_base',
        contextId: kbId,
        label: kbTitle ? `知识库 · ${kbTitle}` : `知识库 · ${kbId.slice(0, 12)}`,
        module: 'knowledge',
      }
    }
    if (path === '/knowledge/owned' || path === '/knowledge/owned/') {
      return {
        route: path,
        contextType: 'workspace',
        contextId: 'knowledge_owned',
        label: '知识库列表',
        module: 'knowledge',
      }
    }
    if ((m = path.match(/^\/knowledge\/vaults/))) {
      return {
        route: path,
        contextType: 'knowledge_note',
        contextId: 'vaults',
        label: '知识库 Vault',
        module: 'knowledge',
      }
    }
    if ((m = path.match(/^\/knowledge\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1])
      if (id !== 'owned' && id !== 'vaults') {
        return {
          route: path,
          contextType: 'knowledge_base',
          contextId: id,
          label: `知识库 · ${id.slice(0, 24)}`,
          module: 'knowledge',
        }
      }
    }
    return {
      route: path,
      contextType: 'workspace',
      contextId: 'knowledge',
      label: '知识库',
      module: 'knowledge',
    }
  }
  if (path.startsWith('/settings')) {
    let tab = ''
    try {
      tab =
        document
          .querySelector('#content [data-settings-tab][aria-selected="true"]')
          ?.getAttribute('data-settings-tab') || ''
    } catch {
      tab = ''
    }
    return {
      route: path,
      contextType: 'settings',
      contextId: tab || 'settings',
      label: tab ? `设置 · ${tab}` : '设置',
      module: 'settings',
    }
  }
  if (path === '/tasks' || path === '/items') {
    return {
      route: path,
      contextType: 'workspace',
      contextId: path === '/items' ? 'items' : 'tasks',
      label: path === '/items' ? '我的事项' : '任务中心',
      module: path === '/items' ? 'items' : 'tasks',
    }
  }
  if (path === '/apps' || path.startsWith('/apps/') || path === '/workflow' || path.startsWith('/workflow/')) {
    const idMatch = path.match(/^\/(?:apps|workflow)\/([^/]+)/)
    return {
      route: path,
      contextType: 'workspace',
      contextId: idMatch ? decodeURIComponent(idMatch[1]) : 'apps',
      label: idMatch ? `工作流 · ${decodeURIComponent(idMatch[1]).slice(0, 24)}` : '工作流',
      module: 'workflow',
    }
  }
  if (path === '/chat' || path === '/chat-react') {
    return {
      route: path,
      contextType: 'workspace',
      contextId: 'chat',
      label: '主对话',
      module: 'chat',
    }
  }
  if (path === '/cron' || path === '/automation' || path.startsWith('/cron/') || path.startsWith('/automation/')) {
    return {
      route: path,
      contextType: 'workspace',
      contextId: 'automation',
      label: '自动化',
      module: 'automation',
    }
  }
  return { route: path, contextType: 'workspace', contextId: '', label: '', module: '' }
}

function _clip(s, n = 80) {
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function _textOf(el) {
  if (!(el instanceof Element)) return ''
  return _clip(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '', 100)
}

/**
 * 主对话左侧当前选中会话（sessionKey / 标题 / 是否在跑）。
 * ChatApp 侧栏用 `.react-chat-history-item.active[data-shell-session]`，不是 `.is-selected`。
 * @returns {{ sessionKey: string, title: string, runState: string } | null}
 */
export function collectActiveChatSessionHint() {
  try {
    const host =
      document.getElementById('chat-persistent-host') ||
      document.querySelector('.chat-react-full') ||
      document.querySelector('#content') ||
      document.body
    if (!(host instanceof HTMLElement)) return null

    const active =
      host.querySelector('.react-chat-history-item.active[data-shell-session]') ||
      host.querySelector('[data-shell-session].active')
    let sessionKey = ''
    let title = ''
    let running = false
    if (active instanceof HTMLElement) {
      sessionKey = String(active.getAttribute('data-shell-session') || '').trim()
      const titleEl =
        active.querySelector('.react-chat-history-item-title') ||
        active.querySelector('[data-shell-title]')
      title = _textOf(titleEl) || _clip(active.getAttribute('title') || '', 80)
      running = !!(
        active.querySelector('.react-chat-session-type-ic.is-running') ||
        active.querySelector('.react-chat-session-spinner-ic') ||
        active.classList.contains('is-running')
      )
    }
    if (!sessionKey) {
      try {
        sessionKey = String(localStorage.getItem('evopanel_last_selected_session') || '').trim()
      } catch {
        sessionKey = ''
      }
    }
    if (!sessionKey) return null
    return {
      sessionKey,
      title: title || sessionKey.slice(0, 12),
      runState: running ? 'running' : 'idle',
    }
  } catch {
    return null
  }
}

/**
 * 从左侧主内容区刮取可见 UI 信号（选中项、活动 Tab、标题、焦点控件）。
 * 有意保守：只读标注过的结构，避免整页 DOM 倾倒。
 */
function collectVisibleUiHints() {
  /** @type {Record<string, unknown>} */
  const hints = {}
  try {
    const root =
      document.getElementById('chat-persistent-host') ||
      document.querySelector('#content') ||
      document.body
    if (!(root instanceof HTMLElement)) return hints

    const titleEl =
      root.querySelector('[data-page-title], .page-title, h1') ||
      root.querySelector('.react-chat-aside-toolbar-title')
    const pageTitle = _textOf(titleEl)
    if (pageTitle) hints.pageTitle = pageTitle

    const activeTabs = [...root.querySelectorAll('[role="tab"][aria-selected="true"], [role="tab"].is-active')]
      .map((el) => _textOf(el) || el.getAttribute('data-tab') || el.getAttribute('data-settings-tab') || '')
      .map((t) => _clip(t, 40))
      .filter(Boolean)
      .slice(0, 4)
    if (activeTabs.length) hints.activeTabs = activeTabs

    const selected = [
      ...root.querySelectorAll(
        [
          '.im-card.is-selected',
          '.dd-org-row.is-selected',
          '.role-card--selected',
          '[aria-selected="true"].is-selected',
          'tr.is-selected',
          '.is-selected[data-item-id]',
          '.is-selected[data-code]',
          // 主对话侧栏选中行
          '.react-chat-history-item.active[data-shell-session]',
        ].join(', '),
      ),
    ]
      .map((el) => {
        const id =
          el.getAttribute('data-shell-session') ||
          el.getAttribute('data-item-id') ||
          el.getAttribute('data-code') ||
          el.getAttribute('data-id') ||
          el.getAttribute('data-session') ||
          ''
        const titleEl = el.querySelector?.('.react-chat-history-item-title')
        const label = _textOf(titleEl) || _textOf(el)
        return label || id ? { id: id || undefined, label: label || id } : null
      })
      .filter(Boolean)
      .slice(0, 6)
    if (selected.length) hints.selected = selected

    const focus = document.activeElement
    if (focus instanceof HTMLElement && root.contains(focus)) {
      const tag = focus.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || focus.isContentEditable) {
        const name =
          focus.getAttribute('name') ||
          focus.getAttribute('placeholder') ||
          focus.getAttribute('aria-label') ||
          focus.id ||
          tag
        hints.focus = {
          kind: tag === 'textarea' || focus.isContentEditable ? 'editor' : 'input',
          name: _clip(name, 60),
        }
        const val =
          focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement
            ? String(focus.value || '').trim()
            : ''
        if (val) hints.focusDraftPreview = _clip(val, 80)
      }
    }

    const filterChips = [
      ...root.querySelectorAll('.im-chip.is-active, .tasks-status-tab.is-active, [data-status-tab].is-active'),
    ]
      .map((el) => _textOf(el))
      .filter(Boolean)
      .slice(0, 4)
    if (filterChips.length) hints.filters = filterChips
  } catch {
    /* ignore DOM scrape errors */
  }
  return hints
}

/** @type {{ snap: Record<string, unknown>, at: number } | null} */
let _stashedOpenContext = null
const STASH_TTL_MS = 15 * 60 * 1000

/**
 * 打开小V 前若会跳到 /chat，先把当前页快照钉住，避免 send 时只剩「主对话」。
 * @param {Record<string, unknown> | null | undefined} snap
 */
export function stashXiaomiPageContextForOpen(snap) {
  if (!snap || typeof snap !== 'object') {
    _stashedOpenContext = null
    return
  }
  _stashedOpenContext = { snap: { ...snap }, at: Date.now() }
}

/** @returns {Record<string, unknown> | null} */
export function peekStashedXiaomiPageContext() {
  if (!_stashedOpenContext) return null
  if (Date.now() - _stashedOpenContext.at > STASH_TTL_MS) {
    _stashedOpenContext = null
    return null
  }
  return { ..._stashedOpenContext.snap }
}

export function clearStashedXiaomiPageContext() {
  _stashedOpenContext = null
}

/**
 * 小V 发消息用的完整页面快照（写入 session context，不进用户气泡）。
 * @param {string} [rawRoute]
 * @param {Partial<{ label?: string, contextLabel?: string, contextId?: string, contextType?: string, route?: string, module?: string }>} [override]
 */
export function collectXiaomiPageSnapshot(rawRoute, override = {}) {
  const base = extractPageContext(rawRoute)
  const ui = collectVisibleUiHints()
  let label = String(override.contextLabel || override.label || base.label || '').trim()
  let contextType = String(override.contextType || base.contextType || '').trim()
  let contextId = String(override.contextId || base.contextId || '').trim()
  let route = String(override.route || base.route || '').trim()
  let moduleName = String(override.module || base.module || '').trim()

  // 从其它功能页点开小V 会先跳到 /chat：用打开前的钉住快照恢复「用户本来在哪」。
  const stashed = peekStashedXiaomiPageContext()
  const liveIsChat = moduleName === 'chat' || route === '/chat' || route === '/chat-react'
  if (stashed && liveIsChat) {
    const stashMod = String(stashed.module || '').trim()
    const stashRoute = String(stashed.route || '').trim()
    const stashIsChat = stashMod === 'chat' || stashRoute === '/chat' || stashRoute === '/chat-react'
    if (!stashIsChat && (stashMod || stashRoute || stashed.label)) {
      if (!override.module && stashMod) moduleName = stashMod
      if (!override.route && stashRoute) route = stashRoute
      if (!override.contextType && stashed.contextType) contextType = String(stashed.contextType)
      if (!override.contextId && stashed.contextId) contextId = String(stashed.contextId)
      if (!override.label && !override.contextLabel && stashed.label) label = String(stashed.label)
      if (stashed.ui && typeof stashed.ui === 'object' && !Object.keys(ui).length) {
        Object.assign(ui, /** @type {Record<string, unknown>} */ (stashed.ui))
      }
    }
  }

  // 主对话：把左侧当前会话写进 chat 块；模块仍是 chat 时再抬升为实体 id。
  const chatHint = collectActiveChatSessionHint()
  if (chatHint) {
    ui.chatSession = {
      sessionKey: chatHint.sessionKey,
      title: chatHint.title || undefined,
      runState: chatHint.runState || 'idle',
    }
    if (!override.contextId && moduleName === 'chat') {
      contextType =
        contextType === 'workspace' || !contextType ? 'chat_session' : contextType
      contextId = chatHint.sessionKey
      if (!override.label && !override.contextLabel) {
        label = chatHint.title ? `主对话 · ${chatHint.title}` : label || '主对话'
      }
    }
  }

  // 路过 / 点击留痕：route 当「路过」；click/select 保留实体，便于注入「用户刚点了啥」。
  const recent = getRecentUiActivities(12)
    .filter((a) => {
      const mod = String(a.module || '').trim()
      if (a.type === 'route') {
        // 其它模块的路过可留；当前屏同模块 route 降噪
        if (moduleName && mod === moduleName) return false
        return true
      }
      return true
    })
    .map((a) => ({
      type: a.type,
      module: a.module,
      label: a.label,
      entityId: a.entityId,
      entityType: a.entityType,
      detail: a.detail || a.target,
      at: a.at,
    }))
    .filter((a) => Boolean(a.type || a.label || a.entityId || a.detail))

  /** @type {Record<string, unknown>} */
  const snap = {
    version: 1,
    capturedAt: Date.now(),
    module: moduleName || undefined,
    route: route || undefined,
    contextType: contextType || undefined,
    contextId: contextId || undefined,
    label: label || undefined,
    ui: Object.keys(ui).length ? ui : undefined,
    chat: ui.chatSession || undefined,
    recentActivity: recent.length ? recent : undefined,
  }

  for (const k of Object.keys(snap)) {
    if (snap[k] == null || snap[k] === '') delete snap[k]
  }
  return snap
}

/** 适合「左侧模块 + 右侧小V 引导」的页面 */
export function isModuleGuideRoute(rawRoute) {
  const ctx = extractPageContext(rawRoute)
  const mod = String(ctx.module || '')
  return ['employees', 'knowledge', 'workflow', 'tasks', 'items', 'settings', 'automation'].includes(mod)
}

/**
 * 当前模块下的快捷引导话术（点一下填入输入框，不自动发送）
 * @param {string} [rawRoute]
 * @returns {{ id: string, label: string, prompt: string }[]}
 */
export function moduleGuideSuggestions(rawRoute) {
  const ctx = extractPageContext(rawRoute)
  const mod = String(ctx.module || '')
  if (mod === 'workflow') {
    return [
      { id: 'wf-create', label: '创建工作流', prompt: '帮我创建一个工作流，先问我目标和步骤' },
      { id: 'wf-edit', label: '修改当前工作流', prompt: '根据当前打开的工作流，帮我修改参数或步骤' },
      { id: 'wf-run', label: '运行工作流', prompt: '帮我运行当前工作流，缺参数先问我' },
    ]
  }
  if (mod === 'employees') {
    return [
      { id: 'emp-hire', label: '创建员工', prompt: '帮我创建一个智能体员工，先问我岗位职责' },
      { id: 'emp-manage', label: '管理员工', prompt: '帮我查看并调整当前员工的职责或排班' },
      { id: 'emp-dispatch', label: '派发任务', prompt: '帮我给合适的员工派发一项工作' },
    ]
  }
  if (mod === 'knowledge') {
    return [
      { id: 'kb-create', label: '创建知识库', prompt: '帮我创建一个知识库，先问我用途和来源' },
      { id: 'kb-manage', label: '管理知识库', prompt: '帮我整理或更新当前知识库内容' },
      { id: 'kb-search', label: '检索知识', prompt: '在知识库里帮我查找相关内容' },
    ]
  }
  if (mod === 'items' || mod === 'tasks') {
    return [
      { id: 'item-add', label: '记一条待办', prompt: '帮我记一条待办事项' },
      { id: 'item-dispatch', label: '派发待办', prompt: '把这条待办派给合适的员工去做' },
      { id: 'task-status', label: '查任务进度', prompt: '帮我看看进行中的任务卡在哪里' },
    ]
  }
  if (mod === 'settings') {
    return [
      { id: 'set-model', label: '改默认模型', prompt: '帮我调整系统默认模型' },
      { id: 'set-appearance', label: '改外观', prompt: '帮我调整界面外观设置' },
    ]
  }
  if (mod === 'automation') {
    return [
      { id: 'auto-create', label: '新建自动化', prompt: '帮我创建一个自动化任务，先问我触发条件和要做的事' },
      { id: 'auto-list', label: '查看自动化', prompt: '帮我看看当前有哪些自动化任务和最近运行情况' },
      { id: 'auto-fix', label: '改当前任务', prompt: '根据当前自动化页面，帮我修改调度或动作' },
    ]
  }
  if (mod === 'chat') {
    return [
      { id: 'chat-status', label: '今日汇报', prompt: '请根据当前系统状态做今日汇报' },
      { id: 'chat-blocked', label: '待推进', prompt: '列出当前受阻或待确认的事项，并给出推进建议' },
      { id: 'chat-help', label: '能帮我做什么', prompt: '简单说说你现在能帮我做什么' },
    ]
  }
  return [
    { id: 'g-status', label: '今日汇报', prompt: '请根据当前系统状态做今日汇报' },
    { id: 'g-help', label: '能帮我做什么', prompt: '简单说说你在当前页面能帮我做什么' },
    { id: 'g-todo', label: '记一条待办', prompt: '帮我记一条待办事项' },
  ]
}

/**
 * 右侧边缘条旁的引导文案（企业产品常见 coach mark）。
 * @param {string} [rawRoute]
 * @returns {{ id: string, title: string, body: string } | null}
 */
export function edgeCoachTip(rawRoute) {
  const ctx = extractPageContext(rawRoute)
  const mod = String(ctx.module || '') || 'home'
  const id = `edge-${mod}`
  const map = {
    employees: {
      title: '小V 可以协助员工',
      body: '选中员工后，让小V 派活、查进度或改职责。',
    },
    workflow: {
      title: '小V 可以协助工作流',
      body: '打开工作流后，让小V 改参数、排查问题或直接运行。',
    },
    knowledge: {
      title: '小V 可以协助知识库',
      body: '建库、检索、整理内容，都可以直接跟小V 说。',
    },
    items: {
      title: '小V 可以协助事项',
      body: '记待办、派给员工、跟进进度，点右侧打开小V。',
    },
    tasks: {
      title: '小V 可以协助任务',
      body: '问卡点、催办、看谁在忙，交给右侧小V。',
    },
    settings: {
      title: '小V 可以协助设置',
      body: '改模型、外观或其它配置，用白话跟小V 说即可。',
    },
    automation: {
      title: '小V 可以协助自动化',
      body: '新建调度、改触发条件、查最近运行，点右侧打开小V。',
    },
    chat: {
      title: '小V 在侧边随时待命',
      body: '不想打断主对话时，用右侧小V 问进度或管平台。',
    },
    home: {
      title: '小V 在右侧协助你',
      body: '点边缘「小V」打开：问进度、建事项、管员工与知识库。',
    },
  }
  const tip = map[mod] || map.home
  return { id, title: tip.title, body: tip.body }
}

/** Routes where 小V floating UI must stay hidden */
export function shouldHideAssistant(rawRoute) {
  const path = String(rawRoute ?? getCurrentRoute() ?? '')
    .split('?')[0]
    .replace(/^\//, '')
  return (
    path === 'login' ||
    path === 'qr-login' ||
    path === 'setup' ||
    path.startsWith('login/') ||
    path === 'update'
  )
}

/** 供 ui-focus / panel-cdp 免循环依赖读取（须在函数定义之后挂） */
try {
  if (typeof window !== 'undefined') {
    window.__evoflowExtractPageContext = (raw) => extractPageContext(raw)
    window.__evoflowCollectXiaomiPageSnapshot = (raw, ov) => collectXiaomiPageSnapshot(raw, ov)
  }
} catch {
  /* ignore */
}
