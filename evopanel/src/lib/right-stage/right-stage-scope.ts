/**
 * 右栏标签归属判定（对齐 ZCode side pane 的 scope 过滤）。
 *
 * ZCode 的做法：只有一份 tabs 数组，每个 tab 打上归属（ownerTaskId /
 * parentSessionId / sessionId），读取时按当前 scope 过滤；`git`、`developer-tools`
 * 这类是 workspace 全局，任何对话都能看见。
 *
 * EvoFlow 的 store 是"当前会话整表"，所以这里的 scope 决定两件事：
 * 1. 创建时是否自动冻结当前会话归属（避免"忘了传 sessionKey → 对所有会话可见"）；
 * 2. 切会话换表时是否保留（workspace 级面板不参与会话隔离）。
 *
 * 刻意做成显式白名单而不是"默认全局"：漏登记的 kind 会退回会话级，
 * 宁可少看见，也不要串台。
 */

/** workspace 级：同一工作区所有会话共享，切会话时保留。 */
const WORKSPACE_SCOPED_KINDS = new Set<string>([
  'workspace-browse',
  'write',
  'mind-map',
  'collab-workflow',
  // 小V：全局前台，切会话仍保留
  'xiaomi',
  // 进度类：任意对话可盯同一工作流/节点/员工过程（panel_set 跨会话）
  'collabSubtaskTranscript',
  'employeeProcess',
])

/**
 * 会话级：只属于产生它的那条会话。
 * 除白名单外的所有 kind 都落在这里（含 browser / file / terminal / web-embed 等）。
 */
const SESSION_SCOPED_KINDS = new Set<string>([
  'browser',
  'web-embed',
  'news-dashboard',
  'platform-feedback',
  'file',
  'codeViewer',
  'terminal',
  'summary',
  'subagentTranscript',
  'artifacts',
  'screenshot',
])

export type RightStageScope = 'workspace' | 'session'

/**
 * 当前 UI 正在展示的右栏会话。
 *
 * 放在本模块（而不是 right-stage-session-memory）是为了打断循环依赖：
 * store 需要在 show() 里读它，而 session-memory 又依赖 store。
 */
let currentSessionKey = ''

export function getCurrentRightStageSessionKey(): string {
  return currentSessionKey
}

export function setCurrentRightStageSessionKey(sessionKey: string | null | undefined) {
  currentSessionKey = String(sessionKey || '').trim()
}

/** 判定 kind 的归属层级；未知 kind 一律会话级（宁可少看见，不可串台）。 */
export function scopeOfKind(kind: string | null | undefined): RightStageScope {
  const k = String(kind || '').trim()
  if (!k) return 'session'
  if (WORKSPACE_SCOPED_KINDS.has(k)) return 'workspace'
  if (SESSION_SCOPED_KINDS.has(k)) return 'session'
  return 'session'
}

/**
 * 打开标签时的归属默认值。
 *
 * 调用方显式传了就尊重；没传时按 scope 决定：
 * - workspace 级 → 不写 sessionKey（对所有会话可见，切会话时保留）
 * - session 级   → 冻结当前 UI 会话
 *
 * 这正是 ZCode `stampSidePaneTabsOwnership` 的等价物：归属在创建时就定死，
 * 不指望后续补打（补打规则永远覆盖不全，ZCode 为此踩过 remoteSessionId 的坑）。
 */
export function resolveTabSessionKey(
  kind: string | null | undefined,
  explicit: string | null | undefined,
  currentSessionKey: string | null | undefined,
): string | undefined {
  const given = String(explicit || '').trim()
  if (given) return given
  if (scopeOfKind(kind) === 'workspace') return undefined
  const current = String(currentSessionKey || '').trim()
  return current || undefined
}
