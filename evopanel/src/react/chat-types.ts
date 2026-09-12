/** 会话列表项（与 Gateway / tauri-api 返回对齐） */
export interface ChatSessionRow {
  sessionKey: string
  threadId?: string | null
  title?: string
  messageCount?: number
  /** 与旧版 chat.js 对齐的排序/展示字段（可能由 backend 返回） */
  updatedAt?: number
  lastActivity?: number
  createdAt?: number
  /** 旧版兼容字段名 */
  messages?: number
  /** 当前激活场景（空 = 默认日常对话 chat） */
  activatedScenarios?: string[]
  /** Gateway 扁平字段（会话 context 恢复） */
  modelName?: string | null
  sessionMode?: string | null
  memoryEnabled?: boolean | null
  context?: Record<string, unknown>
  /** 来自 evoflow_chat_sessions.run_status：done | cancelled | fail | running | pending 等 */
  runStatus?: string
  currentRunId?: string | null
  /** 当前轮次开始（ISO8601，evoflow_chat_sessions.current_turn_started_at） */
  currentTurnStartedAt?: string | null
  /** 当前轮次结束（ISO8601，evoflow_chat_sessions.current_turn_ended_at） */
  currentTurnEndedAt?: string | null
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheMissTokens?: number
  /** 侧栏置顶 */
  isPinned?: boolean
  /** 置顶区内排序（越小越靠前） */
  pinOrder?: number
  /** 会话绑定的工作目录（Gateway 扁平字段） */
  localWorkspaceRoot?: string | null
  /** 是否使用虚拟路径沙箱 */
  useVirtualPaths?: boolean | null
  /** 当前会话角色（同会话切角色后写入；sessionKey 可能仍是 agent:main:…） */
  agentId?: string | null
}

/** 与工具、思考交错展示（刷新历史与流式一致） */
export type ContentBlockKind = 'plan_text' | 'reasoning' | 'tools' | 'body_text'

export type MessageSegment =
  | { id?: string; seq?: number; blockKind?: ContentBlockKind; kind: 'text'; text: string }
  | { id?: string; seq?: number; blockKind?: ContentBlockKind; kind: 'tools'; ids: string[] }
  | { id?: string; seq?: number; blockKind?: ContentBlockKind; kind: 'reasoning'; text: string }

/** 消息区一行（含流式伪行 _stream） */
export interface DisplayRow {
  role: 'user' | 'assistant' | 'system' | '_stream'
  text?: string
  /** 模型推理/思考内容（用于在 AI 回复气泡内展示，可选；多轮时由 reasoningSegments 拼接） */
  reasoningPreview?: string | null
  /** 同一轮回复内多段思考（工具调用间多次 reasoning 时分开展示） */
  reasoningSegments?: string[]
  /** 存在时优先按此顺序渲染正文与工具，避免「全文在上、工具全在下」 */
  segments?: MessageSegment[]
  /** 流式正文阶段：工具出现前 plan / 工具后最终回复 */
  streamTextPhase?: 'pre_tools' | 'post_tools'
  /** 系统阶段提示（模型装配 / 工具执行），替代泛化的「正在思考…」 */
  systemActivity?: string | null
  tools?: unknown[]
  images?: unknown[]
  videos?: unknown[]
  audios?: unknown[]
  files?: unknown[]
  /** 助手 / _stream：展示子智能体并行进度（流式与落库快照） */
  subagentTasks?: Record<string, SubagentStreamTask>
  /** 助手 / _stream：terminal 工具实时输出（按 tool_call_id） */
  terminalStreams?: Record<string, TerminalStreamTask>
  timestamp?: number
  durationStr?: string
  tokenStr?: string
  /** 本轮 LangGraph run（与后端 run_id 对齐，用于轮次隔离与 plan 侧读历史） */
  runId?: string
  /** 落库 message id 或发送前客户端生成的稳定 id（列表 key / 去重） */
  messageId?: string
  /** 用户手动指定的技能（仅 user 行；展示为气泡内 pill，不拼接进正文） */
  preferredSkill?: { name: string; label: string; icon?: string }
  /** 多选技能（向后兼容：发送时优先读 preferredSkills；展示兼容旧 preferredSkill） */
  preferredSkills?: Array<{ name: string; label: string; icon?: string }>
  /** @ 附加的工作区文件（发送时注入 Agent 上下文；展示为气泡内 pill） */
  contextFiles?: Array<{ path: string; name: string }>
  /** 用户停止后保留的同一轮 partial assistant；仅此类行可与 _stream 合并展示 */
  incompleteStream?: boolean
  /**
   * Legacy: mid-turn inject shown as chat bubble with badge.
   * runtime-aligned path keeps steers in composer ``pendingSteers`` until
   * ``pending_inject_consumed`` promotes them to a normal user row.
   */
  pendingInject?: boolean
  /** _stream：tail 去重只用当前 turn 时间线，勿把 compacted 正文误当前缀剥掉 */
  streamTailDedupeSegments?: MessageSegment[]
  /** AG-UI canonical turn (stream_format=agui) */
  aguiTurn?: import('./lib/agui-turn-reducer.js').AgUiTurnState | null
}

