/**
 * 侧栏会话两轴身份：Owner（谁）× Trigger（怎么触发）。
 * 纯前端从 session_key（必要时辅以 context）推导，不新增 DB 列。
 */

import { deptIdFromSessionKey, isDeptChatSessionKey } from '../dept-chat-session.js'
import { parseProactiveSessionKey } from './workspace-groups.js'

/** 与后端 ``IM_CHANNEL_NAMES`` 对齐的常见渠道前缀 */
const IM_CHANNEL_NAMES = new Set([
  'feishu',
  'wecom',
  'weixin',
  'slack',
  'telegram',
  'dingtalk',
])

export type SessionListOwnerKind = 'main' | 'agent' | 'dept'

export type SessionListTrigger = 'panel' | 'channel' | 'schedule' | 'task' | 'dept'

export type SessionListIdentity = {
  /** 分组键：`main` | agent_code | `dept:{id}` */
  ownerKey: string
  ownerKind: SessionListOwnerKind
  /** agent 时为 agent_code；dept 时为 deptId；main 为空串 */
  ownerCode: string
  trigger: SessionListTrigger
}

export const SESSION_TRIGGER_LABELS: Record<SessionListTrigger, string> = {
  panel: '对话',
  channel: '渠道',
  schedule: '定时',
  task: '任务',
  dept: '部门',
}

export function sessionTriggerLabel(trigger: SessionListTrigger): string {
  return SESSION_TRIGGER_LABELS[trigger] || trigger
}

export function looksLikeImChannelToken(token: string | null | undefined): boolean {
  const t = String(token || '')
    .trim()
    .toLowerCase()
  if (!t) return false
  if (IM_CHANNEL_NAMES.has(t)) return true
  const head = t.split(':')[0] || ''
  return IM_CHANNEL_NAMES.has(head)
}

function channelFromContext(context: Record<string, unknown> | null | undefined): string {
  if (!context || typeof context !== 'object') return ''
  return String(
    (context as { channel?: unknown }).channel ||
      (context as { channel_name?: unknown }).channel_name ||
      '',
  )
    .trim()
    .toLowerCase()
}

function sourceFromContext(context: Record<string, unknown> | null | undefined): string {
  if (!context || typeof context !== 'object') return ''
  return String((context as { source?: unknown }).source || '')
    .trim()
    .toLowerCase()
}

/**
 * 从 session_key + 可选 context 解析侧栏身份。
 * key 足够时不依赖 context；渠道/ automation 等残差字段作补强。
 */
export function resolveSessionListIdentity(
  sessionKey: string | null | undefined,
  context?: Record<string, unknown> | null,
): SessionListIdentity {
  const sk = String(sessionKey || '').trim()
  const ctxChannel = channelFromContext(context)
  const ctxSource = sourceFromContext(context)

  if (isDeptChatSessionKey(sk)) {
    const deptId = deptIdFromSessionKey(sk)
    return {
      ownerKey: deptId ? `dept:${deptId}` : 'dept',
      ownerKind: 'dept',
      ownerCode: deptId,
      trigger: 'dept',
    }
  }

  if (sk.startsWith('automation:')) {
    return {
      ownerKey: 'main',
      ownerKind: 'main',
      ownerCode: '',
      trigger: 'schedule',
    }
  }

  if (sk.startsWith('proactive:')) {
    const parsed = parseProactiveSessionKey(sk)
    const code = parsed.agentCode || 'unknown'
    if (parsed.kind === 'duty') {
      return {
        ownerKey: code,
        ownerKind: 'agent',
        ownerCode: code,
        trigger: 'schedule',
      }
    }
    if (parsed.kind === 'task') {
      return {
        ownerKey: code,
        ownerKind: 'agent',
        ownerCode: code,
        trigger: 'task',
      }
    }
    if (parsed.kind === 'chat') {
      const im =
        looksLikeImChannelToken(parsed.suffix) ||
        looksLikeImChannelToken(ctxChannel) ||
        (ctxSource === 'channel' && !!ctxChannel)
      return {
        ownerKey: code,
        ownerKind: 'agent',
        ownerCode: code,
        trigger: im ? 'channel' : 'panel',
      }
    }
    // legacy proactive:{code}
    return {
      ownerKey: code,
      ownerKind: 'agent',
      ownerCode: code,
      trigger: looksLikeImChannelToken(ctxChannel) ? 'channel' : 'panel',
    }
  }

  if (sk.startsWith('agent:')) {
    const parts = sk.split(':')
    const agent = String(parts[1] || 'main').trim() || 'main'
    const rest = parts.slice(2).join(':')
    const isMain = agent === 'main' || agent === 'lead_agent'
    const ownerKey = isMain ? 'main' : agent
    const ownerKind: SessionListOwnerKind = isMain ? 'main' : 'agent'
    const ownerCode = isMain ? '' : agent

    if (looksLikeImChannelToken(rest) || looksLikeImChannelToken(ctxChannel)) {
      return { ownerKey, ownerKind, ownerCode, trigger: 'channel' }
    }
    if (ctxSource === 'automation' || ctxSource.startsWith('automation')) {
      return { ownerKey, ownerKind, ownerCode, trigger: 'schedule' }
    }
    if (ctxSource === 'channel') {
      return { ownerKey, ownerKind, ownerCode, trigger: 'channel' }
    }
    return { ownerKey, ownerKind, ownerCode, trigger: 'panel' }
  }

  // thread: / 裸 key 等 → 归主对话面板
  return {
    ownerKey: 'main',
    ownerKind: 'main',
    ownerCode: '',
    trigger: 'panel',
  }
}

