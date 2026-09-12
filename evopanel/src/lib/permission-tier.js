/**
 * runtime permission presets — unified sandbox profile + tool approval (session scope).
 * Session approval presets: Read Only | Default | Full Access.
 */

import {
  TOOL_APPROVAL_POLICY_GRANT_ALL,
  TOOL_APPROVAL_POLICY_PROMPT,
  TOOL_APPROVAL_POLICY_SESSION,
  getCachedGlobalToolApprovalPolicy,
  getSessionToolApprovalOverride,
} from './tool-approval-settings.js'

export const PERMISSION_PRESET_READ_ONLY = 'read-only'
export const PERMISSION_PRESET_DEFAULT = 'default'
export const PERMISSION_PRESET_FULL_ACCESS = 'full-access'

/** @typedef {'read-only' | 'default' | 'full-access'} PermissionPresetId */

/** @type {Array<{ id: PermissionPresetId, label: string, labelEn: string, pillLabel: string, menuDesc: string, icon: 'hand' | 'shield' | 'full', desc: string, policy: string }>} */
export const PERMISSION_PRESETS = [
  {
    id: PERMISSION_PRESET_READ_ONLY,
    label: '只读',
    labelEn: 'Read Only',
    pillLabel: '请求批准',
    menuDesc: '编辑文件、运行命令时始终询问',
    icon: 'hand',
    desc: '可读工作区；改文件 / 跑命令需确认；OS 只读沙箱',
    policy: TOOL_APPROVAL_POLICY_PROMPT,
  },
  {
    id: PERMISSION_PRESET_DEFAULT,
    label: '默认',
    labelEn: 'Default',
    pillLabel: '帮我批准',
    menuDesc: '仅对检测到的风险操作请求批准',
    icon: 'shield',
    desc: '可读写工作区；敏感操作按需确认（runtime Agent 模式）',
    policy: TOOL_APPROVAL_POLICY_SESSION,
  },
  {
    id: PERMISSION_PRESET_FULL_ACCESS,
    label: '完全访问',
    labelEn: 'Full Access',
    pillLabel: '完全访问',
    menuDesc: '不再弹出工具审批；关闭 OS 沙箱隔离',
    icon: 'full',
    desc: '关闭 OS 沙箱隔离；本会话不再弹出工具审批',
    policy: TOOL_APPROVAL_POLICY_GRANT_ALL,
  },
]

function normalizePresetId(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return PERMISSION_PRESET_DEFAULT
  if (s === 'readonly' || s === 'read_only') return PERMISSION_PRESET_READ_ONLY
  if (s === 'auto' || s === 'workspace' || s === 'agent') return PERMISSION_PRESET_DEFAULT
  if (s === 'full_access' || s === 'grant_all' || s === 'danger-full-access') {
    return PERMISSION_PRESET_FULL_ACCESS
  }
  if (PERMISSION_PRESETS.some((p) => p.id === s)) return s
  return PERMISSION_PRESET_DEFAULT
}

function presetFromLegacyPolicy(policy) {
  const m = String(policy || '').trim().toLowerCase()
  if (m === TOOL_APPROVAL_POLICY_GRANT_ALL) return PERMISSION_PRESET_FULL_ACCESS
  if (m === TOOL_APPROVAL_POLICY_PROMPT) return PERMISSION_PRESET_READ_ONLY
  return PERMISSION_PRESET_DEFAULT
}

/** Resolve effective runtime preset from session context. */
export function resolvePermissionPreset(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  // Prefer resolved effective preset from API (survives session-list refresh).
  const effective =
    c.effective_permission_preset ??
    c.effectivePermissionPreset ??
    c.effective_codex_preset ??
    c.effectiveCodexPreset ??
    c.effectiveCodexPermissionPreset
  if (effective != null && String(effective).trim()) {
    return normalizePresetId(effective)
  }
  const explicit =
    c.permission_preset ??
    c.permissionPreset ??
    c.codex_permission_preset ??
    c.codexPermissionPreset
  if (explicit != null && String(explicit).trim()) {
    return normalizePresetId(explicit)
  }
  const override = getSessionToolApprovalOverride(c)
  if (override) return presetFromLegacyPolicy(override)
  const eff = String(c.effective_tool_approval_policy || '').trim().toLowerCase()
  if (eff) return presetFromLegacyPolicy(eff)
  return presetFromLegacyPolicy(getCachedGlobalToolApprovalPolicy())
}

/** @param {PermissionPresetId} presetId */
export function permissionPresetLabel(presetId) {
  const row = PERMISSION_PRESETS.find((p) => p.id === presetId)
  return row?.label || '默认'
}

/** Short pill label (ChatGPT-style Chinese on bottom bar). */
export function permissionPresetPillLabel(presetId) {
  const row = PERMISSION_PRESETS.find((p) => p.id === presetId)
  return row?.pillLabel || row?.label || '帮我批准'
}

export function permissionPresetMenuDesc(presetId) {
  const row = PERMISSION_PRESETS.find((p) => p.id === presetId)
  return row?.menuDesc || row?.desc || ''
}

/** @deprecated use permissionPresetPillLabel for bottom bar */
export const chatPermissionTierPillLabel = permissionPresetPillLabel

/** @param {PermissionPresetId} presetId */
export function permissionPresetPolicy(presetId) {
  const row = PERMISSION_PRESETS.find((p) => p.id === presetId)
  return row?.policy || TOOL_APPROVAL_POLICY_SESSION
}

/** @param {PermissionPresetId} presetId */
export function permissionPresetToast(presetId) {
  const row = PERMISSION_PRESETS.find((p) => p.id === presetId)
  const name = row?.pillLabel || row?.label || presetId
  return `本会话已切换为「${name}」`
}

/** One-line hint: sandbox + approval (runtime 两道闸). */
export function formatPermissionPresetHint(presetId, executionSnap) {
  const preset = PERMISSION_PRESETS.find((p) => p.id === presetId)
  const snap = executionSnap && typeof executionSnap === 'object' ? executionSnap : {}
  const enabled = snap.enabled === true
  const active = snap.active === true || enabled
  const auto = snap.auto_enable_when_helpers_ready !== false
  const helpersReady = snap.helpers_ready === true
  const profile = String(snap.profile || snap.active_profile || preset?.id || 'default').trim()
  const parts = []
  parts.push(`审批：${presetId === PERMISSION_PRESET_FULL_ACCESS ? '不询问' : '按需询问'}`)
  if (!active && !enabled && !(auto && helpersReady)) {
    parts.push('主机沙箱：未启用')
  } else if (presetId === PERMISSION_PRESET_FULL_ACCESS || profile.includes('danger')) {
    parts.push('OS 沙箱：已关闭')
  } else if (presetId === PERMISSION_PRESET_READ_ONLY || profile.includes('read')) {
    parts.push('OS 沙箱：只读')
  } else {
    parts.push(auto && !enabled && helpersReady ? 'OS 沙箱：工作空间（自动）' : 'OS 沙箱：工作空间')
  }
  return parts.join(' · ')
}

/** @deprecated use PERMISSION_PRESETS */
export const CHAT_PERMISSION_TIERS = PERMISSION_PRESETS
export const resolveChatPermissionTier = resolvePermissionPreset
export const chatPermissionTierLabel = permissionPresetLabel
export const chatPermissionTierPolicy = permissionPresetPolicy
export const chatPermissionTierToast = permissionPresetToast
export const formatOsSandboxHint = formatPermissionPresetHint