/** 流式内存释放后仍要在同一气泡内展示的封存段（不写 rows，避免割裂） */
export type CompactedStreamPart = {
  segments?: MessageSegment[]
  text: string
  tools: unknown[]
  reasoningSegments: string[]
  reasoningPreview: string | null
  images: unknown[]
  videos: unknown[]
  audios: unknown[]
  files: unknown[]
}

export interface TokenTotals {
  input: number
  output: number
  total: number
  cacheRead?: number
  cacheCreation?: number
  cacheMiss?: number
}

/** LangGraph custom 通道中 task_tool 的 task_* 事件在前端的聚合态（按 task_id，支持并行多子任务） */
export interface SubagentStreamTask {
  taskId: string
  /**
   * Background / tool_call id for GET /api/tasks/subagent/{id}/transcript.
   * Differs from taskId when collab remaps the stream map key to collab_subtask_id.
   */
  taskExecId?: string
  /** 与协作子任务卡片关联（来自 subtask 流事件的 collab_subtask_id） */
  collabSubtaskId?: string
  /** 后端 task_started / task_running 中的 subagent_type（内置或 agents 目录自定义名） */
  subagentType?: string
  description?: string
  phase: 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'
  /** 子智能体内部工具轨迹（复用主聊天 ToolCallList UI） */
  tools?: unknown[]
  /** 最近一条 task_running 的短摘要（兼容旧 UI） */
  progressHint?: string
  /** 多轮 task_running 拼接的实时正文（较长，供独立 dock 展示） */
  liveOutput?: string
  messageIndex?: number
  totalMessages?: number
  error?: string
  startedAt?: number
}

/** LangGraph custom 通道中 terminal_* 事件在前端的聚合态（按 tool_call_id） */
export interface TerminalStreamChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface TerminalStreamTask {
  toolCallId: string
  /** 唯一调用 ID（同一轮多终端调用时区分不同工具实例） */
  invocationId?: string
  command?: string
  phase: 'running' | 'success' | 'failed'
  stdout?: string
  stderr?: string
  chunks?: TerminalStreamChunk[]
  exitCode?: number
  success?: boolean
  startedAt?: number
  endedAt?: number
}

/** 切换会话时保留的流式 UI 快照（后台 run 继续时可恢复） */
export type SessionLiveSnapshot = {
  stream: StreamState
  rows: DisplayRow[]
  isSending: boolean
  seenRunIds: string[]
  activeChatRunId: string | null
}

