/**
 * Settings hub tab hover warm: dynamic-import the pane module (and optional API)
 * before the user clicks, same idea as shell-nav / session-list prefetch.
 */
import { warmNavKey } from './nav-panel-prefetch.js'

/** @type {Set<string>} */
const _modWarmed = new Set()

/** Literal import() map — keep in sync with pages/settings/hub.js ensurePanelMounted. */
const TAB_LOADERS = {
  general: () => import('../pages/general.js'),
  models: () => import('../pages/models.js'),
  search: () => import('../pages/settings/web-search.js'),
  im: () => import('../pages/channels.js'),
  shortcuts: () => import('../pages/settings/shortcuts.js'),
  usage: () => import('../pages/settings/usage.js'),
  resources: () => import('../pages/settings/resources.js'),
  'code-index': () => import('../pages/settings/code-index.js'),
  about: () => import('../pages/about.js'),
  security: () => import('../pages/settings/security.js'),
  api: () => import('../pages/settings/remote.js'),
  users: () => import('../pages/settings/users.js'),
  sso: () => import('../pages/settings/sso.js'),
  license: () => import('../pages/settings/license.js'),
}

function warmTabModule(tab) {
  const t = String(tab || '')
  if (!t || _modWarmed.has(t)) return
  const load = TAB_LOADERS[t]
  if (!load) return
  _modWarmed.add(t)
  void load().catch(() => {
    _modWarmed.delete(t)
  })
}

async function warmTabApis(tab) {
  const { api } = await import('./tauri-api.js')
  switch (String(tab || '')) {
    case 'models':
      warmNavKey('settings:models', () => api.listModels())
      break
    case 'im':
      warmNavKey('settings:channels', () => api.getChannelsStatus())
      break
    case 'security':
      warmNavKey('settings:security', async () => {
        const { fetchSecuritySettings, fetchSecurityAudit } = await import('./security-settings.js')
        const { fetchGlobalToolApprovalPolicy } = await import('./tool-approval-settings.js')
        const [settingsData, auditData, approval] = await Promise.all([
          fetchSecuritySettings(),
          fetchSecurityAudit({ limit: 100 }).catch(() => ({ records: [] })),
          fetchGlobalToolApprovalPolicy().catch(() => null),
        ])
        return { settingsData, auditData, approval }
      })
      break
    default:
      break
  }
}

/**
 * @param {string} tab settings tab id (general / models / …)
 */
export function prefetchSettingsTab(tab) {
  const t = String(tab || '').trim()
  if (!t) return
  warmTabModule(t)
  void warmTabApis(t)
}

/** Idle / open-settings: warm hub shell + the most common tabs. */
export function prefetchCommonSettingsTabs() {
  for (const t of ['general', 'models', 'search', 'im', 'security']) {
    prefetchSettingsTab(t)
  }
}
