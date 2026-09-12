/** Chat deliverable (产物) — shared by Info Rail + Right Stage. */

export type ChatArtifactType = 'file' | 'image' | 'video' | 'url' | 'html' | 'text' | 'platform'

export type ChatArtifact = {
  id: string
  type: ChatArtifactType
  name: string
  path?: string
  url?: string
  label?: string
  mime?: string
  size?: number
  status?: 'new' | 'updated'
  content?: string
  createdAt?: string
  updatedAt?: string
  /** platform tool success entry */
  platformAction?: string
  platformDomain?: string
  platformFeedbackKind?: 'success' | 'warning' | 'error'
  platformSubtitle?: string
  toolCallId?: string
  platformActions?: Array<{ label: string; route?: string; external?: boolean }>
}

const TYPES = new Set<ChatArtifactType>(['file', 'image', 'video', 'url', 'html', 'text', 'platform'])

function basename(pathOrUrl: string): string {
  const s = String(pathOrUrl || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!s) return ''
  const parts = s.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

function inferType(path: string, url: string, mime: string, rawType: string): ChatArtifactType {
  const t = String(rawType || '').trim().toLowerCase()
  if (TYPES.has(t as ChatArtifactType)) return t as ChatArtifactType
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.includes('html')) return 'html'
  const probe = (path || url).toLowerCase().split('?')[0]
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(probe)) return 'image'
  if (/\.(mp4|webm|mov|mkv|avi|m4v)$/.test(probe)) return 'video'
  if (/\.html?$/.test(probe)) return 'html'
  if (url) return 'url'
  return 'file'
}

/** Normalize API / SSE / panel item into ChatArtifact. */
export function normalizeChatArtifact(raw: unknown): ChatArtifact | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return null
    if (/^https?:\/\//i.test(s)) return normalizeChatArtifact({ type: 'url', url: s })
    return normalizeChatArtifact({ type: 'file', path: s })
  }
  if (typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const typeRaw = String(o.type || o.kind || '').trim().toLowerCase()
  if (typeRaw === 'platform') {
    const label = String(o.label || o.title || o.name || '').trim()
    if (!label) return null
    const id = String(o.id || o.artifact_id || o.toolCallId || o.tool_call_id || label).trim()
    const route = String(o.url || o.route || '').trim()
    const statusRaw = String(o.status || '').trim().toLowerCase()
    const status = statusRaw === 'updated' ? 'updated' : statusRaw === 'new' ? 'new' : undefined
    const feedbackKindRaw = String(o.platformFeedbackKind || o.platform_feedback_kind || '').trim().toLowerCase()
    const platformFeedbackKind =
      feedbackKindRaw === 'warning' || feedbackKindRaw === 'error' ? feedbackKindRaw : 'success'
    const out: ChatArtifact = {
      id: id || `platform:${label}`,
      type: 'platform',
      name: label,
      label,
      platformFeedbackKind,
    }
    if (route) out.url = route
    if (status) out.status = status
    const platformAction = String(o.platformAction || o.platform_action || '').trim()
    const platformDomain = String(o.platformDomain || o.platform_domain || '').trim()
    const platformSubtitle = String(o.platformSubtitle || o.platform_subtitle || o.subtitle || '').trim()
    const toolCallId = String(o.toolCallId || o.tool_call_id || '').trim()
    if (platformAction) out.platformAction = platformAction
    if (platformDomain) out.platformDomain = platformDomain
    if (platformSubtitle) out.platformSubtitle = platformSubtitle
    if (toolCallId) out.toolCallId = toolCallId
    const createdAt = String(o.createdAt || o.created_at || '').trim()
    const updatedAt = String(o.updatedAt || o.updated_at || '').trim()
    if (createdAt) out.createdAt = createdAt
    if (updatedAt) out.updatedAt = updatedAt
    const actionsRaw = o.platformActions || o.platform_actions || o.actions
    if (Array.isArray(actionsRaw) && actionsRaw.length) {
      out.platformActions = actionsRaw
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map((row) => ({
          label: String(row.label || '').trim(),
          route: String(row.route || '').trim() || undefined,
          external: row.external === true,
        }))
        .filter((row) => row.label)
    }
    return out
  }
  const path = String(o.path || '').trim()
  const url = String(o.url || o.href || o.link || '').trim()
  const content = o.content != null ? String(o.content) : ''
  if (!path && !url && !content) return null
  const mime = String(o.mime || o.mime_type || '').trim()
  const type = inferType(path, url, mime, String(o.type || o.kind || ''))
  const name =
    String(o.name || o.filename || '').trim() ||
    basename(path || url) ||
    String(o.label || o.title || type)
  const id = String(o.id || o.artifact_id || path || url || name).trim() || name
  const statusRaw = String(o.status || '').trim().toLowerCase()
  const status = statusRaw === 'updated' ? 'updated' : statusRaw === 'new' ? 'new' : undefined
  const out: ChatArtifact = { id, type, name }
  if (path) out.path = path
  if (url) out.url = url
  if (content && (type === 'html' || type === 'text')) out.content = content
  const label = String(o.label || o.title || '').trim()
  if (label) out.label = label
  if (mime) out.mime = mime
  if (o.size != null && Number.isFinite(Number(o.size))) out.size = Math.max(0, Number(o.size))
  if (status) out.status = status
  const createdAt = String(o.createdAt || o.created_at || '').trim()
  const updatedAt = String(o.updatedAt || o.updated_at || '').trim()
  if (createdAt) out.createdAt = createdAt
  if (updatedAt) out.updatedAt = updatedAt
  return out
}