export interface StreamState {
  runId: string | null
  /** 当前轮流式时间线（事件归约后的唯一真相源） */
  turn: import('./lib/stream-turn-engine.js').StreamTurnState
  /** AG-UI canonical turn state (when stream_format=agui) */
  aguiTurn?: import('./lib/agui-turn-reducer.js').AgUiTurnState | null
  /** 已释放 turn 缓冲、仍与当前段合并展示的封存段 */
  compactedParts?: CompactedStreamPart[]
  startTs: number | null
  /** 当前轮流式：子智能体 task_started / task_running / … 聚合（与 tool_call_id 对齐的 task_id） */
  subagentTasks: Record<string, SubagentStreamTask>
  /** 当前轮流式：terminal_start / stdout / stderr / exit 聚合（与 tool_call_id 对齐） */
  terminalStreams: Record<string, TerminalStreamTask>
}

export interface ChatWsPayload {
  sessionKey?: string
  state?: string
  runId?: string
  message?: unknown
  /** state === 'tool' 时由 ws-client 附带（如 tool_call / tool 结果） */
  data?: unknown
  /** state === 'agui_event' 时：AG-UI BaseEvent JSON */
  aguiEvent?: Record<string, unknown>
  streamFormat?: 'agui' | 'openai'
  /** evf delta：post_tools 表示工具后的最终回复流 */
  streamContentPhase?: 'pre_tools' | 'post_tools' | null
  /** delta 正文语义：piece=本帧增量；缺省或 cumulative=兼容旧版累积全文 */
  streamTextMode?: 'piece' | 'cumulative'
  /** Gateway evf delta 对应的 LangGraph assistant message id */
  messageId?: string
  event?: string
  /** state === 'subtask' 时：单条 task_* 事件（与 ws-client custom 解析一致） */
  subtaskEvent?: Record<string, unknown>
  /** state === 'terminal' 时：单条 terminal_* 事件 */
  terminalEvent?: Record<string, unknown>
  /** state === 'worker_file' 时：单文件 worker 完成片段 */
  parentToolCallId?: string
  workerFileEntry?: Record<string, unknown>
  durationMs?: number
  errorMessage?: string
  error?: { message?: string }
  /** terminal 工具调用 ID */
  toolCallId?: string
  /** terminal 写入进度 */
  writeProgress?: unknown
  /** 通用状态字段 */
  status?: string
}

export interface ChatAttachment {
  mimeType: string
  /** Original filename (required for document upload → thread uploads/). */
  filename?: string
  /** Base64 payload for vision image blocks. Documents prefer ``file`` instead. */
  content?: string
  /** Raw File for POST /api/threads/{id}/uploads (docs / non-images). */
  file?: File
}

export interface ThreadTodo {
  content?: unknown
  status?: string
  /** 完成后的结果摘要（主对话 write_todos） */
  result?: string
  /** 关联协作子任务（用于 hover 精准找子智能体输出） */
  collabSubtaskId?: string
}

export interface WorkChecklistItem {
  id?: string
  content?: string
  status?: string
  result?: string
  updated_at?: string
}

export interface ThreadClarification {
  toolCallId?: string
  preview?: string
  content?: string
}

/** propose_goal 工具解析后的目标方案 */
export interface ThreadGoalProposal {
  toolCallId?: string
  goal: string
  feishuPushOnComplete?: boolean
  pushChannel?: string
  pushTargetId?: string
  stepDelayMs?: number
  retryLimit?: number
  useEvolutionSkill?: boolean
}

/** @deprecated 使用 ThreadGoalProposal */
export type ThreadHostedProposal = ThreadGoalProposal

/** 聊天侧栏展示的协作任务（supervisor create_task 等工具产出） */
export interface CollabTaskSnapshot {
  taskId: string
  name?: string
  status?: string
  progress?: number
  updatedAt?: number
  executionAuthorized?: boolean
  lifecycleStage?: string
  lifecycleLabel?: string
  boundPlanPreview?: string
  boundPlanReady?: boolean
  planGoal?: string
}

