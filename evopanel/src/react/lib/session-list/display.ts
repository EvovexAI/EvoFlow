import type { ChatSessionRow } from '../../chat-types.js'
import { parseTurnTimestampMs } from '../turn-timing.js'
import { STORAGE_SESSION_NAMES_KEY } from './constants.js'

const IM_CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  weixin: '微信',
  slack: 'Slack',
  telegram: 'Telegram',
}

function shortImId(id: string, keep = 14): string {
  const s = String(id || '').trim()
  if (!s) return ''
  return s.length <= keep ? s : `${s.slice(0, Math.max(8, keep - 2))}…`
}

function agentWhoLabel(agent: string): string {
  const code = String(agent || '').trim()
  if (!code || code === 'main' || code === 'lead_agent') return '主对话'
  if (code === 'xiaomi') return '小V'
  return code
}

/** 「飞书 · oc_xxx」这类只有渠道+id、看不出岗位的旧标题 */
export function isWeakImSessionTitle(title: string | null | undefined): boolean {
  const t = String(title || '').trim()
  if (!t) return false
  // 飞书 · oc_xxx / 飞书 · oc_xxx…
  if (/^(飞书|微信|Slack|Telegram)\s*·\s*[a-zA-Z0-9_-]{6,}…?$/i.test(t)) return true
  // 飞书 · oc_xxx · topic（仍无岗位名）
  if (/^(飞书|微信|Slack|Telegram)\s*·\s*(oc_|ou_|on_|om_)[a-zA-Z0-9]+…?(?:\s*·\s*.+)?$/i.test(t)) {
    // 已含岗位/主对话/小V 的不算弱标题
    if (/主对话|小V|岗位|智能体|默认推送|私聊/.test(t)) return false
    // 三段且中间不是纯 id 时可能是「飞书 · 岗位 · id」
    const parts = t.split(/\s*·\s*/)
    if (parts.length >= 3) {
      const mid = parts[1] || ''
      if (mid && !/^(oc_|ou_|on_|om_)/i.test(mid) && !/^[a-zA-Z0-9_-]{10,}$/.test(mid)) {
        return false
      }
    }
    return true
  }
  return false
}

function parseImChannelParts(channel: string): { label: string; shortId: string } | null {
  const ch = channel || ''
  for (const [name, label] of Object.entries(IM_CHANNEL_LABELS)) {
    if (ch === name || ch.startsWith(`${name}:`)) {
      const rest = ch === name ? '' : ch.slice(name.length + 1)
      const id = (rest || ch.split(':').pop() || '').trim()
      return { label, shortId: shortImId(id) }
    }
  }
  return null
}

/** 侧栏分组已标明「智能体员工」时，去掉标题前缀避免重复 */
export function stripProactiveEmployeeTitlePrefix(title: string | null | undefined): string {
  const t = String(title || '').trim()
  if (!t) return ''
  const stripped = t.replace(/^智能体员工\s*[·•.\-—–]\s*/, '').trim()
  return stripped || t
}

export function parseSessionLabel(key: string): string {
  const k = key || ''
  if (k.startsWith('proactive:')) {
    // Prefer title from DB when available; fallback parses workspace key.
    const rest = k.slice('proactive:'.length).trim()
    const markers = [':duty:', ':task:', ':chat:'] as const
    for (const m of markers) {
      const idx = rest.indexOf(m)
      if (idx >= 0) {
        const kind = m.slice(1, -1)
        const suffix = rest.slice(idx + m.length)
        if (kind === 'task') return `任务 · ${suffix.slice(0, 18) || '未命名'}`
        if (kind === 'chat') return '闲聊'
        return '值班'
      }
    }
    return rest || '智能体员工'
  }
  if (k.startsWith('thread:')) {
    const id = k.slice(7)
    if (!id) return '会话'
    return id.length <= 14 ? `会话 · ${id}` : `会话 · ${id.slice(0, 12)}…`
  }
  const parts = k.split(':')
  if (parts.length < 3) return key || '未知'
  const agent = parts[1] || 'main'
  const channel = parts.slice(2).join(':')
  if (agent === 'main' && channel === 'main') return '主会话'
  const im = parseImChannelParts(channel)
  if (im) {
    const who = agentWhoLabel(agent)
    if (im.shortId) return `${im.label} · ${who} · ${im.shortId}`
    return `${im.label} · ${who}`
  }
  if (agent === 'main' || agent === 'lead_agent') return channel
  return `${agent} / ${channel}`
}

