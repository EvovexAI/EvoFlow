/**
 * Global tool approval policy (Gateway ``/api/settings/tool-approval``).
 */

import {
  TOOL_APPROVAL_POLICY_GRANT_ALL,
  TOOL_APPROVAL_POLICY_PROMPT,
  TOOL_APPROVAL_POLICY_SESSION,
} from './tool-approval.js'

import { gatewayProxy } from './tauri-api.js'

const API_GLOBAL = '/settings/tool-approval'

/** @type {{ defaultPolicy: string, validPolicies: string[] } | null} */
let _cache = null

export { TOOL_APPROVAL_POLICY_PROMPT, TOOL_APPROVAL_POLICY_SESSION, TOOL_APPROVAL_POLICY_GRANT_ALL }

export const TOOL_APPROVAL_POLICY_CHANGED = 'evopanel:tool-approval-policy-changed'
export const TOOL_APPROVAL_SESSION_POLICY_CHANGED = 'evopanel:tool-approval-session-policy-changed'

export function isToolApprovalDisabled(policy) {
  return String(policy || '').trim().toLowerCase() === TOOL_APPROVAL_POLICY_GRANT_ALL
}

/** Session effective policy: explicit session override wins, then API effective, else global default. */
export function isEffectiveToolApprovalGrantAll(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  const session = String(c.tool_approval_policy || '').trim().toLowerCase()
  if (session === TOOL_APPROVAL_POLICY_GRANT_ALL) return true
  if (session === TOOL_APPROVAL_POLICY_SESSION) return false
  if (session === TOOL_APPROVAL_POLICY_PROMPT) return false
  const eff = String(c.effective_tool_approval_policy || '').trim().toLowerCase()
  if (eff === TOOL_APPROVAL_POLICY_GRANT_ALL) return true
  if (eff === TOOL_APPROVAL_POLICY_SESSION) return false
  if (eff === TOOL_APPROVAL_POLICY_PROMPT) return false
  return isToolApprovalDisabled(getCachedGlobalToolApprovalPolicy())
}

/** True when session effective policy is "session" (approve once per tool name). */
export function isEffectiveToolApprovalSession(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  const session = String(c.tool_approval_policy || '').trim().toLowerCase()
  if (session === TOOL_APPROVAL_POLICY_SESSION) return true
  if (session === TOOL_APPROVAL_POLICY_GRANT_ALL) return false
  if (session === TOOL_APPROVAL_POLICY_PROMPT) return false
  const eff = String(c.effective_tool_approval_policy || '').trim().toLowerCase()
  if (eff === TOOL_APPROVAL_POLICY_SESSION) return true
  if (eff === TOOL_APPROVAL_POLICY_GRANT_ALL) return false
  if (eff === TOOL_APPROVAL_POLICY_PROMPT) return false
  return getCachedGlobalToolApprovalPolicy() === TOOL_APPROVAL_POLICY_SESSION
}

function dispatchToolApprovalPolicyChanged() {
  try {
    window.dispatchEvent(
      new CustomEvent(TOOL_APPROVAL_POLICY_CHANGED, { detail: { defaultPolicy: _cache?.defaultPolicy } }),
    )
  } catch {
    /* ignore */
  }
}

export async function fetchGlobalToolApprovalPolicy() {
  const data = await gatewayProxy('GET', API_GLOBAL, null, null, { preferGatewayHttp: true })
  const defaultPolicy = String(data?.default_policy || TOOL_APPROVAL_POLICY_SESSION).trim()
  const validPolicies = Array.isArray(data?.valid_policies)
    ? data.valid_policies.map((x) => String(x).trim()).filter(Boolean)
    : [TOOL_APPROVAL_POLICY_PROMPT, TOOL_APPROVAL_POLICY_GRANT_ALL]
  _cache = { defaultPolicy, validPolicies }
  dispatchToolApprovalPolicyChanged()
  return _cache
}

export function getCachedGlobalToolApprovalPolicy() {
  return _cache?.defaultPolicy || TOOL_APPROVAL_POLICY_SESSION
}

