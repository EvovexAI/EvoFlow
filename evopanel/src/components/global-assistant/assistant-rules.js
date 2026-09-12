/**
 * 小V全局助手 · 纯函数（角标、问候、建议、状态映射）— 供 UI 与 vitest 共用
 */
import { toTaskStatusGroup, normalizeTaskStatusKey } from '../../lib/task-status-label.js'

export const NOTIFY_PRIORITY = [
  'approval_required',
  'user_input_required',
  'task_blocked',
  'task_failed',
  'task_completed',
]

/** @param {Date} [now] */
export function greetingByHour(now = new Date()) {
  const h = now.getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '上午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/**
 * @param {{ approvals?: number, waitingUser?: number, blocked?: number, failed?: number, completedUnread?: number }} counts
 */
export function computeBadgeCount(counts = {}) {
  const n =
    (Number(counts.approvals) || 0) +
    (Number(counts.waitingUser) || 0) +
    (Number(counts.blocked) || 0) +
    (Number(counts.failed) || 0) +
    (Number(counts.completedUnread) || 0)
  return Math.max(0, Math.min(99, n))
}

/** @param {string} status */
export function mapAgentWorkStatus(status, busy = false) {
  const s = normalizeTaskStatusKey(status)
  if (busy) return 'working'
  if (s === 'paused' || s === 'offline') return 'offline'
  if (s === 'failed' || s === 'error') return 'error'
  if (s === 'req_confirm' || s === 'waiting_user' || s === 'reviewed') return 'waiting'
  if (s === 'blocked') return 'blocked'
  const g = toTaskStatusGroup(status)
  if (g === 'executing' || g === 'planning') return 'working'
  return 'idle'
}

/**
 * @param {Array<Record<string, unknown>>} tasks
 * @param {Array<Record<string, unknown>>} approvals
 */
export function buildAttentionItems(tasks, approvals, { limit = 4 } = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const items = []
  for (const a of approvals || []) {
    if (String(a?.status || '').toLowerCase() !== 'pending') continue
    items.push({
      id: `appr:${a.id || a.initiative_id || a.task_id}`,
      kind: 'approval_required',
      title: String(a.title || a.initiative_title || a.task_name || '待审批事项').trim(),
      typeLabel: '待审批',
      owner: String(a.role_name || a.role_agent_code || '').trim(),
      reason: String(a.rationale || a.comment || a.note || '需要你拍板后才能继续').trim(),
      updatedAt: a.created_at || a.updated_at || '',
      taskId: a.task_id || '',
      agentCode: a.role_agent_code || '',
      approvalId: a.id || a.initiative_id || '',
      primaryAction: 'open_approval',
      secondaryAction: 'open_task',
    })
  }
  for (const t of tasks || []) {
    const g = toTaskStatusGroup(t.status)
    const s = normalizeTaskStatusKey(t.status)
    let kind = ''
    let typeLabel = ''
    if (s === 'waiting_user' || s === 'req_confirm') {
      kind = 'user_input_required'
      typeLabel = '待你输入'
    } else if (g === 'failed') {
      kind = 'task_failed'
      typeLabel = '失败'
    } else if (s === 'blocked' || /阻塞|blocked/i.test(String(t.result || t.description || ''))) {
      kind = 'task_blocked'
      typeLabel = '受阻'
    } else if (s === 'reviewed') {
      kind = 'waiting_review'
      typeLabel = '待确认'
    }
    if (!kind) continue
    const tid = String(t.id || t.task_id || '').trim()
    items.push({
      id: `task:${tid}`,
      kind,
      title: String(t.name || t.title || tid || '未命名任务').trim(),
      typeLabel,
      owner: String(t.assigned_role || t.assigned_to || '').trim(),
      reason: String(t.result || t.description || '').trim().slice(0, 120) || '需要关注',
      updatedAt: t.updated_at || t.created_at || '',
      taskId: tid,
      agentCode: t.assigned_to || '',
      primaryAction: 'open_task',
      secondaryAction: 'request_update',
    })
  }
  const rank = (k) => {
    const i = NOTIFY_PRIORITY.indexOf(k)
    return i >= 0 ? i : 50
  }
  items.sort((a, b) => rank(String(a.kind)) - rank(String(b.kind)))
  return items.slice(0, limit)
}

/**
 * Simple follow-up rules from structured task state (no LLM).
 * @param {Array<Record<string, unknown>>} tasks
 * @param {Array<Record<string, unknown>>} roles
 */
export function buildSuggestedActions(tasks, roles, { limit = 3 } = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const out = []
  const roleByCode = new Map(
    (roles || []).map((r) => [String(r.agent_code || '').trim(), r]),
  )
  const reviewed = (tasks || []).filter((t) => normalizeTaskStatusKey(t.status) === 'reviewed')
  if (reviewed.length) {
    const t = reviewed[0]
    out.push({
      id: `sug-review-${t.id || t.task_id}`,
      text: `有 ${reviewed.length} 项已交工待确认，建议打开工作项看板处理。`,
      primaryLabel: '打开看板',
      primaryAction: 'open_board',
      secondaryLabel: '查看详情',
      secondaryAction: 'open_task',
      taskId: t.id || t.task_id,
    })
  }
  const failed = (tasks || []).filter((t) => toTaskStatusGroup(t.status) === 'failed')
  if (failed.length) {
    const t = failed[0]
    const code = String(t.assigned_to || '').trim()
    const role = roleByCode.get(code)
    out.push({
      id: `sug-fail-${t.id || t.task_id}`,
      text: `任务「${String(t.name || '').slice(0, 40)}」失败，可请求${role?.role_name || code || '负责人'}更新或重试。`,
      primaryLabel: '请求更新',
      primaryAction: 'request_update',
      secondaryLabel: '查看任务',
      secondaryAction: 'open_task',
      taskId: t.id || t.task_id,
      agentCode: code,
    })
  }
  const idleRoles = (roles || []).filter(
    (r) => String(r.status || '') === 'active' && !r._busy && String(r.agent_code || '') !== 'xiaomi',
  )
  if (idleRoles.length && !(tasks || []).some((t) => toTaskStatusGroup(t.status) === 'executing')) {
    out.push({
      id: 'sug-delegate',
      text: '当前没有执行中的岗位工作项，可以把新需求委派给合适的员工。',
      primaryLabel: '委派任务',
      primaryAction: 'open_delegate',
      secondaryLabel: '员工进度',
      secondaryAction: 'open_agents',
    })
  }
  return out.slice(0, limit)
}

/**
 * @param {string} text
 * @returns {'report'|'agents'|'blocked'|'approvals'|'knowledge'|'delegate'|'task_progress'|'help'|null}
 */
export function detectChatIntent(text) {
  const t = String(text || '').trim()
  if (!t) return null
  if (/委派|交给|安排.*员工|派给/.test(t)) return 'delegate'
  if (/知识库|查一下|为什么选|MCP|Obsidian|文档/.test(t)) return 'knowledge'
  if (/审批|待我批|拍板/.test(t)) return 'approvals'
  if (/阻塞|卡住|待推进|停滞/.test(t)) return 'blocked'
  if (/员工|谁在忙|进度.*岗|名册/.test(t)) return 'agents'
  if (/汇报|今天|完成了什么|整体情况/.test(t)) return 'report'
  if (/做到哪|进度|程序员|前端|测试/.test(t)) return 'task_progress'
  if (/怎么|如何|用法|连接|指南|帮助/.test(t)) return 'help'
  return null
}
