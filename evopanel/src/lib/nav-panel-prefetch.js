/**
 * Side-nav hover warm for heavy panels (任务 / 工作流 / 智能体 / 员工 / 自动化 / 知识库 / 资产 / 扩展).
 * Mirrors session-list hover prefetch: module chunk + short-TTL API cache
 * so click can paint without waiting on cold dynamic import + queries.
 */
import { prefetchRoute } from '../router.js'

const TTL_MS = 45_000
/** @type {Map<string, { at: number, data: unknown }>} */
const _warm = new Map()
/** @type {Map<string, Promise<unknown>>} */
const _inflight = new Map()
/** @type {Set<string>} */
const _modWarmed = new Set()

/** @param {string} key */
export function takeNavWarm(key) {
  const k = String(key || '')
  const hit = _warm.get(k)
  if (!hit) return null
  _warm.delete(k) // one-shot: hover warm serves the next open only
  if (Date.now() - hit.at > TTL_MS) return null
  return hit.data
}

/** Peek without consuming (for warmKey dedup). */
export function hasNavWarm(key) {
  const k = String(key || '')
  const hit = _warm.get(k)
  if (!hit) return false
  if (Date.now() - hit.at > TTL_MS) {
    _warm.delete(k)
    return false
  }
  return true
}

/**
 * Shared warm helper — also used by settings-tab-prefetch.
 * @param {string} key
 * @param {() => Promise<unknown>} fetcher
 */
export function warmNavKey(key, fetcher) {
  const k = String(key || '')
  if (!k) return
  if (hasNavWarm(k)) return
  if (_inflight.has(k)) return
  const job = (async () => {
    try {
      const data = await fetcher()
      putNavWarm(k, data)
      return data
    } catch {
      return null
    } finally {
      _inflight.delete(k)
    }
  })()
  _inflight.set(k, job)
}

/** @param {string} key @param {unknown} data */
export function putNavWarm(key, data) {
  _warm.set(String(key || ''), { at: Date.now(), data })
}

/**
 * @param {string} key
 * @param {() => Promise<unknown>} fetcher
 */
function warmKey(key, fetcher) {
  warmNavKey(key, fetcher)
}

function warmModule(path) {
  const p = String(path || '').split('?')[0]
  if (!p || _modWarmed.has(p)) return
  _modWarmed.add(p)
  void prefetchRoute(p)
}

async function warmProactiveData() {
  const { api } = await import('./tauri-api.js')
  warmKey('proactive:status', () => api.proactiveStatus())
  warmKey('proactive:roles', () => api.proactiveListRoles())
  warmKey('proactive:approvals', () => api.proactiveListApprovals('pending'))
  warmKey('proactive:initiatives', () => api.proactiveListInitiatives({ limit: 50 }))
  warmKey('proactive:agents', () => api.listAgents())
}

async function warmKnowledgeData() {
  const { api } = await import('./tauri-api.js')
  warmKey('knowledge:bases', () => api.listOwnedKnowledgeBases())
}

async function warmAssetsData() {
  const { api } = await import('./tauri-api.js')
  warmKey('assets:init', () => api.assetsInit())
}

async function warmExtensionsData() {
  const mod = await import('./ui-extensions.js')
  warmKey('extensions:list', () => mod.listUiExtensions())
}

/** Same three reads as cron.js refresh() — hover can finish before click. */
async function warmCronData() {
  const { api } = await import('./tauri-api.js')
  warmKey('cron:list', () => api.automationList())
  warmKey('cron:feishu-push-default', () =>
    api.automationFeishuPushDefault().catch(() => ({ targets: [] })),
  )
  warmKey('cron:scheduler-status', () =>
    api.automationSchedulerStatus().catch(() => null),
  )
}

function warmCronPanel() {
  warmModule('/cron')
  void warmCronData()
}

async function warmAppsData() {
  const { api } = await import('./tauri-api.js')
  warmKey('apps:list', () => api.listApps())
}

async function warmTasksData() {
  const { api } = await import('./tauri-api.js')
  warmKey('tasks:list', () => api.listAllTasks({ hide_noise: 'true' }))
  warmKey('tasks:agents', () => api.listAgents().catch(() => []))
  warmKey('tasks:roles', () => api.proactiveListRoles().catch(() => ({})))
}

async function warmExpertData() {
  const { api } = await import('./tauri-api.js')
  // Default expert tab is agents — warm its chunk + the same four reads agents.js reload uses.
  void import('../pages/agents.js').catch(() => {})
  warmKey('expert:agents', () => api.listAgents())
  warmKey('expert:roles', () => api.proactiveListRoles().catch(() => ({ roles: [] })))
  warmKey('expert:apps', () => api.listApps().catch(() => []))
  warmKey('expert:automations', () => api.automationList().catch(() => ({ automations: [] })))
}

const PATH_WARMERS = {
  '/proactive': () => {
    warmModule('/proactive')
    void warmProactiveData()
  },
  '/knowledge': () => {
    warmModule('/knowledge')
    void warmKnowledgeData()
  },
  '/knowledge/owned': () => {
    warmModule('/knowledge')
    void warmKnowledgeData()
  },
  '/assets': () => {
    warmModule('/assets')
    void warmAssetsData()
  },
  '/extensions': () => {
    warmModule('/extensions')
    void warmExtensionsData()
  },
  '/expert': () => {
    warmModule('/expert')
    void warmExpertData()
  },
  '/apps': () => {
    warmModule('/apps')
    void warmAppsData()
  },
  '/tasks': () => {
    warmModule('/tasks')
    void warmTasksData()
  },
  '/cron': warmCronPanel,
  '/automation': warmCronPanel,
}

/** Prefetch when user expands「更多」— cron / knowledge / assets / extensions live there. */
export function prefetchMoreNavPanels() {
  warmModule('/cron')
  warmModule('/knowledge')
  warmModule('/assets')
  warmModule('/extensions')
  void warmCronData()
  void warmKnowledgeData()
  void warmAssetsData()
  void warmExtensionsData()
}

/**
 * @param {string} path hash path like `/proactive` or `/assets`
 */
export function prefetchShellNav(path) {
  const p = String(path || '').split('?')[0]
  if (!p) return
  const run = PATH_WARMERS[p]
  if (run) run()
  else warmModule(p)
}
