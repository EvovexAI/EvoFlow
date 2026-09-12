/**
 * 联网搜索：凭据 + 首选引擎（SQLite key ``web.search``）
 *
 * 读写/测通一律走后端通用接口 ``POST /api/platform``（与助手 platform 工具同源）：
 * - settings.get_web_search
 * - settings.patch_web_search（confirm=true）
 * - settings.test_web_search（confirm=true）—— 实际 httpx 探测在 Gateway 进程内执行
 *
 * 桌面端经 Rust ``gateway_proxy`` 转发到本机 Gateway，避免 webview 裸 fetch Failed to fetch。
 */

import { gatewayProxy } from './tauri-api.js'

/** @type {Record<string, unknown> | null} */
let _cache = null
/** @type {import('./web-search-settings.js').WebSearchSnapshot | null} */
let _snapshot = null

/**
 * @typedef {{
 *   settings: Record<string, unknown>,
 *   providers: Array<{
 *     id: string,
 *     label?: string,
 *     available: boolean,
 *     plan_sourced?: boolean,
 *     plan_needs_key?: boolean,
 *   }>,
 *   active_backend: string | null,
 *   active_source: string,
 *   agent_plan_web_search?: {
 *     catalog_id?: string,
 *     binding_id?: string,
 *     tier_id?: string,
 *     label?: string,
 *     title?: string,
 *     hint?: string,
 *     engine?: string,
 *     engine_label?: string,
 *     doubao_key_configured?: boolean,
 *     needs_search_key?: boolean,
 *     preferred_is_doubao?: boolean,
 *     harness_console_url?: string,
 *     docs_url?: string,
 *     standalone_console_url?: string,
 *     steps?: string[],
 *   } | null,
 *   provider_ui: Array<Record<string, string>>,
 * }} WebSearchSnapshot
 */

export const DEFAULT_WEB_SEARCH_SETTINGS = {
  preferredBackend: '',
  preferredBackendSource: '',
  doubaoKeySource: '',
  doubaoApiKey: '',
  doubaoBaseUrl: '',
  bochaApiKey: '',
  bochaBaseUrl: '',
  tavilyApiKey: '',
  tavilyBaseUrl: '',
  braveApiKey: '',
  firecrawlApiKey: '',
  firecrawlApiUrl: '',
  infoquestApiKey: '',
  searxngUrl: '',
}

function mergeSettings(base, patch) {
  const next = { ...base, ...(patch || {}) }
  if (patch?._configured && typeof patch._configured === 'object') {
    next._configured = { ...(base._configured || {}), ...patch._configured }
  }
  return next
}

function snapshotFromData(data) {
  const settings = mergeSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS }, data?.settings || {})
  _cache = settings
  _snapshot = {
    settings,
    providers: data?.providers || [],
    active_backend: data?.active_backend ?? null,
    active_source: data?.active_source || 'auto',
    agent_plan_web_search: data?.agent_plan_web_search ?? null,
    provider_ui: data?.provider_ui || [],
  }
  return _snapshot
}

/**
 * 后端通用 platform 接口（与助手 platform 工具同一套 action）。
 * @param {string} action
 * @param {Record<string, unknown>} [args]
 * @param {{ confirm?: boolean }} [opts]
 */
async function invokePlatform(action, args = {}, opts = {}) {
  const confirm = !!opts.confirm
  const data = await gatewayProxy('POST', '/platform', {
    action,
    args: args && typeof args === 'object' ? args : {},
    confirm,
  })
  if (data && data.ok === false) {
    const msg =
      data.error ||
      data.hint ||
      (data.pending_confirm ? '需要确认后才能执行写操作' : 'platform action failed')
    const err = new Error(String(msg))
    err.gatewayResult = data
    throw err
  }
  return data
}

/**
 * @returns {Promise<WebSearchSnapshot>}
 */
export async function fetchWebSearchSettings() {
  const data = await invokePlatform('settings.get_web_search')
  return snapshotFromData(data)
}

export function getCachedWebSearchSettings() {
  return _cache ? { ..._cache } : null
}

export function getCachedWebSearchSnapshot() {
  return _snapshot ? { ..._snapshot } : null
}

/**
 * @param {Record<string, string>} patch
 */
export async function patchWebSearchSettings(patch) {
  // UI 已由用户改表单，直接 confirm=true 落盘（与助手预览后再确认不同）
  const data = await invokePlatform('settings.patch_web_search', patch || {}, { confirm: true })
  return snapshotFromData(data)
}

/**
 * 后端测通各搜索引擎（Gateway 进程内 httpx，不经浏览器直连外网搜索 API）。
 * @param {{ query?: string, engines?: string[] | null, max_results?: number, adopt_recommended?: boolean }} body
 */
export async function testWebSearch(body = {}) {
  return invokePlatform(
    'settings.test_web_search',
    {
      query: body.query || '今天 AI 新闻',
      engines: body.engines ?? null,
      max_results: body.max_results ?? 5,
      adopt_recommended: !!body.adopt_recommended,
    },
    { confirm: true },
  )
}

export function isFieldConfigured(settings, field) {
  const cfg = settings?._configured
  if (cfg && typeof cfg[field] === 'boolean') return cfg[field]
  const v = settings?.[field]
  return !!(v && String(v).includes('*'))
}

export function maskedSecretHint(settings, field) {
  if (!isFieldConfigured(settings, field)) return null
  const v = String(settings?.[field] || '').trim()
  if (v && v.includes('*')) return v
  return '已配置'
}

export function sourceLabel(source) {
  switch (source) {
    case 'settings':
      return '设置表（你选的）'
    case 'auto':
      return '自动探测'
    case 'agent_plan':
      return 'Agent Plan 默认（豆包）'
    case 'none':
      return '未就绪'
    default:
      return source || '未知'
  }
}

export function activeBackendLabel(backend, snap) {
  const id = String(backend || '').trim()
  const plan = snap?.agent_plan_web_search
  if (id === 'doubao' && plan) {
    const tier = String(plan.tier_id || '').trim()
    const tierText = tier ? ` · ${tier}` : ''
    if (plan.needs_search_key) {
      return `豆包搜索（Agent Plan 赠送${tierText} · 待填联网 Key）`
    }
    return `豆包搜索（Agent Plan 赠送${tierText}）`
  }
  if (id === 'agent_plan') {
    const tier = String(plan?.tier_id || '').trim()
    return tier ? `豆包搜索（Agent Plan · ${tier}）` : '豆包搜索（Agent Plan）'
  }
  const labels = {
    doubao: '豆包搜索',
    bocha: '博查搜索',
    tavily: 'Tavily',
    'brave-free': 'Brave Search',
    searxng: 'SearXNG',
    firecrawl: 'Firecrawl',
    infoquest: 'InfoQuest',
    ddgs: 'DDGS',
  }
  return labels[id] || id || '—'
}
