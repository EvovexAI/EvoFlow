/** Right-side extensible stage — shared types (EvoPanel). */

export type RightStageLayout = 'half' | 'wide' | 'narrow' | 'workspace-browse' | 'workspace-write'

export type RightStageKind =
  | 'workspace-browse'
  | 'write'
  | 'artifacts'
  | 'mind-map'
  | 'collab-workflow'
  | 'platform-feedback'
  | 'news-dashboard'
  | 'web-embed'
  | 'xiaomi'
  | string

/**
 * 「这个面板是谁打开的」——用户 2026-11-23 明确要求：
 * 「右侧侧边那个地方，其实要加上一个标识，说明这个是谁打开的……无论是对应的某个
 * 智能体、某个会话还是用户，无非就是这 3 个地方。这个是谁打开的，必须要清楚一下。
 * 要不然到时候会串台，比如说我在 A 这个地方打开了一个截图，但是在其他地方看到这个
 * 截图，却不知道是谁打开的，就容易错乱。」
 *
 * 取值域只有三态（刻意写成可解析字符串而不是布尔组合，便于上报/落日志）：
 * - `user`               —— 用户亲手点开的（文件 pill / 小V / 浏览器 / 终端 / 工作区…）
 * - `agent:<agent_code>` —— 某个智能体（岗位）通过 platform ui.show 等工具打开的
 * - `session:<sessionKey>` —— 由某条会话产生、但拿不到具体智能体（自动开栏 / SSE 无 actor）
 *
 * 与 `sessionKey` 的区别必须分清：`sessionKey` 决定**谁能看见**（可见性过滤），
 * `openedBy` 只决定**标签上写谁的名字**（溯源）。两者不可互相替代——同一条会话里
 * 既可能是用户亲手开的，也可能是该会话里的智能体开的。
 */
export type RightStageOpenedBy = 'user' | `agent:${string}` | `session:${string}`

export type RightStageOpenedByKind = 'user' | 'agent' | 'session'

export type RightStageOpenedByInfo = {
  kind: RightStageOpenedByKind
  /** 智能体/会话的原始标识（用户态为空串）。 */
  code: string
  raw: string
}

/** 把任意来源的字符串归一成合法 `RightStageOpenedBy`；不合法一律返回空串（调用方据此走兜底）。 */
export function normalizeOpenedBy(raw: unknown): RightStageOpenedBy | '' {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s === 'user') return 'user'
  if (s.startsWith('agent:') && s.slice(6).trim()) return `agent:${s.slice(6).trim()}`
  if (s.startsWith('session:') && s.slice(8).trim()) return `session:${s.slice(8).trim()}`
  return ''
}

/** 拆解取值域；未知/空返回 null（UI 不显示归属文本，而不是猜一个）。 */
export function parseOpenedBy(raw: unknown): RightStageOpenedByInfo | null {
  const norm = normalizeOpenedBy(raw)
  if (!norm) return null
  if (norm === 'user') return { kind: 'user', code: '', raw: norm }
  if (norm.startsWith('agent:')) {
    return { kind: 'agent', code: norm.slice(6), raw: norm }
  }
  return { kind: 'session', code: norm.slice(8), raw: norm }
}

/**
 * 给用户看的一行归属文案（标签 tooltip / 总览行尾用）。
 *
 * `agentLabels` 是 agent_code → 岗位中文名的映射（可选）：有中文名就用中文名，
 * 否则退回 code —— 绝不显示 `agent:e8f1…` 这种裸 UUID 才算合格。
 * 会话键通常很长（`proactive:self-evolution-bot:chat:2026-...`），这里做长度裁剪，
 * 但**保留可辨识的头尾**，避免截成两个会话都一样的字符串。
 */
export function describeOpenedBy(
  raw: unknown,
  agentLabels?: Record<string, string> | null,
): string {
  const info = parseOpenedBy(raw)
  if (!info) return ''
  if (info.kind === 'user') return '用户'
  if (info.kind === 'agent') {
    const label = String((agentLabels && agentLabels[info.code]) || '').trim()
    return `智能体：${label || info.code}`
  }
  return `会话：${shortenSessionKey(info.code)}`
}

