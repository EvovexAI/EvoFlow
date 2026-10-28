/** Parse platform tool JSON result and apply Right Stage feedback panel. */

import { syncEmployeeChatSendFromToolResult } from '../employee-chat-send-sync.js'
import { syncEmployeesRosterFromToolResult } from '../employees-roster-sync.js'
import { syncPanelAppearanceFromToolResult } from '../panel-appearance-sync.js'
import { openProgressFromPanelSet } from './open-progress-from-panel-set.js'
import {
  logRightStage,
  logRightStagePlatform,
  logRightStageTrigger,
} from './panel-set-debug-log.js'
import { rightStageStore } from './right-stage-store.js'
import type { RightStageSurface } from './right-stage-types.js'

function safePreviewObj(raw: unknown): string {
  try {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    if (!o) return ''
    const pick: Record<string, unknown> = {}
    for (const k of [
      'ok',
      'action',
      'client_effect',
      'agent_code',
      'agentCode',
      'role_name',
      'name',
      'session_key',
      'sessionKey',
      'task_id',
      'taskId',
      'message',
      'queued',
      'ignored_caller_session_key',
    ]) {
      if (o[k] !== undefined) {
        const v = o[k]
        pick[k] =
          typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…` : v
      }
    }
    return JSON.stringify(pick)
  } catch {
    return ''
  }
}

export type PlatformFeedbackDetail = {
  label: string
  value: string
}

export type PlatformFeedbackOpenStage = {
  kind?: string
  title?: string
  layout?: string
  data?: Record<string, unknown> | null
}

export type PlatformFeedbackAction = {
  label: string
  route?: string
  external?: boolean
  /** 打开右栏进度面板（工作流 / 节点 / 员工），不跳路由 */
  openStage?: PlatformFeedbackOpenStage
  /** 工具结果到达时立刻展开右栏（如 workflow.run），无需再点 CTA */
  autoOpen?: boolean
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
  /** employees.bind_channel_begin — raw QR payload (URL or text for local encoder) */
  qrUrl?: string
  sessionId?: string
  channel?: string
  agentCode?: string
  bindStatus?: 'pending' | 'scanning' | 'bound' | 'failed' | 'expired'
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
  'employees.create': '已创建员工',
  'employees.bind_channel_begin': '扫码绑定本岗 AI 员工',
  'employees.bind_channel_apply': '已绑定本岗 AI 员工',
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
  'employees.get': (label) => `员工「${label}」`,
  'employees.brief': (label) => `员工「${label}」近况`,
  'employees.chat_send': (label) => `已向「${label}」发送消息`,
  'employees.messages': (label) => `员工「${label}」近况消息`,
  'employees.list': () => '员工列表',
  'employees.org_status': () => '员工名册',
  'employees.board_overview': () => '员工看板',
  'employees.create': (label) => `已创建智能体员工「${label}」`,
  'employees.bind_channel_begin': (label) => `已为「${label}」生成绑定二维码`,
  'employees.bind_channel_apply': (label) => `已绑定本岗 AI 员工「${label}」`,
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

function asOpenStage(raw: unknown): PlatformFeedbackOpenStage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const kind = asString(row.kind)
  const data =
    row.data && typeof row.data === 'object' && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : null
  if (!kind && !data) return undefined
  return {
    kind: kind || undefined,
    title: asString(row.title) || undefined,
    layout: asString(row.layout) || undefined,
    data,
  }
}

function asActions(raw: unknown): PlatformFeedbackAction[] {
  if (!Array.isArray(raw)) return []
  const out: PlatformFeedbackAction[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const label = asString((row as Record<string, unknown>).label)
    if (!label) continue
    const route = asString((row as Record<string, unknown>).route)
    const openStage = asOpenStage((row as Record<string, unknown>).openStage)
    out.push({
      label,
      route: route || undefined,
      external: (row as Record<string, unknown>).external === true,
      openStage,
      autoOpen: (row as Record<string, unknown>).autoOpen === true,
    })
  }
  return out
}

export type PlatformAutoOpenDiag = {
  opened: boolean
  /** 人类可读原因：opened / no-ui / no-actions / no-autoOpen-openStage / openProgress-failed */
  reason: string
  action?: string
  domain?: string
  entityId?: string
  title?: string
  tabId?: string
  actions: Array<{
    label: string
    autoOpen?: boolean
    kind?: string
    route?: string
    path?: string
  }>
}

/** 诊断 + 打开；V4 / 语音旁路共用。 */
export function tryAutoOpenPlatformProgress(
  ui: PlatformUiFeedback | null | undefined,
): PlatformAutoOpenDiag {
  if (!ui) {
    return { opened: false, reason: 'no-ui', actions: [] }
  }
  const enriched = enrichShellPageOpenStages(ui)
  const actions = (Array.isArray(enriched.actions) ? enriched.actions : []).map((a) => ({
    label: String(a.label || '').trim(),
    autoOpen: a.autoOpen === true,
    kind: a.openStage?.kind,
    route: a.route,
    path: asString(a.openStage?.data?.path) || asString(a.openStage?.data?.route) || undefined,
  }))
  const base = {
    action: asString(enriched.action) || undefined,
    domain: asString(enriched.domain) || undefined,
    entityId: asString(enriched.entityId) || asString(enriched.agentCode) || undefined,
    title: asString(enriched.title) || undefined,
    actions,
  }
  if (!actions.length) {
    return { opened: false, reason: 'no-actions', ...base }
  }
  const hit = enriched.actions?.find((a) => a && a.autoOpen && a.openStage)
  if (!hit?.openStage) {
    return { opened: false, reason: 'no-autoOpen-openStage', ...base }
  }
  logRightStageTrigger('maybeAutoOpenPlatformProgress', {
    kind: hit.openStage?.kind,
    label: hit.label,
    openStage: hit.openStage,
    action: base.action,
    domain: base.domain,
  })
  const tabId = openProgressFromPanelSet(hit.openStage)
  if (!tabId) {
    logRightStageTrigger('maybeAutoOpenPlatformProgress failed', {
      reason: 'openProgress-failed',
      kind: hit.openStage?.kind,
      dataKeys: hit.openStage?.data ? Object.keys(hit.openStage.data) : [],
    })
    return { opened: false, reason: 'openProgress-failed', tabId: '', ...base }
  }
  if (rightStageStore.getSnapshot().collapsed) rightStageStore.expand()
  void import('../xw-voice-mode.js')
    .then((m) => {
      if (!m.isXwVoiceMode?.()) return
      m.allowXwVoiceSummary?.()
      if (rightStageStore.getSnapshot().collapsed) rightStageStore.expand()
    })
    .catch(() => {})
  logRightStageTrigger(
    'maybeAutoOpenPlatformProgress opened',
    { tabId, kind: hit.openStage?.kind, label: hit.label, ...base },
    { store: rightStageStore },
  )
  return { opened: true, reason: 'opened', tabId, ...base }
}

/**
 * 若 CTA 带 autoOpen+openStage，立刻拉开右栏（进度 kind 或 shell-page）。
 * 共享工具：V4（ConversationTurnGroup）与旧 AG-UI 热路径都会调用。
 * 默认产品聊天以 V4 调用为准；只改调用方不够时再改本函数。
 */
export function maybeAutoOpenPlatformProgress(ui: PlatformUiFeedback | null | undefined): boolean {
  return tryAutoOpenPlatformProgress(ui).opened
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

/** Delete/archive/clear: entity is gone — notify only, no 「查看xxx」 CTA. */
function entityRemovedByAction(action: string): boolean {
  const verb = String(action || '').split('.')[1] || ''
  return verb === 'delete' || verb === 'archive' || verb === 'clear' || verb === 'note_delete'
}

function shellPageAction(opts: {
  label: string
  path: string
  mountId: string
  title?: string
  entityLabel?: string
  autoOpen?: boolean
  focusId?: string
  route?: string
}): PlatformFeedbackAction {
  const path = String(opts.path || '').trim()
  // 标签用实体名；title 同时写进 openStage 与 data，防 V4 mirror 丢字段时仍能回落
  const nice =
    String(opts.entityLabel || opts.title || '').trim() ||
    (opts.mountId.startsWith('employees')
      ? '员工'
      : opts.mountId.startsWith('items')
        ? '待办'
        : opts.mountId.startsWith('tasks')
          ? '任务'
          : '页面')
  const data: Record<string, unknown> = {
    path,
    route: path,
    mountId: opts.mountId,
    title: nice,
    entityLabel: String(opts.entityLabel || opts.title || '').trim(),
  }
  const focusId = String(opts.focusId || '').trim()
  if (focusId) data.focusId = focusId
  const out: PlatformFeedbackAction = {
    label: opts.label,
    route: String(opts.route || path).trim() || path,
    openStage: {
      kind: 'shell-page',
      title: nice,
      layout: 'wide',
      data,
    },
  }
  if (opts.autoOpen) out.autoOpen = true
  return out
}

/** 写成功 / 查看详情·近况·名册 且无进度抢栏时：详情页 shell-page + autoOpen */
function shouldAutoOpenShellPage(action: string): boolean {
  return (
    action === 'employees.create' ||
    action === 'employees.hire' ||
    action === 'employees.update' ||
    action === 'employees.get' ||
    action === 'employees.brief' ||
    action === 'employees.list' ||
    action === 'employees.org_status' ||
    action === 'employees.board_overview' ||
    action === 'tasks.update' ||
    action === 'tasks.set_state' ||
    action === 'tasks.get' ||
    action === 'tasks.list' ||
    action === 'items.create' ||
    action === 'items.update' ||
    action === 'items.get' ||
    action === 'items.list'
  )
}

function isProgressOpenStageKind(kind: string | null | undefined): boolean {
  const k = String(kind || '').trim()
  return (
    k === 'employeeProcess' ||
    k === 'employee-process' ||
    k === 'collab-workflow' ||
    k === 'collab_workflow' ||
    k === 'collabSubtaskTranscript' ||
    k === 'collab-subtask'
  )
}

/**
 * 把「只有 route」的查看员工/任务 CTA 升成 shell-page openStage。
 * 解决：最新通知（Info Rail）已出，但 V4 display / 旧网关未带 openStage → 更右 Stage 不开。
 */
export function enrichShellPageOpenStages(ui: PlatformUiFeedback): PlatformUiFeedback {
  const action = asString(ui.action)
  const domain = asString(ui.domain)
  const entityId = asString(ui.entityId) || asString(ui.agentCode)
  const entityLabel = asString(ui.entityLabel)
  // 显式标注：map 重塑会把 openStage 变成「必填但可 undefined」，与
  // PlatformFeedbackAction 的可选 openStage 失配，导致后面 actions.push 报 TS2345
  const actions: PlatformFeedbackAction[] = (Array.isArray(ui.actions) ? ui.actions : []).map((a) => ({
    ...a,
    openStage: a.openStage ? { ...a.openStage, data: a.openStage.data ? { ...a.openStage.data } : a.openStage.data } : undefined,
  }))
  const hasProgressStage = actions.some((a) => isProgressOpenStageKind(a.openStage?.kind))
  const autoOk = shouldAutoOpenShellPage(action) && !hasProgressStage

  let touched = false
  for (const a of actions) {
    const route = asString(a.route)
    const existingKind = asString(a.openStage?.kind)
    if (existingKind === 'shell-page' || existingKind === 'shell_page' || existingKind === 'shellPage') {
      if (autoOk && !a.autoOpen) {
        a.autoOpen = true
        touched = true
      }
      // 旧 CTA 可能写 /employees → 归一成 /proactive，否则挂载表 miss
      if (a.openStage) {
        const rawPath = asString(a.openStage.data?.path) || asString(a.openStage.data?.route) || asString(a.route)
        let nextPath = rawPath
        if (rawPath === '/employees' || rawPath === '/employees/') nextPath = '/proactive'
        else {
          const m = rawPath.match(/^\/employees\/([^/?#]+)\/?$/)
          if (m) nextPath = `/proactive/${decodeURIComponent(m[1])}`
        }
        if (nextPath && nextPath !== rawPath) {
          a.openStage = {
            ...a.openStage,
            data: {
              ...(a.openStage.data || {}),
              path: nextPath,
              route: nextPath,
            },
          }
          a.route = nextPath
          touched = true
        }
      }
      // 已有 shell-page 但标题是 path / 空：用 entityLabel 补可读名
      if (entityLabel && a.openStage) {
        const cur = asString(a.openStage.title) || asString(a.openStage.data?.title)
        if (!cur || cur.startsWith('/') || cur.startsWith('#/')) {
          a.openStage = {
            ...a.openStage,
            title: entityLabel,
            data: {
              ...(a.openStage.data || {}),
              title: entityLabel,
              entityLabel,
            },
          }
          touched = true
        }
      }
      continue
    }
    if (existingKind) continue

    if (
      route === '/proactive' ||
      route === '/proactive/' ||
      route === '/employees' ||
      route === '/employees/'
    ) {
      Object.assign(
        a,
        shellPageAction({
          label: a.label || '打开员工',
          path: '/proactive',
          mountId: 'employees.board',
          title: '员工',
          entityLabel: '员工',
          autoOpen:
            autoOk ||
            action === 'employees.list' ||
            action === 'employees.org_status' ||
            action === 'employees.board_overview',
        }),
      )
      touched = true
      continue
    }
    const emp = route.match(/^\/(?:proactive|employees)\/([^/?#]+)\/?$/)
    if (emp && emp[1] !== 'board' && emp[1] !== 'approvals') {
      const path = `/proactive/${decodeURIComponent(emp[1])}`
      Object.assign(
        a,
        shellPageAction({
          label: a.label || '查看员工',
          path,
          mountId: 'employees.detail',
          title: entityLabel || '员工',
          entityLabel: entityLabel || undefined,
          autoOpen: autoOk,
        }),
      )
      touched = true
      continue
    }
    const task = route.match(/^\/task\/([^/?#]+)\/?$/)
    if (task) {
      const path = `/task/${decodeURIComponent(task[1])}`
      Object.assign(
        a,
        shellPageAction({
          label: a.label || '查看任务',
          path,
          mountId: 'tasks.detail',
          title: entityLabel || '任务',
          entityLabel: entityLabel || undefined,
          // 有进度 CTA 时不抢栏；无进度时 tasks.create 也可开详情
          autoOpen: autoOk,
        }),
      )
      touched = true
      continue
    }
    // 主区待办深链 / 旧 route → 右栏 items.board
    if (
      route === '/tasks' ||
      route === '/tasks/' ||
      route.startsWith('/tasks?') ||
      route === '/tasks/items' ||
      route.startsWith('/tasks/items')
    ) {
      const qs = route.includes('?') ? route.slice(route.indexOf('?') + 1) : ''
      const params = new URLSearchParams(qs)
      const tab = params.get('tab') || ''
      const focus = params.get('focus') || entityId || ''
      const asItems =
        tab === 'items' ||
        route === '/tasks/items' ||
        route.startsWith('/tasks/items') ||
        domain === 'items' ||
        action.startsWith('items.')
      if (asItems) {
        Object.assign(
          a,
          shellPageAction({
            label: a.label || '打开待办',
            path: '/tasks/items',
            mountId: 'items.board',
            title: entityLabel || '待办',
            entityLabel: entityLabel || '待办',
            focusId: focus || undefined,
            route: focus ? `/tasks?tab=items&focus=${encodeURIComponent(focus)}` : '/tasks?tab=items',
            autoOpen:
              autoOk ||
              action === 'items.list' ||
              action === 'items.create' ||
              action === 'items.update' ||
              action === 'items.get',
          }),
        )
      } else {
        Object.assign(
          a,
          shellPageAction({
            label: a.label || '打开任务',
            path: '/tasks',
            mountId: 'tasks.board',
            title: '任务',
            entityLabel: '任务',
            route: '/tasks',
            autoOpen: autoOk || action === 'tasks.list',
          }),
        )
      }
      touched = true
    }
  }

  if (
    autoOk &&
    entityId &&
    (domain === 'employees' || action.startsWith('employees.')) &&
    action !== 'employees.list' &&
    action !== 'employees.org_status' &&
    action !== 'employees.board_overview' &&
    !actions.some((a) => String(a.openStage?.kind || '').includes('shell'))
  ) {
    actions.push(
      shellPageAction({
        label: '查看员工',
        path: `/proactive/${entityId}`,
        mountId: 'employees.detail',
        title: entityLabel || '员工',
        entityLabel: entityLabel || undefined,
        autoOpen: true,
      }),
    )
    touched = true
  }

  if (
    (action === 'employees.list' ||
      action === 'employees.org_status' ||
      action === 'employees.board_overview') &&
    !actions.some((a) => String(a.openStage?.kind || '').includes('shell'))
  ) {
    actions.push(
      shellPageAction({
        label: '打开员工',
        path: '/proactive',
        mountId: 'employees.board',
        title: '员工',
        entityLabel: '员工',
        autoOpen: autoOk,
      }),
    )
    touched = true
  }

  if (
    (action === 'tasks.list' || (domain === 'tasks' && action === 'tasks.list')) &&
    !actions.some((a) => String(a.openStage?.kind || '').includes('shell'))
  ) {
    actions.push(
      shellPageAction({
        label: '打开任务',
        path: '/tasks',
        mountId: 'tasks.board',
        title: '任务',
        entityLabel: '任务',
        autoOpen: autoOk,
      }),
    )
    touched = true
  }

  if (
    (action === 'items.list' ||
      action === 'items.create' ||
      action === 'items.update' ||
      action === 'items.get') &&
    !actions.some((a) => String(a.openStage?.kind || '').includes('shell'))
  ) {
    actions.push(
      shellPageAction({
        label: action === 'items.list' ? '打开待办' : '查看事项',
        path: '/tasks/items',
        mountId: 'items.board',
        title: entityLabel || '待办',
        entityLabel: entityLabel || '待办',
        focusId: entityId || undefined,
        route: entityId
          ? `/tasks?tab=items&focus=${encodeURIComponent(entityId)}`
          : '/tasks?tab=items',
        autoOpen: autoOk,
      }),
    )
    touched = true
  }

  if (!touched) return ui
  return { ...ui, actions }
}

function buildActions(action: string, domain: string, entityId: string): PlatformFeedbackAction[] {
  if (entityRemovedByAction(action)) return []

  if (domain === 'items' && (action === 'items.list' || !entityId)) {
    return [
      shellPageAction({
        label: '打开待办',
        path: '/tasks/items',
        mountId: 'items.board',
        title: '待办',
        entityLabel: '待办',
        route: '/tasks?tab=items',
        autoOpen: shouldAutoOpenShellPage(action),
      }),
    ]
  }
  if (domain === 'items' && entityId) {
    return [
      shellPageAction({
        label: '查看事项',
        path: '/tasks/items',
        mountId: 'items.board',
        title: '待办',
        focusId: entityId,
        route: `/tasks?tab=items&focus=${encodeURIComponent(entityId)}`,
        autoOpen: shouldAutoOpenShellPage(action),
      }),
    ]
  }
  if (domain === 'tasks' && action === 'tasks.list') {
    return [
      shellPageAction({
        label: '打开任务',
        path: '/tasks',
        mountId: 'tasks.board',
        title: '任务',
        entityLabel: '任务',
        autoOpen: shouldAutoOpenShellPage(action),
      }),
    ]
  }
  if (domain === 'tasks' && entityId) {
    return [
      shellPageAction({
        label: '查看任务',
        path: `/task/${entityId}`,
        mountId: 'tasks.detail',
        autoOpen: shouldAutoOpenShellPage(action),
      }),
    ]
  }
  if (
    domain === 'employees' &&
    (action === 'employees.list' ||
      action === 'employees.org_status' ||
      action === 'employees.board_overview')
  ) {
    return [
      shellPageAction({
        label: '打开员工',
        path: '/proactive',
        mountId: 'employees.board',
        title: '员工',
        entityLabel: '员工',
        autoOpen: shouldAutoOpenShellPage(action),
      }),
    ]
  }
  if (domain === 'employees' && entityId) {
    return [
      shellPageAction({
        label: '查看员工',
        path: `/proactive/${entityId}`,
        mountId: 'employees.detail',
        autoOpen: shouldAutoOpenShellPage(action),
      }),
    ]
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
  // 普通只读不发反馈；查看详情 / 列表要能开 shell-page
  if (
    !domain ||
    !verb ||
    (READ_VERBS.has(verb) &&
      action !== 'employees.get' &&
      action !== 'employees.brief' &&
      action !== 'employees.list' &&
      action !== 'employees.org_status' &&
      action !== 'employees.board_overview' &&
      action !== 'tasks.get' &&
      action !== 'tasks.list' &&
      action !== 'items.get' &&
      action !== 'items.list')
  ) {
    return null
  }

  const args = parseJsonObject(argsText) || {}
  const label = pickLabel(obj, args) || DOMAIN_ENTITY_ZH[domain] || domain
  const entityId = pickEntityId(obj, args)
  const override = TITLE_OVERRIDES[action]
  const title = override ? override(label) : `${DOMAIN_ENTITY_ZH[domain] || domain}操作成功`
  const destructive = verb === 'delete' || verb === 'archive' || verb === 'clear' || verb === 'note_delete'

  const out: PlatformUiFeedback = {
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
  // 绑渠道：无 ui 块时仍从顶层 qr_url 恢复，保证工具下方能出码
  if (action === 'employees.bind_channel_begin') {
    const qrUrl = asString(obj.qr_url || obj.qrUrl)
    const sessionId = asString(obj.session_id || obj.sessionId)
    const channel = asString(obj.channel || args.channel).toLowerCase()
    if (qrUrl) out.qrUrl = qrUrl
    if (sessionId) out.sessionId = sessionId
    if (channel) out.channel = channel
    if (entityId) out.agentCode = entityId
    if (qrUrl || sessionId) out.bindStatus = 'pending'
  }
  return out
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
  const action = asString(ui.action || obj.action) || undefined
  const domain = asString(ui.domain) || (action?.includes('.') ? action.split('.')[0] : undefined)
  const entityId = asString(ui.entityId) || asString(ui.agentCode) || asString(obj.agent_code) || null
  let actions = asActions(ui.actions)
  // 线上下发的 ui 偶发只有 title、actions 被 slim 丢光：按 action/domain 回补壳页 CTA
  if (!actions.length && action && domain) {
    actions = buildActions(action, domain, entityId || '')
  }
  const out: PlatformUiFeedback = {
    kind,
    verb: asString(ui.verb) || undefined,
    domain: domain || undefined,
    entityType: asString(ui.entityType) || undefined,
    entityLabel: asString(ui.entityLabel) || undefined,
    entityId,
    icon: asString(ui.icon) || undefined,
    title,
    subtitle: asString(ui.subtitle) || undefined,
    details: asDetails(ui.details),
    actions,
    action,
  }
  const qrUrl = asString(ui.qrUrl || ui.qr_url || obj.qr_url || obj.qrUrl)
  const sessionId = asString(ui.sessionId || ui.session_id || obj.session_id || obj.sessionId)
  const channel = asString(ui.channel || obj.channel).toLowerCase()
  const agentCode = asString(ui.agentCode || ui.agent_code || obj.agent_code || obj.agentCode || ui.entityId)
  const bindRaw = asString(ui.bindStatus || ui.bind_status).toLowerCase()
  if (qrUrl) out.qrUrl = qrUrl
  if (sessionId) out.sessionId = sessionId
  if (channel) out.channel = channel
  if (agentCode) out.agentCode = agentCode
  if (
    bindRaw === 'pending' ||
    bindRaw === 'scanning' ||
    bindRaw === 'bound' ||
    bindRaw === 'failed' ||
    bindRaw === 'expired'
  ) {
    out.bindStatus = bindRaw
  } else if (qrUrl && sessionId) {
    out.bindStatus = 'pending'
  }
  return out
}

export function parsePlatformUiFeedback(raw: unknown, argsText?: string): PlatformUiFeedback | null {
  const obj = parseJsonObject(raw)
  if (!obj || obj.ok === false || obj.pending_confirm === true) return null
  const ui = uiFromBackend(obj) || inferPlatformUiFeedbackFallback(obj, argsText)
  return ui ? enrichShellPageOpenStages(ui) : null
}

export function platformFeedbackTitleFromToolOutput(raw: unknown, argsText?: string): string {
  return parsePlatformUiFeedback(raw, argsText)?.title || ''
}

export function navigatePlatformFeedbackRoute(route: string): void {
  let next = asString(route)
  if (!next || typeof window === 'undefined') return
  // 别名落到真实菜单路由，避免主区 404 / 空白
  if (next === '/employees' || next === '#/employees') next = '/proactive'
  else if (next === '/tasks/items' || next === '#/tasks/items') next = '/tasks?tab=items'
  else {
    const emp = next.replace(/^#/, '').match(/^\/employees\/([^/?#]+)/)
    if (emp) next = `/proactive/${emp[1]}`
    else {
      const items = next.replace(/^#/, '').match(/^\/tasks\/items\/?(\?.*)?$/)
      if (items) next = `/tasks?tab=items${items[1] || ''}`
    }
  }
  const hash = next.startsWith('#') ? next.slice(1) : next.startsWith('/') ? next : `/${next}`
  window.location.hash = hash
}

/** 平台反馈 CTA：优先 openStage（右栏），失败再跳 route。 */
export function activatePlatformFeedbackAction(action: PlatformFeedbackAction | null | undefined): boolean {
  if (!action) return false
  // 点「查看员工/任务」时：只有 route 也升成 shell-page，避免整窗跳转
  let openStage = action.openStage
  if (!openStage?.kind && action.route) {
    const enriched = enrichShellPageOpenStages({
      kind: 'success',
      title: action.label || '查看',
      actions: [{ ...action }],
    })
    openStage = enriched.actions?.[0]?.openStage
  }
  if (openStage) {
    const tabId = openProgressFromPanelSet(openStage)
    if (tabId) return true
  }
  if (action.route) {
    navigatePlatformFeedbackRoute(action.route)
    return true
  }
  return false
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
    /** Live tool results only — history scan must not spam roster reloads. */
    notifyEmployeesRoster?: boolean
    /**
     * 是否处理 employees.chat_send 的 client_effect（开右栏 + pendingSend）。
     * 与 roster 解耦：AG-UI 热路径常关 roster，但仍必须同步 chat_send。
     * 缺省跟 notifyEmployeesRoster；显式传 true/false 优先。
     */
    syncEmployeeChatSend?: boolean
    /** Live results only — history scan must not discard unrelated open tabs. */
    closeRemovedEntityStage?: boolean
  },
): { ui: PlatformUiFeedback; entries: PlatformRunEntry[] } | null {
  const t0 = Date.now()
  void syncPanelAppearanceFromToolResult(raw, { argsText: opts?.argsText })
  if (opts?.notifyEmployeesRoster !== false) {
    syncEmployeesRosterFromToolResult(raw, { argsText: opts?.argsText })
  }
  // Live only：历史扫描勿重复 chatSend。与 roster 开关解耦。
  const syncChat =
    opts?.syncEmployeeChatSend !== undefined
      ? opts.syncEmployeeChatSend
      : opts?.notifyEmployeesRoster !== false
  if (syncChat) {
    void syncEmployeeChatSendFromToolResult(raw, { argsText: opts?.argsText })
  }
  const ui = parsePlatformUiFeedback(raw, opts?.argsText)
  const rawPreview =
    typeof raw === 'string'
      ? raw.slice(0, 400)
      : raw && typeof raw === 'object'
        ? safePreviewObj(raw)
        : String(raw ?? '')
  logRightStagePlatform('applyPlatformFeedback', {
    toolCallId: opts?.toolCallId || null,
    live: opts?.notifyEmployeesRoster !== false,
    hasUi: Boolean(ui),
    action: ui?.action || null,
    domain: ui?.domain || null,
    agentCode: ui?.agentCode || null,
    clientEffect:
      (raw && typeof raw === 'object' && !Array.isArray(raw)
        ? String((raw as Record<string, unknown>).client_effect || '')
        : '') || null,
    actionCount: Array.isArray(ui?.actions) ? ui!.actions!.length : 0,
    autoOpenKinds: (ui?.actions || [])
      .filter((a) => a?.autoOpen && a?.openStage?.kind)
      .map((a) => a.openStage!.kind),
    argsPreview: String(opts?.argsText || '').slice(0, 240) || null,
    rawPreview: rawPreview || null,
    ms: Date.now() - t0,
  })
  if (!ui) return null
  // 删除/归档成功：立刻丢掉指向该实体的右栏页签，避免再点开「Role not found」
  if (opts?.closeRemovedEntityStage !== false && entityRemovedByAction(String(ui.action || ''))) {
    const entityId = String(ui.entityId || ui.agentCode || '').trim()
    if (entityId && ui.domain) {
      void import('./close-removed-entity-stage.js')
        .then((m) => {
          m.closeRightStageTabsForRemovedEntity({
            domain: ui.domain,
            entityId,
            agentCode: ui.agentCode || entityId,
          })
        })
        .catch(() => {})
    }
  }
  const entry = platformUiToRunEntry(ui, opts?.toolCallId)
  const entries = mergePlatformRunEntries(opts?.existingEntries || [], entry)
  return { ui, entries }
}

function toolPlatformName(tool: Record<string, unknown>): string {
  const fn = asDict(tool.function)
  return asString(tool.name || tool.tool_kind || fn.name).toLowerCase()
}

function toolPlatformOutput(tool: Record<string, unknown>): string {
  const preservedUi =
    (tool.platform_ui && typeof tool.platform_ui === 'object' && !Array.isArray(tool.platform_ui)
      ? tool.platform_ui
      : null) ||
    (tool.platformUi && typeof tool.platformUi === 'object' && !Array.isArray(tool.platformUi)
      ? tool.platformUi
      : null)
  if (preservedUi) {
    const payload: Record<string, unknown> = {
      ok: tool.platform_ok !== false && tool.platformOk !== false,
      action: tool.platform_action || tool.platformAction,
      item: tool.platform_item || tool.platformItem,
      agent: tool.platform_agent || tool.platformAgent,
      role: tool.platform_role || tool.platformRole,
      ui: preservedUi,
      // Bind QR may also sit on the tool row after slimming.
      qr_url: (preservedUi as Record<string, unknown>).qrUrl || (preservedUi as Record<string, unknown>).qr_url,
      session_id:
        (preservedUi as Record<string, unknown>).sessionId ||
        (preservedUi as Record<string, unknown>).session_id,
      channel: (preservedUi as Record<string, unknown>).channel,
      agent_code:
        (preservedUi as Record<string, unknown>).agentCode ||
        (preservedUi as Record<string, unknown>).agent_code,
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

    const toolCallId = asString(tool.id || tool.tool_call_id || tool.toolCallId)
    if (!toolCallId || seen.has(toolCallId)) continue

    const output = toolPlatformOutput(tool)
    if (!output.trim()) continue

    const argsText = toolPlatformArgs(tool)
    const result = applyPlatformFeedbackFromToolResult(output, {
      argsText,
      toolCallId,
      existingEntries: entries,
      notifyEmployeesRoster: false,
      // chat_send 必须同步；与 roster 解耦（历史扫描也要能开右栏 pending）
      syncEmployeeChatSend: true,
      // 历史扫描只合并 Info Rail，勿因旧删除记录误关当前打开的页签
      closeRemovedEntityStage: false,
    })
    // 无 ui 的 chat_send：sync 已跑；仍标记 seen，避免重复 pending
    if (!result) {
      const effect =
        typeof output === 'string'
          ? (() => {
              try {
                const o = JSON.parse(output)
                return String(o?.client_effect || '').trim()
              } catch {
                return ''
              }
            })()
          : ''
      if (effect === 'employee_chat_send') seen.add(toolCallId)
      continue
    }

    seen.add(toolCallId)
    shown.push(result.ui)
    entries = result.entries
    // tools 列表扫描也可能是首个见到结果的路径（早于 AG-UI RESULT 发布）；
    // 必须在此 autoOpen，否则 seen 标过后 RESULT 路径会跳过打开。
    maybeAutoOpenPlatformProgress(result.ui)
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
