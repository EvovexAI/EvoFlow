/**
 * 从 hash 路由提取页面上下文（仅 ID / 类型，不读 DOM）
 */
import { getCurrentRoute } from '../../router.js'
import { getRecentPageActivities } from '../../lib/page-activity.js'

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
      return {
        route: path,
        contextType: 'knowledge_note',
        contextId: decodeURIComponent(m[1]),
        label: `知识 · ${decodeURIComponent(m[1])}`,
        module: 'knowledge',
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
 * 从左侧主内容区刮取可见 UI 信号（选中项、活动 Tab、标题、焦点控件）。
 * 有意保守：只读标注过的结构，避免整页 DOM 倾倒。
 */
function collectVisibleUiHints() {
  /** @type {Record<string, unknown>} */
  const hints = {}
  try {
    const root = document.querySelector('#content') || document.body
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
        '.im-card.is-selected, .dd-org-row.is-selected, .role-card--selected, [aria-selected="true"].is-selected, tr.is-selected, .is-selected[data-item-id], .is-selected[data-code]',
      ),
    ]
      .map((el) => {
        const id =
          el.getAttribute('data-item-id') ||
          el.getAttribute('data-code') ||
          el.getAttribute('data-id') ||
          el.getAttribute('data-session') ||
          ''
        const label = _textOf(el)
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

/**
 * 小V 发消息用的完整页面快照（写入 session context，不进用户气泡）。
 * @param {string} [rawRoute]
 * @param {Partial<{ label?: string, contextLabel?: string, contextId?: string, contextType?: string, route?: string, module?: string }>} [override]
 */
export function collectXiaomiPageSnapshot(rawRoute, override = {}) {
  const base = extractPageContext(rawRoute)
  const ui = collectVisibleUiHints()
  const label = String(override.contextLabel || override.label || base.label || '').trim()
  const contextType = String(override.contextType || base.contextType || '').trim()
  const contextId = String(override.contextId || base.contextId || '').trim()
  const route = String(override.route || base.route || '').trim()
  const moduleName = String(override.module || base.module || '').trim()

  // 路过记录：不要塞当前屏的 route（会变成「路过：route:主对话」噪声）；
  // 其它模块的 route 也不要（会误导「我在哪」）。只保留当前模块的非 route 操作。
  const recent = getRecentPageActivities(8)
    .filter((a) => {
      if (a.type === 'route') return false
      const mod = String(a.module || '').trim()
      if (!moduleName || !mod) return true
      return mod === moduleName
    })
    .map((a) => ({
      type: a.type,
      module: a.module,
      label: a.label,
      entityId: a.entityId,
      detail: a.detail,
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
  return ['employees', 'knowledge', 'workflow', 'tasks', 'items', 'settings'].includes(mod)
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