export function normalizeChatArtifacts(raw: unknown): ChatArtifact[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const out: ChatArtifact[] = []
  const seen = new Set<string>()
  for (const it of list) {
    const n = normalizeChatArtifact(it)
    if (!n || seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
  }
  return out
}

/** Merge upsert into session list (append / replace by id). */
export function mergeChatArtifacts(
  existing: ChatArtifact[],
  incoming: ChatArtifact[],
): ChatArtifact[] {
  if (!incoming.length) return existing
  const now = new Date().toISOString()
  const map = new Map<string, ChatArtifact>()
  for (const it of existing) map.set(it.id, it)
  for (const raw of incoming) {
    const it = { ...raw }
    const prev = map.get(it.id)
    if (!prev) {
      if (!it.createdAt) it.createdAt = now
      if (!it.updatedAt) it.updatedAt = now
    } else if (!it.updatedAt) {
      it.updatedAt = now
    }
    map.set(it.id, prev ? { ...prev, ...it, status: it.status || prev.status || 'updated' } : it)
  }
  // Keep prior order; append brand-new ids at end
  const order: string[] = []
  const seen = new Set<string>()
  for (const it of existing) {
    if (map.has(it.id) && !seen.has(it.id)) {
      order.push(it.id)
      seen.add(it.id)
    }
  }
  for (const it of incoming) {
    if (!seen.has(it.id)) {
      order.push(it.id)
      seen.add(it.id)
    }
  }
  return order.map((id) => map.get(id)!).filter(Boolean)
}

export function chatArtifactDisplayLabel(it: ChatArtifact): string {
  if (it.type === 'platform') {
    return String(it.label || it.name || it.platformAction || '平台操作').trim()
  }
  return String(it.label || it.name || it.path || it.url || it.id || '产物').trim()
}

export function chatArtifactTypeLabel(it: ChatArtifact): string {
  if (it.type === 'platform') {
    const domain = String(it.platformDomain || '').trim()
    const map: Record<string, string> = {
      items: '待办',
      tasks: '协作任务',
      employees: '员工',
      agents: '智能体',
      skills: '技能',
      mcp: 'MCP',
      automation: '自动化',
      settings: '设置',
      knowledge: '知识库',
    }
    return domain ? `平台 · ${map[domain] || domain}` : '平台'
  }
  return it.type
}
