/**
 * Developer Agents API client (EVO-0006).
 * Backend: /api/developer-agents
 *
 * Returns credential-free readiness only — never surface API keys, tokens,
 * account emails, or raw CLI output in the UI.
 */

import { gatewayProxy } from './tauri-api.js'

/**
 * @typedef {'ready' | 'authentication_required' | 'unavailable' | 'unhealthy' | string} DeveloperAgentStatus
 *
 * @typedef {object} DeveloperAgent
 * @property {string} [provider]
 * @property {boolean} [available]
 * @property {boolean} [authenticated]
 * @property {DeveloperAgentStatus} [status]
 * @property {string | null} [version]
 * @property {string | null} [executable_path]
 * @property {string | null} [detail]
 */

/**
 * List local developer agents and their last known readiness.
 * @returns {Promise<{ agents: DeveloperAgent[] }>}
 */
export async function listDeveloperAgents() {
  return gatewayProxy('GET', '/developer-agents', null, null, { preferGatewayHttp: true })
}

/**
 * Re-run the Cursor CLI preflight check.
 * @returns {Promise<DeveloperAgent>}
 */
export async function preflightCursorAgent() {
  return gatewayProxy('POST', '/developer-agents/cursor/preflight', null, null, {
    preferGatewayHttp: true,
    skipDedup: true,
  })
}

/**
 * Human-readable Chinese label for a preflight status.
 * @param {DeveloperAgentStatus | null | undefined} status
 * @returns {string}
 */
export function developerAgentStatusLabel(status) {
  switch (String(status || '')) {
    case 'ready':
      return '已连接'
    case 'authentication_required':
      return '需要登录'
    case 'unavailable':
      return '未安装'
    case 'unhealthy':
      return '异常'
    default:
      return '未知'
  }
}

/**
 * CSS modifier for status badge (reuses security-center badge tones).
 * @param {DeveloperAgentStatus | null | undefined} status
 * @returns {'ok' | 'warn' | 'danger' | 'muted'}
 */
export function developerAgentStatusTone(status) {
  switch (String(status || '')) {
    case 'ready':
      return 'ok'
    case 'authentication_required':
      return 'warn'
    case 'unhealthy':
      return 'danger'
    case 'unavailable':
    default:
      return 'muted'
  }
}

/**
 * Pick the Cursor agent entry from a list response.
 * @param {{ agents?: DeveloperAgent[] } | null | undefined} payload
 * @returns {DeveloperAgent | null}
 */
export function pickCursorAgent(payload) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : []
  return agents.find((a) => String(a?.provider || '').toLowerCase() === 'cursor') || agents[0] || null
}