export function getSessionNames(): Record<string, string> {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_SESSION_NAMES_KEY) ||
        localStorage.getItem('evopanel-chat-session-names') ||
        '{}',
    )
  } catch {
    return {}
  }
}

export function looksLikeAutoFallbackTitle(title: string): boolean {
  return isProvisionalSessionTitle(title)
}

export function isProvisionalSessionTitle(title: string | null | undefined): boolean {
  const t = String(title || '').trim()
  if (!t) return false
  return t.endsWith('...')
}

export function isReplaceableSessionTitle(title: string | null | undefined): boolean {
  return isPlaceholderSessionTitle(title) || isProvisionalSessionTitle(title)
}

export function provisionalSessionTitleFromUserText(text: string, maxChars = 10): string {
  const t = String(text || '').trim()
  if (!t) return ''
  const cap = Math.max(1, Number(maxChars) || 10)
  if (t.length > cap) return t.slice(0, cap).trimEnd() + '...'
  return t
}

export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const t = String(title || '').trim()
  if (!t) return true
  if (t === '新对话' || t.toLowerCase() === 'new conversation') return true
  // 内部自动 id（如 new-c5b70292）不当作用户可见标题
  if (/^new-[a-z0-9]{4,}$/i.test(t)) return true
  // 纯数字短标题（如 "1"）易与 Running 状态连读成「1 Running」
  if (/^\d{1,3}$/.test(t)) return true
  return false
}

/** 侧栏标题：以 DB title 为准；无标题 / 内部 id / 弱 IM 标题时用可读文案 */
export function getDisplayLabel(key: string, dbTitle?: string | null): string {
  const isProactive = String(key || '').startsWith('proactive:')
  const fromDbRaw = String(dbTitle || '').trim()
  const fromDb = isProactive ? stripProactiveEmployeeTitlePrefix(fromDbRaw) : fromDbRaw
  const fromKey = parseSessionLabel(key)
  if (fromDb && !isPlaceholderSessionTitle(fromDb) && !isWeakImSessionTitle(fromDb)) return fromDb
  if (fromDb && isWeakImSessionTitle(fromDb) && fromKey && fromKey !== fromDb && !isPlaceholderSessionTitle(fromKey)) {
    return fromKey
  }
  try {
    const fromLocalRaw = String(getSessionNames()[key] || '').trim()
    const fromLocal = isProactive
      ? stripProactiveEmployeeTitlePrefix(fromLocalRaw)
      : fromLocalRaw
    if (fromLocal && !isPlaceholderSessionTitle(fromLocal) && !looksLikeAutoFallbackTitle(fromLocal)) {
      if (!isWeakImSessionTitle(fromLocal)) return fromLocal
    }
  } catch {
    /* ignore */
  }
  if (!fromKey || isPlaceholderSessionTitle(fromKey)) return '新对话'
  return fromKey
}

/** 侧栏标题：API / 本地缓存 / 行内 title 取最可信的一条 */
export function pickSessionRowTitle(
  sessionKey: string,
  apiTitle?: string | null,
  prevTitle?: string | null,
): string {
  const sk = String(sessionKey || '').trim()
  const api = String(apiTitle || '').trim()
  const prev = String(prevTitle || '').trim()
  let local = ''
  try {
    local = String(getSessionNames()[sk] || '').trim()
  } catch {
    /* ignore */
  }
  const solid = (t: string) =>
    Boolean(t) && !isPlaceholderSessionTitle(t) && !looksLikeAutoFallbackTitle(t)

  // DB 优先：用户改短标题、刷新后不得被更长的 prev/local 盖掉
  if (solid(api)) return api
  // 本地缓存：AI/用户写入后、DB 尚未跟上时
  if (solid(local)) return local
  if (solid(prev)) return prev

  const soft = [api, local, prev].filter((t) => t && !isPlaceholderSessionTitle(t))
  if (!soft.length) return api || prev || local || '新对话'
  return soft.reduce((best, cur) => {
    if (looksLikeAutoFallbackTitle(best) && !looksLikeAutoFallbackTitle(cur)) return cur
    if (!looksLikeAutoFallbackTitle(best) && looksLikeAutoFallbackTitle(cur)) return best
    return cur.length >= best.length ? cur : best
  })
}

