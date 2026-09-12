/**
 * 调试数据里常见英文字段值旁的中文释义（仅展示中文，不并列英文）。
 * 未收录的值不展示释义条。
 */

/** 仅输出中文释义 HTML（内部仍保留 en 字段供以后做 title 等扩展） */
function glossZhOnly(g) {
  return `<span class="agent-trace-value-gloss" lang="zh-CN">${e(g.zh)}</span>`
}

function e(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 协作周期 collab_cycle_trace.event（含 Plan 守卫、场景、监督器写入等扩展事件） */
const COLLAB_EVENTS = {
  before_model: { zh: '调用模型前快照', en: 'Snapshot before the LLM call' },
  model_request: { zh: '发往模型的请求（工具列表等）', en: 'Outbound model request (tools, etc.)' },
  model_response: { zh: '模型返回（工具调用/文本预览）', en: 'Model response (tool calls / text preview)' },
  after_model: { zh: '模型输出写入消息后', en: 'After model output is merged into messages' },
  tool_start: { zh: '工具执行开始', en: 'Tool invocation started' },
  tool_end: { zh: '工具执行结束', en: 'Tool invocation finished' },
  auto_enter_planning_from_scenario_tool: {
    zh: 'scenario 工具激活 plan 且线程仍为空闲时，自动把协作阶段写入「规划中」（不经模型调用）',
    en: 'After scenario(plan): auto-enter collab planning when thread was idle',
  },
  auto_enter_planning_for_plan: {
    zh: '编排侧检测到已激活 plan 且线程空闲时，自动进入协作「规划中」',
    en: 'On agent start: auto-enter planning when plan scenario active and thread idle',
  },
  supervisor_root_task_bound_plan: {
    zh: '监督器本会话中主任务已绑定计划（bound plan）',
    en: 'Supervisor bound root task plan to collab state',
  },
  plan_guard_auto_advance_to_awaiting_exec: {
    zh: '用户确认执行意图后，Plan 守卫把协作阶段切到「等待执行」',
    en: 'User confirmed execution → advance to awaiting_exec',
  },
  supervisor_gated_until_plan: {
    zh: '协作空闲且未激活 plan：从本轮模型请求工具列表移除 supervisor/todo',
    en: 'Idle without plan: supervisor/todo removed from request tools',
  },
  plan_guard_idle_strip_supervisor_tool_calls: {
    zh: 'after_model：空闲且无 plan 时从 AI 消息中剥离 supervisor/todo 调用',
    en: 'Strip supervisor/todo tool_calls when idle without plan',
  },
  plan_guard_idle_strip_side_effect_without_file: {
    zh: '空闲且未激活 file 场景：剥离写盘/命令类 tool_calls',
    en: 'Strip side-effect tools without file scenario',
  },
  plan_guard_filtered_request_tools: {
    zh: '按协作阶段过滤本轮模型请求携带的工具列表',
    en: 'Filtered model request tools by phase',
  },
  plan_guard_virtual_phase_idle_to_plan_ready: {
    zh: '有效阶段视为「规划就绪」：已有 plan 但磁盘协作仍为 idle 时的虚阶段对齐',
    en: 'Virtual phase plan_ready when plan exists but disk idle',
  },
  plan_guard_need_plan_before_supervisor_inject: {
    zh: '规划阶段若只有 supervisor 调用，注入「需先提交计划」类占位调用',
    en: 'Inject need-plan placeholder when only supervisor in planning',
  },
  plan_guard_planning_order: {
    zh: '规划/规划就绪：按策略剥离越权澄清、supervisor 或规范执行确认',
    en: 'Planning phase tool_calls normalization',
  },
  plan_guard_enforce_execution_confirm_ask: {
    zh: '等待执行等阶段：强制改为结构化「执行确认」澄清（避免未确认就建任务/启动）',
    en: 'Inject structured execution confirmation ask',
  },
  plan_guard_auto_inject_create_task_with_subtasks: {
    zh: '守卫自动注入 create_task_with_subtasks（带用户提示长度）',
    en: 'Auto-injected create_task_with_subtasks',
  },
  plan_guard_auto_inject_start_execution: {
    zh: '守卫自动注入 start_execution（已绑定主任务）',
    en: 'Auto-injected start_execution',
  },
  plan_guard_cleared_tool_calls_persist: {
    zh: '守卫清空 tool_calls 并写回，避免 ToolNode 仍执行旧调用',
    en: 'Persist cleared tool_calls',
  },
  plan_guard_filtered_tools: {
    zh: '按协作阶段过滤了本轮 AI 工具调用（部分被拦截）',
    en: 'Filtered AI tool_calls by phase',
  },
  plan_guard_injected_plan_fallback: {
    zh: '模型无文本且工具调用全被拦截：注入计划相关兜底文案',
    en: 'Injected plan fallback content',
  },
}

/**
 * collab_cycle.event → 时间轴圆点旁短标签（易扫读；长句释义仅在展开区 gloss，不用作标题）。
 */
const COLLAB_GRAPH_STAGE = {
  before_model: '模型调用前',
  /** 协作图内快照：尚未真正发 HTTP */
  model_request: '协作·待发请求',
  model_response: '模型返回',
  after_model: '写回消息',
  tool_start: '工具执行开始',
  tool_end: '工具执行结束',
  auto_enter_planning_from_scenario_tool: '场景·进规划',
  auto_enter_planning_for_plan: '编排·进规划',
  supervisor_root_task_bound_plan: '监督·绑计划',
  plan_guard_auto_advance_to_awaiting_exec: '守卫·进等待执行',
  supervisor_gated_until_plan: '守卫·空闲剥监督',
  plan_guard_idle_strip_supervisor_tool_calls: '守卫·剥监督调用',
  plan_guard_idle_strip_side_effect_without_file: '守卫·剥副作用工具',
  plan_guard_filtered_request_tools: '守卫·按阶段筛工具',
  plan_guard_virtual_phase_idle_to_plan_ready: '守卫·虚阶段对齐',
  plan_guard_need_plan_before_supervisor_inject: '守卫·需先计划',
  plan_guard_planning_order: '守卫·规划序整理',
  plan_guard_enforce_execution_confirm_ask: '守卫·执行确认澄清',
  plan_guard_auto_inject_create_task_with_subtasks: '守卫·注入建任务',
  plan_guard_auto_inject_start_execution: '守卫·注入开始执行',
  plan_guard_cleared_tool_calls_persist: '守卫·清空 tool_calls',
  plan_guard_filtered_tools: '守卫·筛 AI 调用',
  plan_guard_injected_plan_fallback: '守卫·计划兜底',
}

/** @param {unknown} event collab_cycle 的 event */
export function collabGraphStageLabelZh(event) {
  const k = String(event ?? '').trim().toLowerCase()
  const hit = COLLAB_GRAPH_STAGE[k]
  if (hit) return hit
  const raw = String(event ?? '').trim()
  if (!raw) return '协作事件'
  const compact = raw.replace(/_/g, '·')
  return compact.length > 22 ? `${compact.slice(0, 21)}…` : compact
}

/** @param {unknown} event lead_agent_round.event */
export function roundEventLabelZh(event) {
  const g = lookup(ROUND_EVENTS, event)
  return g ? g.zh : String(event ?? '').trim().slice(0, 22)
}

/** @param {unknown} stage model_request_payload.stage */
export function modelStageLabelZh(stage) {
  const g = lookup(MODEL_STAGES, stage)
  return g ? g.zh : String(stage ?? '').trim().slice(0, 24)
}

/** model_request_payload.stage */
const MODEL_STAGES = {
  final_payload: { zh: '最终下发给厂商的请求体', en: 'Final payload sent to the vendor API' },
}

/** tool_call_io.status（常见小写） */
const TOOL_STATUS = {
  success: { zh: '成功', en: 'Success' },
  error: { zh: '错误', en: 'Error' },
  ok: { zh: '正常', en: 'OK' },
  pending: { zh: '等待中', en: 'Pending' },
  running: { zh: '执行中', en: 'Running' },
}

/** lead_agent_round_trace.event */
const ROUND_EVENTS = {
  turn_snapshot: { zh: '用户轮次快照', en: 'User-turn snapshot' },
  model_call_tools: { zh: '本轮模型请求携带的工具', en: 'Tools attached to this model call' },
}

function lookup(map, key) {
  const k = String(key ?? '').trim().toLowerCase()
  if (!k) return null
  return map[k] || map[String(key ?? '').trim()] || null
}

/**
 * @returns {string} 安全 HTML：释义块；无收录则空串
 */
export function glossCollabEventHtml(event) {
  const g = lookup(COLLAB_EVENTS, event)
  if (!g) return ''
  return `<span data-gloss-kind="collab.event">${glossZhOnly(g)}</span>`
}

export function glossModelStageHtml(stage) {
  const g = lookup(MODEL_STAGES, stage)
  if (!g) return ''
  return `<span data-gloss-kind="model.stage">${glossZhOnly(g)}</span>`
}

export function glossToolStatusHtml(status) {
  const g = lookup(TOOL_STATUS, status)
  if (!g) return ''
  return `<span data-gloss-kind="tool.status">${glossZhOnly(g)}</span>`
}

export function glossRoundEventHtml(event) {
  const g = lookup(ROUND_EVENTS, event)
  if (!g) return ''
  return `<span data-gloss-kind="round.event">${glossZhOnly(g)}</span>`
}

/** 子任务/主任务行上的 status（与 collab.models.TaskStatus + 运行态 timed_out 等对齐） */
const LIFECYCLE_STATUS = {
  pending: { zh: '待开始', en: 'Pending' },
  planning: { zh: '规划中', en: 'Planning' },
  planned: { zh: '已规划', en: 'Planned' },
  executing: { zh: '执行中', en: 'Executing' },
  paused: { zh: '已暂停', en: 'Paused' },
  in_progress: { zh: '进行中', en: 'In progress' },
  completed: { zh: '已完成', en: 'Completed' },
  failed: { zh: '失败', en: 'Failed' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  timed_out: { zh: '已超时', en: 'Timed out' },
  blocked: { zh: '阻塞', en: 'Blocked' },
}

/**
 * task_lifecycle_trace.log 的 event（write_task_lifecycle_trace 写入处汇总）。
 * 与 schema `evoflow.task_lifecycle.v1` 的字符串取值一致。
 */
const LIFECYCLE_EVENTS = {
  main_task_created: { zh: '主任务已创建', en: 'Main task created' },
  main_task_and_subtasks_created: { zh: '主任务与子任务已创建', en: 'Main + subtasks created' },
  subtasks_batch_created: { zh: '子任务批量创建', en: 'Subtasks batch created' },
  subtask_created: { zh: '子任务已创建', en: 'Subtask created' },
  supervisor_complete_subtask: { zh: '监督器标记子任务完成', en: 'Supervisor completed subtask' },
  start_execution_dispatch: { zh: '开始执行调度', en: 'Start execution dispatch' },
  supervisor_post_delegate_convergence: { zh: '委派后状态收敛', en: 'Post-delegate convergence' },
  subtask_status_changed: { zh: '子任务状态变更', en: 'Subtask status changed' },
  main_task_roll_up: { zh: '主任务进度汇总', en: 'Main task roll-up' },
  subtask_requeued_after_timeout: { zh: '超时后子任务重新入队', en: 'Subtask requeued after timeout' },
  task_tool_collab_detached: { zh: '任务工具后台分离执行', en: 'Task tool collab detached' },
}

/** 线程协作状态机 CollabPhase（collab.models / collab_cycle_trace.collab_phase） */
const COLLAB_PHASE = {
  idle: { zh: '空闲', en: 'Idle' },
  req_confirm: { zh: '请求确认', en: 'Request confirmation' },
  planning: { zh: '规划中', en: 'Planning' },
  plan_ready: { zh: '规划就绪', en: 'Plan ready' },
  awaiting_exec: { zh: '等待执行', en: 'Awaiting execution' },
  executing: { zh: '执行中', en: 'Executing' },
  paused: { zh: '已暂停', en: 'Paused' },
  done: { zh: '已结束', en: 'Done' },
}

export function glossLifecycleStatusHtml(status) {
  const g = lookup(LIFECYCLE_STATUS, status)
  if (!g) return ''
  return `<span data-gloss-kind="lifecycle.status">${glossZhOnly(g)}</span>`
}

export function glossLifecycleEventHtml(event) {
  const g = lookup(LIFECYCLE_EVENTS, event)
  if (!g) return ''
  return `<span data-gloss-kind="lifecycle.event">${glossZhOnly(g)}</span>`
}

/** @param {unknown} phase collab_phase 原始值 */
export function collabPhaseLabelZh(phase) {
  const g = lookup(COLLAB_PHASE, phase)
  return g ? g.zh : String(phase ?? '').trim()
}

/** @param {unknown} event task_lifecycle event */
export function lifecycleEventLabelZh(event) {
  const g = lookup(LIFECYCLE_EVENTS, event)
  return g ? g.zh : String(event ?? '').trim()
}

/** @param {unknown} status 子任务/主任务 status */
export function lifecycleStatusLabelZh(status) {
  const g = lookup(LIFECYCLE_STATUS, status)
  return g ? g.zh : String(status ?? '').trim()
}