/** Explicit per-session override only (null = inherit global default). */
export function getSessionToolApprovalOverride(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  const raw = String(c.tool_approval_policy || '').trim().toLowerCase()
  if (raw === TOOL_APPROVAL_POLICY_GRANT_ALL) return TOOL_APPROVAL_POLICY_GRANT_ALL
  if (raw === TOOL_APPROVAL_POLICY_SESSION) return TOOL_APPROVAL_POLICY_SESSION
  if (raw === TOOL_APPROVAL_POLICY_PROMPT) return TOOL_APPROVAL_POLICY_PROMPT
  return null
}

/** UI badge / menu: only explicit session grant_all shows「完全访问」. */
export function isSessionToolApprovalGrantAllOverride(ctx) {
  return getSessionToolApprovalOverride(ctx) === TOOL_APPROVAL_POLICY_GRANT_ALL
}

export async function patchGlobalToolApprovalPolicy(defaultPolicy) {
  const data = await gatewayProxy('PATCH', API_GLOBAL, { default_policy: String(defaultPolicy || '').trim() })
  _cache = {
    defaultPolicy: String(data?.default_policy || defaultPolicy).trim(),
    validPolicies: Array.isArray(data?.valid_policies) ? data.valid_policies : [],
  }
  dispatchToolApprovalPolicyChanged()
  return _cache
}

function dispatchSessionToolApprovalPolicyChanged(detail) {
  try {
    window.dispatchEvent(new CustomEvent(TOOL_APPROVAL_SESSION_POLICY_CHANGED, { detail }))
  } catch {
    /* ignore */
  }
}

export async function fetchSessionToolApprovalPolicy(sessionKey) {
  const sk = String(sessionKey || '').trim()
  if (!sk) throw new Error('session_key required')
  const path = `${API_GLOBAL}/sessions/${encodeURIComponent(sk)}`
  const data = await gatewayProxy('GET', path)
  return normalizeSessionPolicyResponse(data, sk)
}

/**
 * Per-session tool approval override (Gateway ``/api/settings/tool-approval/sessions/{key}``).
 * @param {string} sessionKey
 * @param {string | null} toolApprovalPolicy ``grant_all`` | ``prompt`` | ``session`` | ``null`` to clear override
 */
export async function patchSessionToolApprovalPolicy(sessionKey, toolApprovalPolicy) {
  const sk = String(sessionKey || '').trim()
  if (!sk) throw new Error('session_key required')
  const path = `${API_GLOBAL}/sessions/${encodeURIComponent(sk)}`
  const body =
    toolApprovalPolicy == null || String(toolApprovalPolicy).trim() === ''
      ? { tool_approval_policy: null }
      : { tool_approval_policy: String(toolApprovalPolicy).trim() }
  const data = await gatewayProxy('PATCH', path, body)
  const out = normalizeSessionPolicyResponse(data, sk)
  dispatchSessionToolApprovalPolicyChanged(out)
  return out
}

/** runtime preset: read-only | default | full-access */
export async function patchSessionPermissionPreset(sessionKey, preset) {
  const sk = String(sessionKey || '').trim()
  if (!sk) throw new Error('session_key required')
  const path = `${API_GLOBAL}/sessions/${encodeURIComponent(sk)}`
  const body =
    preset == null || String(preset).trim() === ''
      ? { permission_preset: null }
      : { permission_preset: String(preset).trim() }
  const data = await gatewayProxy('PATCH', path, body)
  const out = normalizeSessionPolicyResponse(data, sk)
  dispatchSessionToolApprovalPolicyChanged(out)
  return out
}

function normalizeSessionPolicyResponse(data, sk) {
  return {
    session_key: String(data?.session_key || sk).trim(),
    tool_approval_policy:
      data?.tool_approval_policy == null || String(data.tool_approval_policy).trim() === ''
        ? null
        : String(data.tool_approval_policy).trim(),
    effective_policy: String(data?.effective_policy || '').trim(),
    permission_preset:
      data?.permission_preset == null || String(data.permission_preset).trim() === ''
        ? null
        : String(data.permission_preset).trim(),
    effective_permission_preset: String(
      data?.effective_permission_preset || data?.permission_preset || 'default',
    ).trim(),
  }
}
