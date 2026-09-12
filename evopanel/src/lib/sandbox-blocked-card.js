/**
 * Sandbox interception card — structured extraction of sandbox / denylist blocks.
 *
 * Two interception sources render as a structured card instead of a plain
 * "Error: ..." text block:
 *
 *  1. Sandbox path interception — tool output is a plain-text PermissionError
 *     (e.g. "Error: Permission denied reading file: /etc/passwd").  We detect
 *     these by scanning the output text for known permission / traversal
 *     phrases and extract the offending path.
 *
 *  2. Denylist block — tool output is a JSON envelope with
 *     ``_evoflow_tool.status = "blocked"`` and a ``message`` field (produced by
 *     ``tool_approval_middleware._build_denylist_blocked_result``).
 *
 * The card mirrors the risk-badge visual language of ToolApprovalDock /
 * ToolApprovalBar so it feels consistent with the existing approval UI.
 */

import { isToolBlocked, toolBlockedMessage, parseEvoflowToolEnvelope } from './tool-approval.js'

/** Event-type labels shown on the card badge (mirror backend constants). */
export const SANDBOX_EVENT_LABELS = {
  path_traversal: { text: '路径穿越', className: 'risk-confirm' },
  path_denied: { text: '路径拒绝', className: 'risk-confirm' },
  denylist_blocked: { text: '安全策略', className: 'risk-confirm' },
  permission_error: { text: '权限拒绝', className: 'risk-confirm' },
}

/** Phrases that indicate a sandbox path interception in plain-text output. */
const _TRAVERSAL_PHRASES = ['path traversal', '路径穿越', '路径遍历']
const _PERMISSION_PHRASES = [
  'permission denied',
  '权限不足',
  'not allowed',
  'are allowed',
  'access denied',
]

/**
 * Best-effort extraction of a path-like token from a permission error string.
 * Looks for the first quoted path, or a leading-absolute-path token after a
 * colon.
 */
function _extractPathFromErrorText(text) {
  const t = String(text || '')
  // Quoted path: "...path..."  or  '...path...'
  const quoted = t.match(/["'`]([^"'`]+)["'`]/)
  if (quoted && quoted[1] && /[\\/]/.test(quoted[1])) return quoted[1].trim()
  // "reading file: /path"  /  "writing to file: /path"  /  "accessing file: /path"
  const colonPath = t.match(/(?:file|path|directory|dir)[:：]\s*([^\s\r\n]+)/i)
  if (colonPath && colonPath[1]) return colonPath[1].replace(/[.,;]+$/, '').trim()
  // "Only paths under /mnt/user-data/... are allowed"
  const underPath = t.match(/(\/(?:mnt|etc|usr|var|tmp|home|root|opt)[^\s.,;]*)/i)
  if (underPath && underPath[1]) return underPath[1].trim()
  return ''
}

/**
 * Detect a sandbox interception from a tool row and return a structured
 * descriptor for rendering the card, or ``null`` when the tool was not blocked.
 *
 * @param {Record<string, unknown> | null | undefined} tool
 * @returns {{
 *   event_type: string;
 *   reason: string;
 *   path: string;
 *   allowed_hint: string;
 * } | null}
 */
export function extractSandboxBlock(tool) {
  if (!tool || typeof tool !== 'object') return null

  // ── Denylist block (JSON envelope) ───────────────────────────────
  if (isToolBlocked(tool)) {
    const message = toolBlockedMessage(tool)
    return {
      event_type: 'denylist_blocked',
      reason: message || '此工具调用已被安全策略阻止',
      path: '',
      allowed_hint: '请使用更安全的替代方案',
    }
  }

  // ── Sandbox path interception (plain-text PermissionError) ───────
  // Only treat as a sandbox block when the tool failed with a permission /
  // traversal error — not for generic "File not found" etc.
  const status = String(tool.status || '').toLowerCase()
  const isFailed = status === 'error' || status === 'failed'
  if (!isFailed) return null

  const rawOutput = typeof tool.output === 'string' ? tool.output : ''
  if (!rawOutput) return null

  // Skip JSON envelopes that are not "blocked" (handled above) — e.g. media
  // tool errors have their own rendering.
  const meta = parseEvoflowToolEnvelope(tool.output)
  if (meta && String(meta.status || '').toLowerCase() === 'blocked') return null

  const lower = rawOutput.toLowerCase()

  // Path traversal detection
  if (_TRAVERSAL_PHRASES.some((p) => lower.includes(p))) {
    return {
      event_type: 'path_traversal',
      reason: '路径穿越检测：检测到 .. 段，已阻止目录穿越',
      path: _extractPathFromErrorText(rawOutput),
      allowed_hint: '仅允许访问 /mnt/user-data 目录及其子路径',
    }
  }

  // Permission denied / not allowed
  if (_PERMISSION_PHRASES.some((p) => lower.includes(p))) {
    const path = _extractPathFromErrorText(rawOutput)
    // Distinguish "path not in allowed range" vs generic permission error
    const isRangeDenied =
      lower.includes('are allowed') ||
      lower.includes('not allowed') ||
      lower.includes('only paths under')
    return {
      event_type: isRangeDenied ? 'path_denied' : 'permission_error',
      reason: isRangeDenied
        ? '路径不在允许范围内：仅允许访问沙箱授权目录'
        : '安全策略阻止：权限不足，无法访问该路径',
      path,
      allowed_hint: '仅允许 /mnt/user-data 目录（workspace / uploads / outputs）',
    }
  }

  return null
}

/** Whether a tool row should render the sandbox interception card. */
export function hasSandboxBlock(tool) {
  return extractSandboxBlock(tool) != null
}

/** Badge descriptor for an event type (falls back to a generic "blocked"). */
export function sandboxEventBadge(eventType) {
  const key = String(eventType || '').trim()
  return (
    SANDBOX_EVENT_LABELS[key] || {
      text: '已拦截',
      className: 'risk-confirm',
    }
  )
}
