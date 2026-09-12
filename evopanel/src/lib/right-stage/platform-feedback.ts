/** Parse platform tool JSON result and apply Right Stage feedback panel. */

import { syncPanelAppearanceFromToolResult } from '../panel-appearance-sync.js'
import type { RightStageSurface } from './right-stage-types.js'

export type PlatformFeedbackDetail = {
  label: string
  value: string
}

export type PlatformFeedbackAction = {
  label: string
  route?: string
  external?: boolean
}

export type PlatformUiFeedback = {
  kind: 'success' | 'warning' | 'error'
  verb?: string
  domain?: string
  entityType?: string
  entityLabel?: string
  entityId?: string | null
  icon?: string
  title: string
  subtitle?: string
  details?: PlatformFeedbackDetail[]
  actions?: PlatformFeedbackAction[]
  action?: string
}

export type PlatformRunEntry = PlatformUiFeedback & {
  id: string
  toolCallId?: string
  appliedAt: number
}

export type PlatformFeedbackSurfaceData = PlatformUiFeedback & {
  appliedAt?: number
}

export type RunOutcomesTab = 'artifacts' | 'platform'

export type PlatformFeedbackDecideInput = {
  runId: string
  userPinned: string | null
  dismissedKindsThisRun: ReadonlySet<string> | Iterable<string>
  currentKind: string | null
}

const DOMAIN_ENTITY_ZH: Record<string, string> = {
  knowledge: '知识库',
  workflow: '工作流',
  settings: '设置',
  agents: '智能体',
  employees: '智能体员工',
  tasks: '协作任务',
  items: '待办事项',
  skills: '技能',
  mcp: 'MCP 配置',
  automation: '定时任务',
  approvals: '审批',
  memory: '长期记忆',
  experience: '经验',
  verification: '验证轮次',
  diagnostics: '诊断',
  appearance: '界面外观',
}

/** 消息流 Action Result 卡片用的短域名 */
const DOMAIN_SHORT_ZH: Record<string, string> = {
  knowledge: '知识库',
  workflow: '工作流',
  settings: '设置',
  agents: '智能体',
  employees: '员工',
  tasks: '任务',
  items: '待办',
  skills: '技能',
  mcp: 'MCP',
  automation: '自动化',
  approvals: '审批',
  memory: '记忆',
  experience: '经验',
  appearance: '外观',
}

/** 消息流卡片短标题（避免「创建「xxx」待办事项成功」过长） */
const CARD_TITLE_OVERRIDES: Record<string, string> = {
  'items.create': '已创建待办',
  'items.update': '已更新待办',
  'items.delete': '已删除待办',
  'items.dispatch': '已派发待办',
  'tasks.create': '已创建任务',
  'tasks.set_state': '已更新任务',
  'tasks.delete': '已删除任务',
  'employees.hire': '已添加员工',
  'settings.set_default_model': '已更新默认模型',
  'appearance.patch': '已更新外观',
  'skills.install': '已安装技能',
  'automation.create': '已创建定时任务',
  'mcp.set': '已更新 MCP',
}

const READ_VERBS = new Set([
  'list',
  'get',
  'search',
  'catalog',
  'help',
  'notes',
  'note_get',
  'history',
  'sources',
  'scan',
  'timeline',
  'trail',
  'worklog',
  'execution_trail',
  'agents',
])

