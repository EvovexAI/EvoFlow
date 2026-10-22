/**
 * Per-session meta in localStorage (collab mode, thinking level, agent code UI).
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { wsClient } from '../../../lib/ws-client.js'
import {
  isProactiveSessionKey,
  parseProactiveSessionKey,
} from '../../lib/session-list/workspace-groups.js'
import { STORAGE_SESSION_META_KEY, type ThinkingLevel } from './storage.js'

export function safeReadSessionMetaMap(): Record<string, any> {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_SESSION_META_KEY) ||
        localStorage.getItem('evopanel-chat-session-meta') ||
        '{}',
    )
  } catch {
    return {}
  }
}

export function safeWriteSessionMetaMap(map: Record<string, any>) {
  try {
    localStorage.setItem(STORAGE_SESSION_META_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

/** 仅从 `agent:{code}:{channel}` 解析智能体 code；`thread:*` 等占位键勿用第二段当 code。 */
export function parseSessionAgent(key: string) {
  const k = key || ''
  if (!k.toLowerCase().startsWith('agent:')) return ''
  const parts = k.split(':')
  return parts.length >= 2 ? String(parts[1] || '').trim() : ''
}

/**
 * 底部「角色」药丸与列表高亮用的 agent_code：与发消息时一致。
 * 员工会话（proactive:…）以 sessionKey 内 agent_code 为准；其余优先 flat agent_id。
 */
export function resolveSessionAgentCodeForUi(sessionKey: string): string {
  if (isProactiveSessionKey(sessionKey)) {
    const code = String(parseProactiveSessionKey(sessionKey).agentCode || '')
      .trim()
      .toLowerCase()
    if (code) return code
  }
  try {
    const ctx = wsClient.getSessionContext(sessionKey) as {
      agent_name?: string
      agent_id?: string
      use_claude_code_chat?: boolean | string | number
    } | undefined
    const flag =
      ctx?.use_claude_code_chat === true ||
      ctx?.use_claude_code_chat === 1 ||
      String(ctx?.use_claude_code_chat || '').toLowerCase() === 'true'
    if (flag) return 'claude-code'
    const aid = typeof ctx?.agent_id === 'string' ? ctx.agent_id.trim().toLowerCase() : ''
    if (aid) return aid
    const an = typeof ctx?.agent_name === 'string' ? ctx.agent_name.trim().toLowerCase() : ''
    if (an) return an
  } catch {
    /* ignore */
  }
  const fromKey = parseSessionAgent(sessionKey)
  if (fromKey) return fromKey.toLowerCase()
  return 'main'
}

/** Plan 协作仅反映用户手动开启；plan 工具/服务端 collab_phase 不自动改底部「模式」展示 */
export function getSessionCollabModeFromMeta(sessionKey: string): boolean {
  return !!safeReadSessionMetaMap()[sessionKey]?.collabMode
}

export function setSessionCollabModeInMeta(sessionKey: string, on: boolean) {
  if (!sessionKey) return
  const map = safeReadSessionMetaMap()
  if (on) {
    map[sessionKey] = { ...(map[sessionKey] || {}), collabMode: true }
  } else {
    const cur = map[sessionKey] || {}
    const next = { ...cur }
    delete next.collabMode
    if (Object.keys(next).length) map[sessionKey] = next
    else delete map[sessionKey]
  }
  safeWriteSessionMetaMap(map)
}

export function getThinkingLevelFromMeta(sessionKey: string): ThinkingLevel {
  const v = safeReadSessionMetaMap()[sessionKey]?.thinkingLevel
  if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v
  return 'auto'
}

export function setThinkingLevelInMeta(sessionKey: string, level: ThinkingLevel) {
  if (!sessionKey) return
  const map = safeReadSessionMetaMap()
  map[sessionKey] = { ...(map[sessionKey] || {}), thinkingLevel: level }
  safeWriteSessionMetaMap(map)
}