export type OwnerSidebarGroup<T extends { sessionKey?: string | null; updatedAt?: number } = {
  sessionKey?: string | null
  updatedAt?: number
}> = {
  ownerKey: string
  ownerKind: SessionListOwnerKind
  ownerCode: string
  label: string
  /** 组头头像用 agent_code；main / dept 可空 */
  avatarAgentCode: string
  sessions: T[]
  maxUpdatedAt: number
}

export type OwnerGroupLabelResolver = (owner: {
  ownerKey: string
  ownerKind: SessionListOwnerKind
  ownerCode: string
}) => string

/**
 * 按 Owner 折叠侧栏会话。main 置顶；agent 按最近更新；dept 靠后。
 * `seedOwners` 用于花名册里尚无会话的 BOT / 部门占位。
 */
export function buildOwnerSidebarGroups<
  T extends { sessionKey?: string | null; updatedAt?: number },
>(
  rows: T[],
  opts?: {
    resolveLabel?: OwnerGroupLabelResolver
    seedOwners?: Array<{
      ownerKey: string
      ownerKind: SessionListOwnerKind
      ownerCode: string
      label?: string
    }>
  },
): OwnerSidebarGroup<T>[] {
  const resolveLabel =
    opts?.resolveLabel ||
    ((o: { ownerKind: SessionListOwnerKind; ownerCode: string; ownerKey: string }) => {
      if (o.ownerKind === 'main') return '主对话'
      if (o.ownerKind === 'dept') return o.ownerCode ? `部门 · ${o.ownerCode}` : '部门'
      return o.ownerCode || o.ownerKey
    })

  const map = new Map<string, OwnerSidebarGroup<T>>()

  const ensure = (
    ownerKey: string,
    ownerKind: SessionListOwnerKind,
    ownerCode: string,
    labelHint = '',
  ) => {
    const key = String(ownerKey || '').trim() || 'main'
    let g = map.get(key)
    if (!g) {
      g = {
        ownerKey: key,
        ownerKind,
        ownerCode,
        label: labelHint || resolveLabel({ ownerKey: key, ownerKind, ownerCode }),
        avatarAgentCode: ownerKind === 'agent' ? ownerCode : '',
        sessions: [],
        maxUpdatedAt: 0,
      }
      map.set(key, g)
    } else if (labelHint && (!g.label || g.label === g.ownerCode || g.label === g.ownerKey)) {
      g.label = labelHint
    }
    return g
  }

  for (const seed of opts?.seedOwners || []) {
    ensure(seed.ownerKey, seed.ownerKind, seed.ownerCode, seed.label || '')
  }

  for (const row of rows) {
    const id = resolveSessionListIdentity(row.sessionKey)
    const g = ensure(id.ownerKey, id.ownerKind, id.ownerCode)
    g.sessions.push(row)
    const ts = Number(row.updatedAt || 0)
    if (ts > g.maxUpdatedAt) g.maxUpdatedAt = ts
  }

  for (const g of map.values()) {
    g.sessions.sort((a, b) => {
      const byUpdated = Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
      if (byUpdated !== 0) return byUpdated
      return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''))
    })
    if (!g.label) g.label = resolveLabel(g)
  }

  const list = [...map.values()]
  list.sort((a, b) => {
    const rank = (k: SessionListOwnerKind) => (k === 'main' ? 0 : k === 'agent' ? 1 : 2)
    const byKind = rank(a.ownerKind) - rank(b.ownerKind)
    if (byKind !== 0) return byKind
    if (a.ownerKind === 'main') return 0
    const byUpdated = Number(b.maxUpdatedAt || 0) - Number(a.maxUpdatedAt || 0)
    if (byUpdated !== 0) return byUpdated
    return a.label.localeCompare(b.label, 'zh-CN')
  })
  return list
}