const TITLE_OVERRIDES: Record<string, (label: string) => string> = {
  'items.create': (label) => `创建「${label}」待办事项成功`,
  'items.update': (label) => `修改「${label}」待办事项成功`,
  'items.delete': (label) => `已删除待办事项「${label}」`,
  'items.dispatch': (label) => `已将「${label}」派发给员工`,
  'tasks.create': (label) => `创建「${label}」协作任务成功`,
  'tasks.set_state': (label) => `协作任务「${label}」状态已更新`,
  'tasks.delete': (label) => `已删除协作任务「${label}」`,
  'employees.hire': (label) => `已添加智能体员工「${label}」`,
  'settings.set_default_model': (label) => `默认模型已改为「${label}」`,
  'appearance.patch': () => '界面外观已更新',
  'skills.install': (label) => `已安装技能「${label}」`,
  'automation.create': (label) => `已创建定时任务「${label}」`,
  'mcp.set': () => 'MCP 配置已更新',
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asString(value: unknown): string {
  return String(value ?? '').trim()
}

function asDict(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asDetails(raw: unknown): PlatformFeedbackDetail[] {
  if (!Array.isArray(raw)) return []
  const out: PlatformFeedbackDetail[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const label = asString((row as Record<string, unknown>).label)
    const value = asString((row as Record<string, unknown>).value)
    if (label && value) out.push({ label, value })
  }
  return out
}

function asActions(raw: unknown): PlatformFeedbackAction[] {
  if (!Array.isArray(raw)) return []
  const out: PlatformFeedbackAction[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const label = asString((row as Record<string, unknown>).label)
    if (!label) continue
    const route = asString((row as Record<string, unknown>).route)
    out.push({
      label,
      route: route || undefined,
      external: (row as Record<string, unknown>).external === true,
    })
  }
  return out
}

function pickLabel(obj: Record<string, unknown>, args: Record<string, unknown>): string {
  const item = asDict(obj.item)
  const agent = asDict(obj.agent)
  const skill = asDict(obj.skill)
  return (
    asString(item.title) ||
    asString(item.name) ||
    asString(obj.title) ||
    asString(obj.name) ||
    asString(obj.role_name) ||
    asString(agent.agent_name) ||
    asString(agent.agent_code) ||
    asString(skill.name) ||
    asString(obj.model) ||
    asString(args.title) ||
    asString(args.name) ||
    asString(args.model) ||
    asString(args.agent_code)
  )
}

function pickEntityId(obj: Record<string, unknown>, args: Record<string, unknown>): string {
  const item = asDict(obj.item)
  const agent = asDict(obj.agent)
  return (
    asString(item.id) ||
    asString(obj.item_id) ||
    asString(obj.task_id) ||
    asString(obj.agent_code) ||
    asString(agent.agent_code) ||
    asString(obj.id) ||
    asString(args.item_id) ||
    asString(args.task_id) ||
    asString(args.agent_code)
  )
}

function buildActions(action: string, domain: string, entityId: string): PlatformFeedbackAction[] {
  if (domain === 'items' && entityId) {
    return [{ label: '查看事项', route: `/tasks?tab=items&focus=${entityId}` }]
  }
  if (domain === 'tasks' && entityId) {
    return [{ label: '查看任务', route: `/task/${entityId}` }]
  }
  if (domain === 'employees' && entityId) {
    return [{ label: '查看员工', route: `/proactive/${entityId}` }]
  }
  if (domain === 'agents') {
    return [{ label: '查看智能体', route: '/agents' }]
  }
  if (domain === 'skills') {
    return [{ label: '打开技能', route: '/skills' }]
  }
  if (domain === 'mcp') {
    return [{ label: '打开 MCP', route: '/tools' }]
  }
  if (domain === 'automation') {
    return [{ label: '打开自动化', route: '/automation' }]
  }
  if (domain === 'settings') {
    return [{ label: '打开设置', route: action.includes('model') ? '/models' : '/settings' }]
  }
  if (domain === 'knowledge') {
    return [{ label: '打开知识库', route: '/knowledge' }]
  }
  return []
}

function inferPlatformUiFeedbackFallback(
  obj: Record<string, unknown>,
  argsText?: string,
): PlatformUiFeedback | null {
  const action = asString(obj.action)
  if (!action || !action.includes('.')) return null
  const [domain, verb] = action.split('.', 2)
  if (!domain || !verb || READ_VERBS.has(verb)) return null

  const args = parseJsonObject(argsText) || {}
  const label = pickLabel(obj, args) || DOMAIN_ENTITY_ZH[domain] || domain
  const entityId = pickEntityId(obj, args)
  const override = TITLE_OVERRIDES[action]
  const title = override ? override(label) : `${DOMAIN_ENTITY_ZH[domain] || domain}操作成功`
  const destructive = verb === 'delete' || verb === 'archive' || verb === 'clear' || verb === 'note_delete'

  return {
    kind: destructive ? 'warning' : 'success',
    verb,
    domain,
    entityType: domain,
    entityLabel: label,
    entityId: entityId || null,
    title,
    subtitle:
      domain === 'items'
        ? '已记入任务中心 · 我的事项'
        : domain === 'tasks'
          ? '已记入任务中心 · 协作任务'
          : undefined,
    details: [],
    actions: buildActions(action, domain, entityId),
    action,
  }
}

function uiFromBackend(obj: Record<string, unknown>): PlatformUiFeedback | null {
  const uiRaw = obj.ui
  if (!uiRaw || typeof uiRaw !== 'object' || Array.isArray(uiRaw)) return null
  const ui = uiRaw as Record<string, unknown>
  const title = asString(ui.title)
  if (!title) return null
  const kindRaw = asString(ui.kind).toLowerCase()
  const kind: PlatformUiFeedback['kind'] =
    kindRaw === 'warning' || kindRaw === 'error' ? kindRaw : 'success'
  return {
    kind,
    verb: asString(ui.verb) || undefined,
    domain: asString(ui.domain) || undefined,
    entityType: asString(ui.entityType) || undefined,
    entityLabel: asString(ui.entityLabel) || undefined,
    entityId: asString(ui.entityId) || null,
    icon: asString(ui.icon) || undefined,
    title,
    subtitle: asString(ui.subtitle) || undefined,
    details: asDetails(ui.details),
    actions: asActions(ui.actions),
    action: asString(ui.action || obj.action) || undefined,
  }
}

export function parsePlatformUiFeedback(raw: unknown, argsText?: string): PlatformUiFeedback | null {
  const obj = parseJsonObject(raw)
  if (!obj || obj.ok === false || obj.pending_confirm === true) return null
  return uiFromBackend(obj) || inferPlatformUiFeedbackFallback(obj, argsText)
}

export function platformFeedbackTitleFromToolOutput(raw: unknown, argsText?: string): string {
  return parsePlatformUiFeedback(raw, argsText)?.title || ''
}

export function navigatePlatformFeedbackRoute(route: string): void {
  const next = asString(route)
  if (!next || typeof window === 'undefined') return
  const hash = next.startsWith('#') ? next.slice(1) : next.startsWith('/') ? next : `/${next}`
  window.location.hash = hash
}

export function platformDomainLabel(domain?: string): string {
  const key = String(domain || '').trim()
  return DOMAIN_ENTITY_ZH[key] || key || '平台'
}

export function platformDomainShortLabel(domain?: string): string {
  const key = String(domain || '').trim()
  return DOMAIN_SHORT_ZH[key] || DOMAIN_ENTITY_ZH[key] || key || '平台'
}

/** 消息流 Action Result：短标题 */
export function platformActionCardTitle(ui: PlatformUiFeedback): string {
  const action = String(ui.action || '').trim()
  if (action && CARD_TITLE_OVERRIDES[action]) return CARD_TITLE_OVERRIDES[action]
  const verb = String(ui.verb || '').trim()
  const domain = String(ui.domain || '').trim()
  const shortDomain = platformDomainShortLabel(domain)
  if (verb === 'create') return `已创建${shortDomain}`
  if (verb === 'update' || verb === 'set_state' || verb === 'patch') return `已更新${shortDomain}`
  if (verb === 'delete' || verb === 'archive') return `已删除${shortDomain}`
  const title = String(ui.title || '').trim()
  if (title) {
    // 压缩「创建「xxx」待办事项成功」→ 尽量取前段
    const m = title.match(/^(已?[创修改删除派发更新安装添加]+[^「]*)/)
    if (m?.[1] && m[1].length <= 12) return m[1].replace(/成功$/, '') || title
    if (title.length <= 16) return title.replace(/成功$/, '') || title
  }
  return title || '操作成功'
}

/** 消息流 Action Result：元信息「待办 · UI / Theme · 刚刚」 */
export function platformActionCardMeta(
  ui: PlatformUiFeedback,
  opts?: { appliedAt?: number | null },
): string {
  const parts: string[] = []
  parts.push(platformDomainShortLabel(ui.domain))
  const label = String(ui.entityLabel || '').trim()
  if (label && label !== parts[0]) parts.push(label)
  else if (ui.subtitle) {
    const sub = String(ui.subtitle).trim()
    if (sub) parts.push(sub)
  }
  const at = opts?.appliedAt
  if (at != null && Number.isFinite(Number(at)) && Number(at) > 0) {
    parts.push(formatRelativeJustNow(Number(at)))
  } else {
    parts.push('刚刚')
  }
  return parts.filter(Boolean).join(' · ')
}

function formatRelativeJustNow(ts: number): string {
  const diff = Date.now() - ts
  if (!Number.isFinite(diff) || diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

/** 从 tool 行解析平台 UI（供消息流卡片） */
export function parsePlatformUiFeedbackFromTool(
  tool: Record<string, unknown>,
): PlatformUiFeedback | null {
  if (toolPlatformName(tool) !== 'platform') return null
  if (toolIsRunning(tool)) return null
  return parsePlatformUiFeedback(toolPlatformOutput(tool), toolPlatformArgs(tool))
}

/** 消息流 Action Result 卡片：已完成且带 ui 的 platform 工具行 */
export function collectPlatformResultTools(
  tools: unknown[],
  filterIds?: readonly string[] | null,
): Record<string, unknown>[] {
  if (!Array.isArray(tools) || !tools.length) return []
  const want = filterIds?.length
    ? new Set(filterIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (toolPlatformName(row) !== 'platform') continue
    const id = String(row.tool_call_id ?? row.id ?? '').trim()
    if (want) {
      if (!id || !want.has(id)) continue
    }
    if (toolIsRunning(row)) continue
    if (!parsePlatformUiFeedbackFromTool(row)) continue
    const dedupe = id || `anon:${out.length}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push(row)
  }
  return out
}

export function platformUiToRunEntry(ui: PlatformUiFeedback, toolCallId?: string): PlatformRunEntry {
  return {
    ...ui,
    id: toolCallId ? `platform:${toolCallId}` : `platform:${ui.action || 'op'}:${ui.entityId || ui.title}:${Date.now()}`,
    toolCallId: toolCallId || undefined,
    appliedAt: Date.now(),
  }
}

export function mergePlatformRunEntries(
  existing: PlatformRunEntry[],
  entry: PlatformRunEntry,
): PlatformRunEntry[] {
  const map = new Map<string, PlatformRunEntry>()
  for (const row of existing) map.set(row.id, row)
  map.set(entry.id, entry)
  return Array.from(map.values()).sort((a, b) => b.appliedAt - a.appliedAt)
}

export function latestPlatformRunEntry(entries: PlatformRunEntry[]): PlatformRunEntry | null {
  if (!entries.length) return null
  return entries.reduce((best, row) => (row.appliedAt >= best.appliedAt ? row : best))
}

export function latestPlatformRunEntryId(entries: PlatformRunEntry[]): string {
  return latestPlatformRunEntry(entries)?.id || ''
}

export function normalizePlatformRunEntries(raw: unknown): PlatformRunEntry[] {
  if (!Array.isArray(raw)) return []
  const out: PlatformRunEntry[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const title = asString(o.title)
    if (!title) continue
    const id = asString(o.id) || `platform:${title}:${out.length}`
    if (seen.has(id)) continue
    seen.add(id)
    const kindRaw = asString(o.kind).toLowerCase()
    const kind: PlatformUiFeedback['kind'] =
      kindRaw === 'warning' || kindRaw === 'error' ? kindRaw : 'success'
    out.push({
      id,
      kind,
      title,
      verb: asString(o.verb) || undefined,
      domain: asString(o.domain) || undefined,
      entityType: asString(o.entityType) || undefined,
      entityLabel: asString(o.entityLabel) || undefined,
      entityId: asString(o.entityId) || null,
      subtitle: asString(o.subtitle) || undefined,
      details: asDetails(o.details),
      actions: asActions(o.actions),
      action: asString(o.action) || undefined,
      toolCallId: asString(o.toolCallId) || undefined,
      appliedAt: Number(o.appliedAt) || Date.now(),
    })
  }
  return out.sort((a, b) => b.appliedAt - a.appliedAt)
}

function parseAppliedAt(raw: unknown): number {
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  const parsed = Date.parse(String(raw || ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
}

type PlatformArtifactWire = {
  id?: string
  type?: string
  name?: string
  label?: string
  url?: string
  createdAt?: string
  updatedAt?: string
  platformAction?: string
  platformDomain?: string
  platformFeedbackKind?: string
  platformSubtitle?: string
  toolCallId?: string
  platformActions?: unknown
  actions?: unknown
}

/** Restore Info Rail platform rows from persisted session artifacts. */
export function platformRunEntryFromChatArtifact(raw: PlatformArtifactWire): PlatformRunEntry | null {
  if (String(raw.type || '').trim().toLowerCase() !== 'platform') return null
  const title = asString(raw.label || raw.name)
  if (!title) return null
  const kindRaw = asString(raw.platformFeedbackKind).toLowerCase()
  const kind: PlatformUiFeedback['kind'] =
    kindRaw === 'warning' || kindRaw === 'error' ? kindRaw : 'success'
  let actions = asActions(raw.platformActions || raw.actions)
  const route = asString(raw.url)
  if (!actions.length && route) {
    actions = [{ label: '查看', route }]
  }
  const appliedAt = parseAppliedAt(raw.updatedAt || raw.createdAt)
  const toolCallId = asString(raw.toolCallId)
  const id =
    asString(raw.id) ||
    (toolCallId ? `platform:${toolCallId}` : `platform:${asString(raw.platformAction) || title}:${appliedAt}`)
  return {
    id,
    kind,
    title,
    subtitle: asString(raw.platformSubtitle) || undefined,
    domain: asString(raw.platformDomain) || undefined,
    action: asString(raw.platformAction) || undefined,
    toolCallId: toolCallId || undefined,
    actions: actions.length ? actions : undefined,
    appliedAt,
  }
}

export function platformRunEntriesFromChatArtifacts(raw: unknown): PlatformRunEntry[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const out: PlatformRunEntry[] = []
  const seen = new Set<string>()
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const entry = platformRunEntryFromChatArtifact(row as PlatformArtifactWire)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out.sort((a, b) => b.appliedAt - a.appliedAt)
}

export function buildPlatformFeedbackSurface(ui: PlatformUiFeedback): Partial<RightStageSurface> {
  const data: PlatformFeedbackSurfaceData = {
    ...ui,
    appliedAt: Date.now(),
  }
  return {
    id: 'primary',
    kind: 'platform-feedback',
    title: '平台操作',
    layout: 'narrow',
    data: data as unknown as Record<string, unknown>,
  }
}

export function applyPlatformFeedbackFromToolResult(
  raw: unknown,
  opts?: {
    argsText?: string
    toolCallId?: string
    existingEntries?: PlatformRunEntry[]
  },
): { ui: PlatformUiFeedback; entries: PlatformRunEntry[] } | null {
  void syncPanelAppearanceFromToolResult(raw, { argsText: opts?.argsText })
  const ui = parsePlatformUiFeedback(raw, opts?.argsText)
  if (!ui) return null
  const entry = platformUiToRunEntry(ui, opts?.toolCallId)
  const entries = mergePlatformRunEntries(opts?.existingEntries || [], entry)
  return { ui, entries }
}

function toolPlatformName(tool: Record<string, unknown>): string {
  const fn = asDict(tool.function)
  return asString(tool.name || tool.tool_kind || fn.name).toLowerCase()
}

function toolPlatformOutput(tool: Record<string, unknown>): string {
  const preservedUi = tool.platform_ui
  if (preservedUi && typeof preservedUi === 'object' && !Array.isArray(preservedUi)) {
    const payload: Record<string, unknown> = {
      ok: tool.platform_ok !== false,
      action: tool.platform_action,
      item: tool.platform_item,
      agent: tool.platform_agent,
      role: tool.platform_role,
      ui: preservedUi,
    }
    const preservedSettings = tool.platform_settings
    if (
      preservedSettings &&
      typeof preservedSettings === 'object' &&
      !Array.isArray(preservedSettings)
    ) {
      payload.settings = preservedSettings
    }
    const clientEffect = asString(tool.platform_client_effect)
    if (clientEffect) payload.client_effect = clientEffect
    return JSON.stringify(payload)
  }
  const out = tool.output ?? tool.content ?? tool.result
  if (typeof out === 'string') return out
  if (out && typeof out === 'object') {
    try {
      return JSON.stringify(out)
    } catch {
      return ''
    }
  }
  return ''
}

function toolPlatformArgs(tool: Record<string, unknown>): string {
  const fn = asDict(tool.function)
  const raw = tool.input ?? tool.argsText ?? fn.arguments
  return typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : ''
}

function toolIsRunning(tool: Record<string, unknown>): boolean {
  const phase = asString(tool._aguiPhase)
  const status = asString(tool.status).toLowerCase()
  return phase === 'running' || phase === 'args' || status === 'running' || status === 'pending_approval'
}

/** Scan completed platform tool rows; merge into Info Rail「平台」tab only. */
export function syncPlatformFeedbackFromTools(
  tools: unknown[],
  seen: Set<string>,
  opts?: { existingEntries?: PlatformRunEntry[] },
): { shown: PlatformUiFeedback[]; entries: PlatformRunEntry[] } {
  const shown: PlatformUiFeedback[] = []
  let entries = opts?.existingEntries || []
  if (!Array.isArray(tools)) return { shown, entries }

  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    const tool = raw as Record<string, unknown>
    if (toolPlatformName(tool) !== 'platform') continue
    if (toolIsRunning(tool)) continue

    const toolCallId = asString(tool.id || tool.tool_call_id)
    if (!toolCallId || seen.has(toolCallId)) continue

    const output = toolPlatformOutput(tool)
    if (!output.trim()) continue

    const argsText = toolPlatformArgs(tool)
    const result = applyPlatformFeedbackFromToolResult(output, {
      argsText,
      toolCallId,
      existingEntries: entries,
    })
    if (!result) continue

    seen.add(toolCallId)
    shown.push(result.ui)
    entries = result.entries
  }
  return { shown, entries }
}

export const PLATFORM_FEEDBACK_KIND = 'platform-feedback'

export function canOpenPlatformFeedbackFromTool(tool: Record<string, unknown>): boolean {
  if (toolPlatformName(tool) !== 'platform') return false
  if (toolIsRunning(tool)) return false
  return Boolean(parsePlatformUiFeedback(toolPlatformOutput(tool), toolPlatformArgs(tool)))
}

export function openPlatformFeedbackFromTool(
  tool: Record<string, unknown>,
  existingEntries: PlatformRunEntry[] = [],
): { ui: PlatformUiFeedback; entries: PlatformRunEntry[] } | null {
  const toolCallId = asString(tool.id || tool.tool_call_id)
  const ui = parsePlatformUiFeedback(toolPlatformOutput(tool), toolPlatformArgs(tool))
  if (!ui) return null
  const entry = platformUiToRunEntry(ui, toolCallId)
  const entries = mergePlatformRunEntries(existingEntries, entry)
  return { ui, entries }
}