/** 子智能体/Agent 信息（来自 /tasks runtime.agents） */
export interface AgentInfo {
  agent_code?: string
  agentCode?: string
  agent_name?: string
  agentName?: string
  name?: string
  [key: string]: unknown
}

/** 按 taskId 聚合的子智能体流式任务映射 */
export type SubagentStreamTaskMap = Record<string, SubagentStreamTask>

/** supervisor create_subtask 等在侧栏子任务卡片中展示 */
export interface CollabSubtaskSnapshot {
  [key: string]: unknown
  subtaskId: string
  parentTaskId?: string
  /** Plan step ref (e.g. "1", "2") for ordering in exec confirm UI */
  ref?: string
  dependsOn?: string[]
  name?: string
  description?: string
  status?: string
  progress?: number
  assignedAgent?: string
  /** supervisor 工具返回的展示名（agent_name），优先于 assignedAgent 解析 */
  assignedAgentDisplay?: string
  /** 后端监控落库：子任务记忆摘要（可用于 tooltip） */
  outputSummary?: string
  /** 任务存储中的执行结果全文（刷新后无流式快照时弹窗以此兜底） */
  result?: string | null
  /** subtask_outcome_report / 工具落库的任务汇报 */
  taskReport?: string | null
  /** 后端监控落库：子任务最近工具调用（含输入输出） */
  observedToolCalls?: unknown[]
  /** 子任务 worker 通过 subtask_work_checklist 工具维护的执行步骤 */
  workChecklist?: WorkChecklistItem[]
}

/** 子任务对话弹窗/抽屉载荷（主聊天侧栏、工作流页、RunManager 共用） */
export interface SubtaskTranscriptModalPayload {
  subtaskId: string
  mainTaskId?: string
  /** LangGraph lead thread uuid — scopes subtask history via `{lead}__sub__{subtaskId}` */
  leadThreadId?: string
  title: string
  status: string
  progress?: number | null
  initialText?: string
  rows?: unknown[]
  /** 会话拉取成功且 messages 为空：勿用 result/卡片预览冒充会话正文 */
  emptyConversation?: boolean
  /** 官方终态汇报（subtask_outcome_report），非 task memory / 会话摘要 */
  outcome?: {
    reported?: boolean
    status?: string
    task_report?: string
    summary?: string
    outcome_reported_at?: string | null
    evidence_paths?: string[]
    outputs?: Array<{
      type?: string
      key?: string
      value?: string
      label?: string
    }>
  }
}

/** 流式 supervisor 每一步（有输出则 done，用于动态时间线） */
export interface SupervisorStepSnapshot {
  id: string
  action: string
  label: string
  done: boolean
}

export interface ThreadPanelState {
  title: string | null
  todos: ThreadTodo[]
  activityKind: string
  activityDetail: string
  reasoningPreview: string | null
  clarification: ThreadClarification | null
  /** propose_goal：待用户在输入区上方确认的目标方案 */
  goalProposal: ThreadGoalProposal | null
  /** 子智能体 · 并行输出（仅用于 TODO hover 预览，不在主消息区渲染） */
  subagentTasks?: Record<string, SubagentStreamTask>
  /** 与当前会话关联的 EvoFlow 主任务（用于侧栏展示，不依赖 plan todos） */
  collabTask: CollabTaskSnapshot | null
  /** supervisor 创建的子任务卡片（流式累积） */
  collabSubtasks: CollabSubtaskSnapshot[]
  /** supervisor 调用时间线 */
  supervisorSteps: SupervisorStepSnapshot[]
  /** GET /api/collab/threads/:id / task-progress 快照中的协作阶段 */
  collabPhase?: string | null
  boundTaskId?: string | null
  /** plan 工具 output.plan（流式过程中 planExecToolArrays 为空时的回退） */
  planInputFallback?: Record<string, unknown> | null
  /** plan 工具 output */
  planOutput?: unknown
  /** 协作任务行 */
  taskRow?: Record<string, unknown> | null
}