function formatSessionTime(ts: number): string {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  if (diffMs < 60000) return '刚刚'
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}分钟前`
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}小时前`
  if (diffMs < 604800000) return `${Math.floor(diffMs / 86400000)}天前`
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
}

/**
 * 侧栏时间戳唯一来源：
 * - 执行中 → currentTurnStartedAt（本轮开始时刻，执行期间不变）
 * - 其余 → updatedAt / lastActivity / createdAt
 */
export function resolveSessionListTimestampMs(
  s: ChatSessionRow,
  opts?: { executing?: boolean },
): number {
  if (opts?.executing) {
    const turnStartMs = parseTurnTimestampMs(s.currentTurnStartedAt)
    if (turnStartMs != null) return turnStartMs
  }
  const raw = Number(s.updatedAt ?? s.lastActivity ?? s.createdAt ?? 0)
  if (!raw) return 0
  return raw < 1e12 ? raw * 1000 : raw
}

/** 侧栏会话列表右侧仅展示相对时间 */
export function formatSessionListTime(
  s: ChatSessionRow,
  opts?: { executing?: boolean },
): string {
  const ts = resolveSessionListTimestampMs(s, opts)
  return ts ? formatSessionTime(ts) : ''
}

export function formatRunningPreviewLine(
  row: {
    runningPreviewLine?: string
    runningToolSummary?: string
    runningPreview?: string
  },
): string {
  const dockLine = String(row.runningPreviewLine || '').trim()
  if (dockLine) return dockLine
  const tool = String(row.runningToolSummary || '').trim()
  const text = String(row.runningPreview || '').trim()
  if (!tool && !text) return ''
  const toolPart = tool ? (tool.startsWith('调用') ? tool : `调用：${tool}`) : ''
  if (toolPart && text) return `${toolPart} · ${text}`
  return toolPart || text
}

export function setSessionTitle(sessionKey: string, title: string): boolean {
  const cleanKey = String(sessionKey || '').trim()
  const cleanTitle = String(title || '').trim()
  if (!cleanKey || !cleanTitle) return false
  try {
    const names = getSessionNames()
    if (names[cleanKey] === cleanTitle) return false
    names[cleanKey] = cleanTitle
    localStorage.setItem(STORAGE_SESSION_NAMES_KEY, JSON.stringify(names))
    void import('../../../lib/ws-client.js').then(({ persistSessionTitleToDb }) =>
      persistSessionTitleToDb(cleanKey, cleanTitle).catch(() => {}),
    )
    window.dispatchEvent(
      new CustomEvent('session-name-updated', { detail: { sessionKey: cleanKey, title: cleanTitle } }),
    )
    return true
  } catch {
    return false
  }
}

export function persistSessionTitleIfMissing(sessionKey: string, title: string): boolean {
  const cleanKey = String(sessionKey || '').trim()
  const cleanTitle = String(title || '').trim()
  if (!cleanKey || !cleanTitle || isPlaceholderSessionTitle(cleanTitle)) return false
  try {
    const names = getSessionNames()
    const existing = typeof names[cleanKey] === 'string' ? names[cleanKey].trim() : ''
    if (existing && !isReplaceableSessionTitle(existing)) {
      return false
    }
    return setSessionTitle(cleanKey, cleanTitle)
  } catch {
    return false
  }
}

/** 首条 user 消息发送时：占位/临时标题 → 用消息前缀更新侧栏并落库 */
export function persistProvisionalSessionTitleFromMessage(
  sessionKey: string,
  userMessage: string,
): boolean {
  const prov = provisionalSessionTitleFromUserText(userMessage)
  if (!prov) return false
  return persistSessionTitleIfMissing(sessionKey, prov)
}