/** 会话键裁剪：≤28 字原样；否则取头 18 + '…' + 尾 7，保证两个不同会话不会裁成同一串。 */
export function shortenSessionKey(key: string, head = 18, tail = 7): string {
  const s = String(key || '').trim()
  if (!s) return ''
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

export type RightStageSurface = {
  id: string
  kind: RightStageKind
  title?: string
  layout?: RightStageLayout
  data: Record<string, unknown>
  /** 归属会话；有值时 UI 按当前 sessionKey 过滤可见标签。 */
  sessionKey?: string
  /**
   * 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
   * 改了什么：新增「谁打开的」溯源字段（创建时定死，后续 update 不覆盖）。
   * 为什么：用户 2026-11-23 明确要求标签上要能看出「这是谁打开的」，
   *   否则同一条信息在别处也出现时无法判断来路，容易串台。
   * 判据：三态取值域见 `RightStageOpenedBy`；缺省由 store.show 兜底成 `session:<当前会话>`。
   */
  openedBy?: RightStageOpenedBy
  /**
   * 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
   * 改了什么：新增 expand 标记，从 platform `ui.show(expand=true)` 一路透传到 store.show。
   * 为什么：用户收起右栏后，ui.show 只写标签不撑开，工具回 ok 但用户屏幕无变化
   * （第91轮实测 shellExists=false）。expand=true 表示「调用方明确要用户看见」，
   * 等价于用户亲手点开：清掉收起锁并撑开。缺省 undefined = 沿用「不抢视线」。
   */
  expand?: boolean
}

export type RightStageStreamChunk = {
  streamId: string
  text: string
  newline?: boolean
  level?: 'info' | 'success' | 'warning' | 'error' | 'muted'
}

export type RightStageStreamSession = {
  streamId: string
  format: 'plain' | 'markdown' | 'code'
  path?: string
  title?: string
  chunks: RightStageStreamChunk[]
  closed?: boolean
}

export const RIGHT_STAGE_KIND_LABELS: Record<string, string> = {
  'workspace-browse': '工作区文件',
  write: '写入内容',
  file: '文件预览',
  asset: '资产',
  codeViewer: '代码对比',
  subagentTranscript: '子代理输出',
  collabSubtaskTranscript: '节点进度',
  v4Session: '子会话',
  employeeProcess: '执行过程',
  sessionRuntime: '运行中',
  summary: '摘要',
  terminal: '终端',
  'interactive-terminal': '终端',
  artifacts: '本轮产物',
  'mind-map': '思维导图',
  'collab-workflow': '工作流',
  'platform-feedback': '平台操作',
  'news-dashboard': '资讯',
  'web-embed': '网页',
  browser: '浏览器',
  screenshot: '截图',
  xiaomi: '小V',
  'shell-page': '页面',
}

/** Normalize panel kind aliases (legacy workspace-write / write-stream). */
export function normalizeRightStageKind(kind: string | null | undefined): string {
  const k = String(kind || '').trim()
  if (!k) return ''
  switch (k) {
    case 'write-stream':
    case 'write_stream':
    case 'workspace-write':
    case 'workspace_write':
      return 'write'
    case 'workflow':
    case 'collab_workflow':
      return 'collab-workflow'
    case 'collab-subtask':
    case 'collab_subtask':
    case 'subtask-transcript':
    case 'subtask_transcript':
      return 'collabSubtaskTranscript'
    case 'employee-process':
    case 'employee_process':
    case 'employee':
    case 'employee-progress':
      return 'employeeProcess'
    case 'session-runtime':
    case 'session_runtime':
    case 'child-works':
    case 'child_works':
      return 'sessionRuntime'
    case 'shell_page':
    case 'shellPage':
    case 'shellpage':
      return 'shell-page'
    default:
      return k
  }
}

export function defaultTitleForKind(kind: string): string {
  const k = normalizeRightStageKind(kind)
  return RIGHT_STAGE_KIND_LABELS[k] || k || 'Panel'
}

export function defaultLayoutForKind(kind: string): RightStageLayout {
  switch (normalizeRightStageKind(kind)) {
    case 'workspace-browse':
    case 'summary':
      return 'narrow'
    case 'platform-feedback':
      return 'narrow'
    case 'xiaomi':
      return 'narrow'
    case 'terminal':
    case 'interactive-terminal':
      return 'half'
    case 'write':
    case 'artifacts':
      return 'workspace-write'
    case 'browser':
    case 'news-dashboard':
    case 'web-embed':
      return 'wide'
    case 'screenshot':
      return 'half'
    case 'shell-page':
    case 'employeeProcess':
    case 'collab-workflow':
    case 'collabSubtaskTranscript':
      return 'wide'
    // 文件 / 资产 / 代码预览默认半宽：侧栏可读，不把主对话挤成窄条
    case 'file':
    case 'asset':
    case 'codeViewer':
      return 'half'
    default:
      return 'half'
  }
}
