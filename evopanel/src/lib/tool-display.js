import { getAgentsDisplayCache } from './agents-display-cache.js'
import {
  formatSubtaskOutcomeReportTitle,
  formatSubtaskWorkChecklistTitle,
} from './collab-tool-display.js'
import { looksLikePlanToolArgs } from './plan-tool-shape.js'

/** 终端/命令类工具行内摘要字符上限（ToolCallList 主路径交给 CSS ellipsis，此处供标题/兜底文案） */
export const SHELL_CMD_BRIEF_MAX = 200

export function truncateShellCommandBrief(cmd, max = SHELL_CMD_BRIEF_MAX) {
  const s = String(cmd || '').trim()
  if (!s || s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/** process(action=...) 与中文说明 */
export const PROCESS_ACTION_ZH = {
  start: '启动进程',
  log: '进程日志',
  wait: '等待进程',
  kill: '终止进程',
}

export function processActionZh(action) {
  if (action == null || action === '') return ''
  return String(action).trim().toLowerCase()
}

/** browser(action=...) */
export const BROWSER_ACTION_ZH = {
  open: '打开网页',
  snapshot: '页面快照',
  click: '点击元素',
  fill: '填写输入',
  press: '按键',
  scroll: '滚动页面',
  screenshot: '页面截图',
  back: '后退',
  close: '关闭浏览器',
}

export function browserActionZh(action) {
  if (action == null || action === '') return ''
  return String(action).trim().toLowerCase()
}

/** supervisor(action=...) 与中文说明 */
export const SUPERVISOR_ACTION_ZH = {
  create_task: '创建任务',
  create_task_with_subtasks: '创建任务与子任务',
  create_subtask: '创建子任务',
  create_subtasks: '批量创建子任务',
  assign_subtask: '分配子任务',
  update_progress: '更新进度',
  complete_subtask: '完成子任务',
  start_execution: '开始执行',
  set_task_planned: '标记计划就绪',
  get_status: '查询状态',
  steer_subtask: '纠偏子任务',
  interrupt_subtask: '中断子任务',
  get_subtask_conversation: '读取子任务对话',
  get_task_memory: '读取子任务对话',
  monitor_execution_step: '监控执行进度',
  monitor_execution: '监控执行',
  list_subtasks: '列出子任务',
  create_agent: '创建 Agent',
  update_agent: '更新 Agent',
  continue_subtask_session: '继续子任务会话',
}

/** 内置工具名 → 简短中文（作分类标题） */
export const TOOL_NAME_ZH = {
  bash: '终端命令',
  execute_command: '执行命令',
  terminal: '终端',
  ls: '列出目录',
  list_dir: '列出目录',
  read_file: '读取文件',
  read: '读取文件',
  write_file: '写入文件',
  write_to_file: '写入文件',
  write: '写入文件',
  str_replace: '编辑文件',
  replace_in_file: '编辑文件',
  replace: '编辑文件',
  delete_file: '删除文件',
  delete: '删除文件',
  search_content: '搜索内容',
  search_code_index: '工作区搜索',
  rg: '内容搜索',
  grep: '内容搜索',
  find_file: '查找文件',
  find: '查找文件',
  read_files: '批量读取',
  web_search: '网络搜索',
  web_fetch: '网页抓取',
  fetch_url: '网页抓取',
  image_search: '图片搜索',
  media_image_generate: '生成图片',
  media_video_generate: 'AI 生视频',
  media_task_wait: '媒体任务轮询',
  media_voiceover_synthesize: '配音合成',
  media_subtitle_build: '生成字幕',
  media_subtitle_burn: '字幕烧录',
  media_subtitle_extract: '字幕提取',
  supervisor: '任务调度',
  plan: '提交计划',
  subagent: '子智能体',
  task: '子智能体',
  ask_clarification: '等待确认',
  write_todos: '会话 checklist',
  todo: '会话 checklist',
  worker: '并行任务',
  automation: '自动化 (CLI)',
  tool_search: '查找工具',
  mode_set: '模式切换',
  scenario: '模式切换',
  scenario_activation: '模式切换',
  view_image: '查看图片',
  preview_url: '预览网页 (skill)',
  remember: '知识库 (CLI)',
  recall: '知识库检索 (CLI)',
  list_agents: '查询智能体 (CLI)',
  list_agent_teams: '查询团队 (CLI)',
  xiaomi_org_status: '名册状态',
  xiaomi_dispatch: '派给员工',
  xiaomi_wake: '催办推进',
  xiaomi_board_overview: '全局看板',
  tasks: '任务看板',
  knowledge: '知识库',
  platform: '平台管理',
  create_agent: '创建智能体 (CLI)',
  update_agent: '更新智能体 (CLI)',
  setup_agent: '设置智能体',
  skill_manager: '技能管理 (CLI)',
  claude_session: 'Claude 会话',
  invoke_acp_agent: 'ACP 子代理',
  invoke_acp_agent_tool: 'ACP 子代理',
  trae_delegate: '外部 CLI 委派',
  trae_start: '外部 CLI 启动',
  trae_status: '外部 CLI 状态',
  trae_new_chat: '外部 CLI 新会话',
  trae_switch_mode: '外部 CLI 切换模式',
    read_lints: '读取诊断',
    mind_map: '思维导图',
    process: '进程管理',
  process_start: '启动进程',
  process_poll: '查询进程',
  process_log: '进程日志',
  process_kill: '终止进程',
  process_wait: '等待进程',
  browser: '浏览器',
  browser_navigate: '打开网页 (skill)',
  browser_click: '浏览器点击 (skill)',
  browser_type: '浏览器输入 (skill)',
  browser_scroll: '浏览器滚动 (skill)',
  browser_back: '浏览器后退 (skill)',
  browser_snapshot: '浏览器快照 (skill)',
  browser_close: '关闭浏览器 (skill)',
  browser_press: '浏览器按键 (skill)',
  browser_console: '浏览器控制台 (skill)',
  browser_get_images: '获取页面图片 (skill)',
  send_message: '发送消息',
  session_search: '搜索历史会话 (CLI)',
  session_workspace: '会话工作区',
  web_extract: '网页提取',
  vision_analyze: '图像分析',
  experience_save: '保存经验 (CLI)',
  experience_get: '读取经验 (CLI)',
  experience_list: '经验列表 (CLI)',
  experience_update: '更新经验 (CLI)',
  experience_mark_used: '标记经验 (CLI)',
  experience_delete: '删除经验 (CLI)',
  list_assignable_tools: '可分配工具 (CLI)',
  list_skills_catalog: '技能目录 (CLI)',
  propose_goal: '目标方案',
  goal_report: '目标汇报',
  subtask_work_checklist: '执行步骤',
  subtask_outcome_report: '完成汇报',
  'claude-code': 'Claude Code',
  // 常见 MCP / 别名
  mcp: '扩展工具',
  // Entity Asset Hub
  assets: '实体资产',
}

/** 气泡内折叠条用的超短标签（2～4 字，与 ToolCallList 一致） */
export const TOOL_SHORT_LABEL_ZH = {
  read_file: '读取',
  read: '读取',
  write_file: '写入',
  str_replace: '编辑',
  bash: '终端',
  terminal: '终端',
  execute_command: '命令',
  web_search: '搜索',
  web_fetch: '抓取',
  web_extract: '提取',
  supervisor: '任务',
  subagent: '子代理',
  task: '子代理',
  view_image: '图片',
  preview_url: '预览',
  ask_clarification: '询问',
  plan: '计划',
  remember: '记忆',
  recall: '回忆',
  todo: '待办',
  worker: '并行',
  automation: '定时',
  propose_goal: '目标',
  goal_report: '目标',
  delete: '删除',
  ls: '目录',
  list_dir: '目录',
  search_content: '搜索',
  search_code_index: '工作区搜索',
  rg: '内容搜',
  grep: '内容搜',
  find_file: '找文件',
  find: '找文件',
  write_to_file: '写入',
  write: '写入',
  replace_in_file: '编辑',
  replace: '编辑',
  create_agent: '创建',
  update_agent: '更新',
  setup_agent: '设置',
  skill_manager: '技能',
  claude_session: '会话',
  'claude-code': 'Claude',
  trae_delegate: '委派',
  trae_switch_mode: '切换',
  trae_start: '启动',
  trae_status: '状态',
  trae_new_chat: '新会话',
  read_lints: '诊断',
  mind_map: '导图',
  image_search: '搜图',
  media_image_generate: '生成图',
  media_video_generate: '生视频',
  media_voiceover_synthesize: '配音',
  media_subtitle_build: '字幕',
  media_subtitle_burn: '烧录',
  media_subtitle_extract: '提字幕',
  media_task_wait: '等生图',
  mode_set: '模式',
  scenario: '模式',
  scenario_activation: '模式',
  list_agents: '智能体',
  tool_search: '找工具',
  invoke_acp_agent: '子代理',
  invoke_acp_agent_tool: '子代理',
  browser_navigate: '浏览',
  browser_click: '点击',
  browser_type: '输入',
  browser_scroll: '滚动',
  browser_back: '后退',
  browser_snapshot: '快照',
  browser_close: '关闭',
  browser_press: '按键',
  browser_console: '控制台',
  browser_get_images: '取图',
  browser: '浏览器',
  process: '进程',
  process_start: '启进程',
  process_poll: '查进程',
  process_log: '进程日志',
  process_kill: '杀进程',
  process_wait: '等进程',
  send_message: '发消息',
  session_search: '搜会话',
  session_workspace: '工作区',
  vision_analyze: '识图',
  experience_save: '存经验',
  experience_get: '读经验',
  experience_list: '经验库',
  experience_update: '改经验',
  experience_mark_used: '用经验',
  list_assignable_tools: '工具表',
  list_skills_catalog: '技能表',
  subtask_work_checklist: '步骤',
  subtask_outcome_report: '汇报',
  // Entity Asset Hub
  assets: '资产',
}

/** 与 TOOL_NAME_ZH 对齐的展示图标（emoji，无额外依赖） */
export const TOOL_ICON = {
  bash: '⌨️',
  execute_command: '⌨️',
  terminal: '⌨️',
  ls: '📂',
  list_dir: '📂',
  read_file: '📄',
  read: '📄',
  write_file: '✍️',
  write_to_file: '✍️',
  write: '✍️',
  str_replace: '🔧',
  replace_in_file: '🔧',
  replace: '🔧',
  delete_file: '🗑️',
  delete: '🗑️',
  search_content: '🔍',
  search_code_index: '🔍',
  rg: '🔍',
  grep: '🔍',
  find_file: '📂',
  find: '📂',
  web_search: '🔍',
  web_fetch: '🌐',
  image_search: '🖼️',
  supervisor: '🧭',
  plan: '📋',
  subagent: '🤖',
  task: '🤖',
  ask_clarification: '❔',
  write_todos: '📋',
  todo: '📋',
  worker: '⚡',
  automation: '⏰',
  tool_search: '🔎',
  mode_set: '🎯',
  scenario: '🎯',
  scenario_activation: '🎯',
  view_image: '🖼️',
  preview_url: '👁️',
  remember: '🧠',
  recall: '💭',
  list_agents: '📋',
  create_agent: '🤖',
  update_agent: '🤖',
  setup_agent: '🤖',
  skill_manager: '🛠️',
  claude_session: '💬',
  invoke_acp_agent: '🤖',
  invoke_acp_agent_tool: '🤖',
  trae_delegate: '📤',
  trae_start: '🚀',
  trae_status: '📊',
  trae_new_chat: '💬',
  trae_switch_mode: '🔄',
  read_lints: '🩺',
  mind_map: '🗺️',
  process: '⚙️',
  process_start: '▶️',
  process_poll: '📡',
  process_log: '📜',
  process_kill: '⏹️',
  process_wait: '⏳',
  browser_navigate: '🌐',
  browser_click: '🖱️',
  browser_type: '⌨️',
  browser_scroll: '📜',
  browser_back: '◀️',
  browser_snapshot: '📸',
  browser_close: '🚪',
  browser_press: '⌨️',
  browser_console: '📟',
  browser_get_images: '🖼️',
  browser: '🌐',
  send_message: '💬',
  session_search: '🔎',
  session_workspace: '📁',
  web_extract: '🌐',
  vision_analyze: '👁️',
  experience_save: '📌',
  experience_get: '📖',
  experience_list: '📚',
  experience_update: '✏️',
  experience_mark_used: '✅',
  list_assignable_tools: '🧰',
  list_skills_catalog: '📚',
  propose_goal: '🤝',
  goal_report: '🎯',
  'claude-code': '💬',
  mcp: '🔌',
  // Entity Asset Hub
  assets: '🗂️',
  default: '🔧',
}

/** 与 chat-normalize 同源：解析工具入参为对象（支持 JSON 字符串） */
function toolInputArgs(tool) {
  const raw = tool?.input
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t || t === '{}' || t === '[]') return null
    try {
      const p = JSON.parse(t)
      return typeof p === 'object' && p != null && !Array.isArray(p) ? p : null
    } catch {
      return null
    }
  }
  return null
}

export function resolveToolKey(tool) {
  const raw = typeof tool === 'string' ? tool : resolveEffectiveToolName(tool)
  const s = String(raw != null ? raw : '').trim()
  if (!s) return 'tool'
  const key = s.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  if (key === 'task') return 'subagent'
  if (key === 'propose_hosted_agent') return 'propose_goal'
  return key
}

/** Lead 委派子智能体工具（现名 subagent，兼容历史 task） */
export function isSubagentDelegationToolName(name) {
  const key = resolveToolKey(typeof name === 'string' ? { name } : name)
  return key === 'subagent'
}

/** 占位名（流式先到 id、后到 function.name 时网关常写「工具」） */
export function isGenericToolName(name) {
  const n = String(name ?? '').trim().toLowerCase()
  return !n || n === '工具' || n === 'tool' || n === '--'
}

/** subagent 入参形状（无 path；流式阶段 name 常为「工具」占位） */
function looksLikeSubagentArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const st = String(args.subagent_type ?? args.subagentType ?? '').trim()
  if (st) return true
  const desc = String(args.description ?? '').trim()
  const prompt = String(args.prompt ?? '').trim()
  const path = String(args.path ?? args.file_path ?? args.target_file ?? args.filepath ?? '').trim()
  if (path) return false
  return !!(desc && (prompt || st))
}

/** 仅凭入参形状推断内置工具名（供 UI 与 upsert 合并） */
export function inferToolNameFromArgs(args, fallbackName) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return isGenericToolName(fallbackName) ? 'tool' : String(fallbackName || 'tool')
  }
  if (looksLikePlanToolArgs(args)) return 'plan'
  if (looksLikeSubagentArgs(args)) {
    const fb = String(fallbackName ?? '').trim().toLowerCase()
    if (!fb || isGenericToolName(fb) || fb === 'task' || fb === 'subagent') return 'subagent'
    return String(fallbackName)
  }
  const path = args.path ?? args.file_path ?? args.target_file ?? args.filepath ?? args.filePath
  if (typeof path !== 'string' || !path.trim()) {
    return isGenericToolName(fallbackName) ? 'tool' : String(fallbackName || 'tool')
  }
  const hasOffset = args.offset != null && String(args.offset).trim() !== ''
  const hasLimit = args.limit != null && String(args.limit).trim() !== ''
  if (hasOffset || hasLimit) return 'read'
  const hasOldString = args.old_string != null || args.old_str != null
  const hasNewString = args.new_string != null || args.new_str != null
  const hasContent = args.content != null && String(args.content).trim() !== ''
  if (hasOldString || hasNewString) {
    if (isGenericToolName(fallbackName)) return 'replace'
    return String(fallbackName)
  }
  if (hasContent) {
    if (isGenericToolName(fallbackName)) return 'write'
    return String(fallbackName)
  }
  if (isGenericToolName(fallbackName)) return 'read'
  return String(fallbackName || 'read')
}

/** 解析用于展示/分流的工具名（避免中文占位「工具」→ safeToolKind 变成 `--`） */
export function resolveEffectiveToolName(tool) {
  if (typeof tool === 'string') {
    const s = String(tool).trim()
    if (s === 'read_context_slice') return 'read'
    return isGenericToolName(s) ? 'tool' : s
  }
  const raw = tool?.name ?? tool?.tool_name ?? tool?.toolName
  let name = raw != null && String(raw).trim() ? String(raw).trim() : ''
  if (name === 'read_context_slice') name = 'read'
  const args = toolInputArgs(tool)
  return inferToolNameFromArgs(args, name || 'tool')
}

/** worker 批次内文件操作的中文摘要前缀 */
export function workerFileActionBriefZh(action) {
  const a = String(action || '').trim().toLowerCase()
  if (a === 'write') return 'write'
  if (a === 'delete') return 'delete'
  if (a === 'replace') return 'replace'
  return a || 'edit'
}

/** read_file 折叠条摘要：带来源前缀（post_search / prefetch / post_edit） */
export function formatReadFileBriefWithSource(args) {
  if (!args || typeof args !== 'object') return ''
  const brief = formatReadPathBrief(args)
  const inv = String(args.invocation_source || '').trim().toLowerCase()
  if (inv === 'post_search') return brief ? `follow-up · ${brief}` : 'follow-up'
  if (inv === 'prefetch' || args._prefetch) return brief ? `prefetch · ${brief}` : 'prefetch'
  if (inv === 'post_edit') return brief ? `post-edit · ${brief}` : 'post-edit'
  return brief
}

/**
 * 将 read 的 offset/limit（或历史 start_line/end_line）格式化为 L12-L40。
 * offset 为起始行（1-based），limit 为行数 → 结束行 = start + limit - 1。
 */
export function formatReadLineRangeLabel(args, opts = {}) {
  if (!args || typeof args !== 'object') return ''
  const offsetKey = opts.offsetKey || 'offset'
  const limitKey = opts.limitKey || 'limit'
  const startKey = opts.startKey || 'start_line'
  const endKey = opts.endKey || 'end_line'

  const rawOff = args[offsetKey]
  const rawLim = args[limitKey]
  const hasOff = rawOff != null && String(rawOff).trim() !== ''
  const hasLim = rawLim != null && String(rawLim).trim() !== ''
  if (hasOff || hasLim) {
    const offN = hasOff ? Number(rawOff) : NaN
    const limN = hasLim ? Number(rawLim) : NaN
    const startOk = Number.isFinite(offN)
    const limOk = Number.isFinite(limN) && limN > 0
    if (startOk && limOk) {
      const end = offN + limN - 1
      return `L${offN}-${end}`
    }
    if (startOk && !hasLim) return `L${offN}`
    if (!hasOff && limOk) return `L1-${limN}`
    // 非数字回退
    if (hasOff && hasLim) return `L${String(rawOff).trim()}+${String(rawLim).trim()}`
    if (hasOff) return `L${String(rawOff).trim()}`
    return `+${String(rawLim).trim()}`
  }

  const start = args[startKey] != null && String(args[startKey]).trim() !== '' ? String(args[startKey]).trim() : ''
  const end = args[endKey] != null && String(args[endKey]).trim() !== '' ? String(args[endKey]).trim() : ''
  if (start || end) {
    if (start && end) return `L${start}-${end}`
    if (start) return `L${start}`
    return `L?-${end}`
  }
  return ''
}

/** 文件类工具折叠条右侧摘要：path + 行号区间（L12-L40） */
export function formatReadPathBrief(args) {
  if (!args || typeof args !== 'object') return ''
  const pathRaw = args.path ?? args.file_path ?? args.target_file ?? args.filepath ?? args.filePath
  const path = typeof pathRaw === 'string' ? pathRaw.trim() : ''
  if (!path) return ''
  const range = formatReadLineRangeLabel(args)
  return range ? `${path} · ${range}` : path
}

/** 与 formatReadPathBrief 相同，供 write/delete/edit 等文件工具复用 */
export const formatFilePathBrief = formatReadPathBrief

export function getToolIcon(toolOrKey) {
  const key = typeof toolOrKey === 'string' ? toolOrKey : resolveToolKey(toolOrKey)
  if (key === 'tool' || key === '') return TOOL_ICON.default || '🔧'
  return TOOL_ICON[key] || TOOL_ICON.default || '🔧'
}

export function getToolCategoryZh(toolOrKey) {
  const key = typeof toolOrKey === 'string' ? toolOrKey : resolveToolKey(toolOrKey)
  if (key === 'tool' || key === '') return 'Tool'
  return capitalizeToolName(key)
}

/** 工具名首字母大写（write → Write，read_file → Read_file）；不查中文表 */
export function capitalizeToolName(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** 工具调用折叠条左侧标签：显示英文工具名（首字母大写） */
export function toolShortLabel(toolName) {
  const key = resolveToolKey({ name: toolName })
  if (key && key !== 'tool') return capitalizeToolName(key)
  const raw = String(toolName || '').trim()
  if (!raw) return 'Tool'
  return capitalizeToolName(raw || 'tool')
}

export function supervisorActionZh(action) {
  if (action == null || action === '') return ''
  return String(action).trim()
}

/**
 * 内置子代理展示名（与后端 ``BUILTIN_AGENT_UI_NAMES`` / ``_BUILTIN_SUBAGENT_UI_NAMES`` 对齐）。
 * ``claude-code`` 等在 ``/api/agents`` 里被 UI 隐藏，必须本地兜底，否则折叠条会裸显 code。
 */
export const BUILTIN_SUBAGENT_UI_NAMES = {
  'general-purpose': '通用助手',
  'code-agent': '代码助手',
  bash: '终端执行',
  'claude-code': 'Claude Code',
  'claude-session': 'Claude Code',
  claude: 'Claude Code',
  'knowledge-retriever': '知识检索',
  'knowledge-curator': '知识整理',
  'project-architect': '项目·方案',
  'project-planner': '项目·计划',
  'project-implementer': '项目·开发',
  'project-reviewer': '项目·审查',
  'project-debugger': '项目·测试',
  'project-qa': '项目·验收',
  'media-screenwriter': '媒体·编剧',
  'media-visual-planner': '媒体·视觉策划',
  'media-artist': '媒体·美术',
  'media-video-director': '媒体·视频导演',
  'media-voice-director': '媒体·配音',
  'media-post': '媒体·后期',
  'hf-developer': 'HyperFrames·动画开发',
  'hf-visual-designer': 'HyperFrames·视觉设计',
  'hf-director': 'HyperFrames·导演',
  'hf-renderer': 'HyperFrames·后期',
  'marketing-social-media-operation': '社媒运营',
  'finance-intake': '财务·收单分类',
  'finance-compliance': '财务·合规校验',
  'finance-risk': '财务·风控识别',
  'finance-ledger': '财务·科目汇总',
}

/** 子代理折叠条左侧：通过 agent_code 从智能体列表解析展示名 */
export function formatSubagentTypeLabel(subagentType, agentsFromApi) {
  const raw = String(subagentType || '').trim()
  if (!raw) return 'Subagent'
  const list = Array.isArray(agentsFromApi) ? agentsFromApi : getAgentsDisplayCache()
  const label = resolveAssignedAgentDisplayName(raw, list)
  if (label) return label
  if (raw.length <= 18) return raw
  return `${raw.slice(0, 16)}…`
}

/** 与顶栏 CHAT_SCENES / 后端 TASK_SCENARIO_PROFILES 一致 */
export const SCENARIO_LABEL_ZH = {
  ask: 'Ask 模式',
  plan: 'Plan 模式',
  agent: 'Agent 模式',
  chat: 'Ask 模式',
  workspace: 'Agent 模式',
  evolve: '优化智能体',
}

/** @param {string | null | undefined} command */
export function agentBrowserBriefFromCommand(command) {
  const cmd = String(command || '').trim()
  if (!cmd || !/\bagent-browser\b/i.test(cmd)) return null
  const subs = [
    ['snapshot', '快照'],
    ['screenshot', '截图'],
    ['click', '点击'],
    ['fill', '输入'],
    ['open', '打开'],
    ['close', '关闭'],
    ['press', '按键'],
    ['scroll', '滚动'],
    ['back', '后退'],
    ['console', '控制台'],
  ]
  for (const [token, zh] of subs) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(cmd)) return zh
  }
  return '浏览器'
}

/**
 * 与后端 ``REMOVED_LEGACY_TOOL_NAMES`` 中 browser_* / preview_url 一致：改走 agent-browser 技能 + terminal。
 */
export const RETIRED_BROWSER_SKILL_TOOL_NAMES = new Set([
  'preview_url',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_snapshot',
  'browser_close',
  'browser_press',
  'browser_console',
  'browser_get_images',
])

/**
 * 与后端 ``web_research`` 场景工具一致：联网检索/抓页，仍走内置工具（非 CLI）。
 */
export const WEB_RESEARCH_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'web_extract',
  'vision_analyze',
])

/**
 * 与后端 ``_ADMIN_CLI_REPLACED_TOOL_NAMES`` 一致：历史会话中仍可能出现的退役治理工具。
 */
export const RETIRED_ADMIN_CLI_TOOL_NAMES = new Set([
  'remember',
  'recall',
  'experience_save',
  'experience_list',
  'experience_get',
  'experience_update',
  'experience_mark_used',
  'experience_delete',
  'create_agent',
  'update_agent',
  'list_agents',
  'list_agent_teams',
  'list_assignable_tools',
  'list_skills_catalog',
  'skill_manager',
  'automation',
  'session_search',
])

const EVOFLOW_CLI_SUBCOMMAND_ZH = {
  models: '模型',
  skills: '技能',
  agents: '智能体',
  mcp: 'MCP',
  memory: '长期记忆',
  knowledge: '知识库',
  experience: '经验库',
  automation: '自动化',
  profile: '用户画像',
  sessions: '历史会话',
}

/** @param {string | null | undefined} command */
export function evoflowCliBriefFromCommand(command) {
  const cmd = String(command || '').trim()
  if (!cmd) return null
  const m = cmd.match(/\bevoflow(?:\.exe)?(?:\s+--\S+\s+)*\s+([a-z][a-z0-9_-]*)/i)
  if (!m) return null
  const idx = m.index ?? cmd.search(/\bevoflow/i)
  const beforeEvoflow = cmd.slice(0, idx).trimEnd()
  // agent-browser --session evoflow snapshot … — evoflow 是会话名，不是 CLI
  if (/(?:^|\s)--session\s*$/i.test(beforeEvoflow)) return null
  const sub = String(m[1] || '').trim().toLowerCase()
  return EVOFLOW_CLI_SUBCOMMAND_ZH[sub] || sub
}

/**
 * 与后端 ``CORE_TOOL_NAMES`` 一致：日常对话常驻基础工具。
 * ``scenario_activation`` 为历史别名；``task`` 为 subagent 遗留名。
 */
export const CORE_CHAT_TOOL_NAMES = new Set([
  'tool_search',
  'mode_set',
  'scenario',
  'scenario_activation',
  'ask_clarification',
  'subagent',
  'task',
  'worker',
  'find',
  'find_file',
  'rg',
  'read',
  'read_file',
  'terminal',
  'xiaomi_org_status',
  'xiaomi_dispatch',
  'xiaomi_wake',
  'xiaomi_board_overview',
])

/** @param {string | { name?: string } | null | undefined} name */
export function isCoreChatToolName(name) {
  const key = resolveToolKey(typeof name === 'string' ? { name } : name)
  return CORE_CHAT_TOOL_NAMES.has(key)
}

/** mode_set / scenario 工具：聊天区只展示一行切换文案，不展开入参/出参 */
export function isScenarioToolName(name) {
  const key = resolveToolKey({ name })
  return key === 'mode_set' || key === 'scenario' || key === 'scenario_activation'
}

function normalizeScenarioKeyBrief(raw) {
  const r = String(raw || '').trim().toLowerCase()
  if (!r) return null
  if (Object.prototype.hasOwnProperty.call(SCENARIO_LABEL_ZH, r)) return r
  if (r === 'dialogue' || r === 'dialog') return 'ask'
  if (['trae', 'trae_window', 'trae-runtime', 'trae_runtime'].includes(r)) return 'ask'
  if (['evolve', 'evolution', 'self_evolve', 'self-improve', 'self_improve', 'improve', 'optimize'].includes(r)) {
    return 'ask'
  }
  if (['work', 'do', 'task', 'execute', 'planning', 'coding', 'code', 'edit', 'implement'].includes(r)) return 'plan'
  if (['ask', 'chat', 'qa', 'question'].includes(r)) return 'ask'
  if (['agent', 'workspace', 'workspaces', 'file', 'files', 'file_ops', 'filesystem', 'edit_file'].includes(r)) return 'agent'
  if (['web', 'search', 'research', 'browse'].includes(r)) return 'agent'
  if (['manage', 'admin', 'govern'].includes(r)) return 'ask'
  return null
}

/**
 * 场景工具折叠条/标题：如「切换任务规划」「退出网络搜索」
 * @param {Record<string, unknown> | null | undefined} args
 */
export function scenarioSwitchBrief(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'mode_set'
  const act = String(args.action || '').trim().toLowerCase()
  const modeRaw = args.mode ?? args.scenario_key
  const sk = normalizeScenarioKeyBrief(modeRaw)
  const label = sk || String(modeRaw || '').trim()
  if (act === 'activate' && label) return `mode_set · activate · ${label}`
  if (act === 'deactivate' && label) return `mode_set · deactivate · ${label}`
  if (label) return `mode_set · ${label}`
  return act ? `mode_set · ${act}` : 'mode_set'
}

/**
 * 子任务 assigned_to（agent_code）→ 展示名：优先后端下发的 assignedAgentName，其次 `/api/agents`。
 * @param {string} code
 * @param {unknown[] | undefined} agentsFromApi
 * @returns {string}
 */
export function resolveAssignedAgentDisplayName(code, agentsFromApi) {
  const raw = String(code ?? '').trim()
  if (!raw) return ''
  const rawNorm = raw.toLowerCase().replace(/_/g, '-')
  const list = Array.isArray(agentsFromApi) ? agentsFromApi : []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const ac = String(row.agent_code ?? row.agentCode ?? row.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-')
    if (ac && ac === rawNorm) {
      const zh = String(row.agent_name ?? row.agentName ?? '').trim()
      if (zh) return zh
      break
    }
  }
  const builtin = BUILTIN_SUBAGENT_UI_NAMES[rawNorm]
  if (builtin) return builtin
  return raw
}

/**
 * @deprecated 展示名由后端 assignedAgentName 下发；此处仅合并快照与 agents API。
 */
export function resolveSubtaskAgentDisplayLabel(code, displayHint, agentsFromApi) {
  const fromSnap = String(displayHint ?? '').trim()
  const c = String(code ?? '').trim()
  return fromSnap || (c ? resolveAssignedAgentDisplayName(c, agentsFromApi) : '') || fromSnap || c || '未分配'
}

/** Path leaf for user-facing briefs (no full path / no ids). */
export function pathLeafBrief(pathLike) {
  const s = String(pathLike || '')
    .trim()
    .replace(/\\/g, '/')
  if (!s) return ''
  const parts = s.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

function parseLooseJsonObject(raw) {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t || t === '{}' || t === '[]') return null
  try {
    const p = JSON.parse(t)
    return typeof p === 'object' && p != null && !Array.isArray(p) ? p : null
  } catch {
    return null
  }
}

function pushBriefBit(bits, v, max = 64) {
  const s = v != null ? String(v).trim() : ''
  if (!s) return
  bits.push(s.length > max ? `${s.slice(0, max)}…` : s)
}

/**
 * Action-router tools (tasks / knowledge / platform): human payload only.
 * Never surface task_id / docId / agent_code / uuid-like ids in the chip.
 * @param {'tasks'|'knowledge'|'platform'} toolKey
 * @param {Record<string, unknown> | null | undefined} args
 * @returns {string[]}
 */
export function formatActionRouterBriefBits(toolKey, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const bits = []
  const action = String(a.action || '').trim()
  if (action) bits.push(action)

  if (toolKey === 'tasks') {
    const act = action.toLowerCase()
    if (act === 'create') {
      pushBriefBit(bits, a.name || a.title, 40)
    } else if (act === 'progress') {
      pushBriefBit(bits, a.name || a.title, 40)
      if (a.progress != null && a.progress !== '') {
        const n = Number(a.progress)
        pushBriefBit(bits, Number.isFinite(n) ? `${n}%` : String(a.progress))
      }
      pushBriefBit(bits, a.summary || a.status_zh || a.status, 48)
    } else if (act === 'state') {
      pushBriefBit(bits, a.name || a.title, 40)
      pushBriefBit(bits, a.status_zh || a.status)
      pushBriefBit(bits, a.summary, 48)
    } else if (act === 'list') {
      pushBriefBit(bits, a.status)
      pushBriefBit(bits, a.role)
      pushBriefBit(bits, a.source)
    } else if (act === 'get' || act === 'delete') {
      pushBriefBit(bits, a.name || a.title || a.summary, 40)
    } else {
      // Unknown action — still surface human summary if present.
      pushBriefBit(bits, a.summary || a.status_zh || a.status || a.name || a.title, 48)
    }
    return bits
  }

  if (toolKey === 'knowledge') {
    const act = action.toLowerCase()
    if (act === 'search') {
      pushBriefBit(bits, a.query, 48)
    } else if (act === 'read') {
      const paths = Array.isArray(a.paths) ? a.paths : []
      const first = paths.map((p) => pathLeafBrief(p)).find(Boolean)
      pushBriefBit(bits, first || pathLeafBrief(a.path), 40)
    } else if (act === 'list') {
      const scope0 = Array.isArray(a.scopes) ? a.scopes[0] : ''
      pushBriefBit(bits, pathLeafBrief(a.path) || pathLeafBrief(scope0) || a.prefix, 40)
    } else if (act === 'write' || act === 'graph') {
      pushBriefBit(bits, pathLeafBrief(a.path), 40)
    } else if (act === 'ingest') {
      pushBriefBit(bits, a.title || a.name, 40)
    }
    return bits
  }

  if (toolKey === 'platform') {
    const payload = parseLooseJsonObject(a.args_json) || {}
    const op = action.includes('.') ? action.split('.').pop() : action
    const opL = String(op || '').toLowerCase()
    if (opL === 'search' || opL.endsWith('_search')) {
      pushBriefBit(bits, payload.query || payload.search || a.query, 48)
    } else if (opL === 'create' || opL === 'ingest' || opL === 'save') {
      pushBriefBit(bits, payload.name || payload.title || payload.agent_name || payload.role_name, 40)
    } else if (opL === 'hire' || opL === 'update' || opL === 'pause' || opL === 'resume') {
      pushBriefBit(
        bits,
        payload.agent_name || payload.role_name || payload.name || payload.title,
        40,
      )
    } else if (opL === 'list' || opL === 'catalog' || opL === 'help') {
      pushBriefBit(bits, payload.status || payload.search || payload.query || a.domain, 32)
    } else if (opL === 'set_default_model' || opL === 'create_model') {
      pushBriefBit(bits, payload.name || payload.model, 40)
    } else {
      // Generic readable fields only — never *id / agent_code.
      pushBriefBit(
        bits,
        payload.query ||
          payload.search ||
          payload.name ||
          payload.title ||
          payload.agent_name ||
          payload.role_name ||
          payload.status ||
          pathLeafBrief(payload.path),
        40,
      )
    }
    return bits
  }

  return bits
}

/** assets(action=…) 人读摘要：只展示 action + 关键内容，不暴露内部路径/实体 id 之外的噪声 */
export function formatAssetsBriefBits(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const bits = []
  const action = String(a.action || '').trim()
  if (action) bits.push(action)

  const act = action.toLowerCase()
  if (act === 'search') {
    pushBriefBit(bits, a.query, 48)
    const kinds = String(a.kinds || '').trim()
    if (kinds) bits.push(kinds.split(',').map((x) => x.trim()).filter(Boolean).join('+'))
  } else if (act === 'read' || act === 'list') {
    const rel = String(a.path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (rel) pushBriefBit(bits, rel, 40)
  } else if (act === 'note') {
    const text = String(a.content || a.query || '').trim()
    if (text) pushBriefBit(bits, text, 48)
    const slug = String(a.path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (slug) pushBriefBit(bits, slug, 40)
  } else if (act === 'profile') {
    const dim = String(a.path || '').trim()
    if (dim) bits.push(dim)
    const text = String(a.content || a.query || '').trim()
    if (text) pushBriefBit(bits, text, 48)
  }
  return bits
}

/**
 * 单行摘要：英文工具名 + 关键参数摘要（路径 / query / command 等）
 */
export function formatToolDisplayTitle(tool) {
  const name = resolveEffectiveToolName(tool)
  const key = resolveToolKey(name) || String(name || 'tool').trim() || 'tool'
  const label = capitalizeToolName(key)
  const args = toolInputArgs(tool)

  if (name === 'subtask_work_checklist' || key === 'subtask_work_checklist') {
    return formatSubtaskWorkChecklistTitle(args)
  }
  if (name === 'subtask_outcome_report' || key === 'subtask_outcome_report') {
    return formatSubtaskOutcomeReportTitle(args)
  }

  const bits = []
  const push = (v, max = 64) => pushBriefBit(bits, v, max)

  if (key === 'plan') {
    const md = args?.markdown ? String(args.markdown) : ''
    push(md.trim().split('\n')[0] || '', 32)
  } else if (key === 'supervisor') {
    push(args?.action)
    // Prefer human labels; never fall back to task_id / subtask_id on the chip.
    push(args?.task_name || args?.subtask_name || args?.agent_message)
  } else if (key === 'tasks' || key === 'knowledge' || key === 'platform') {
    bits.push(...formatActionRouterBriefBits(key, args))
  } else if (key === 'assets') {
    bits.push(...formatAssetsBriefBits(args))
  } else if (key === 'subagent' || key === 'task') {
    const st = String(args?.subagent_type ?? args?.subagentType ?? '').trim()
    if (st) bits.push(formatSubagentTypeLabel(st))
    push(args?.description || args?.prompt, 40)
  } else if (
    key === 'mode_set' ||
    key === 'scenario' ||
    key === 'scenario_activation'
  ) {
    push(args?.action)
    push(args?.mode ?? args?.scenario_key)
  } else if (key === 'process' || key === 'browser') {
    push(args?.action)
    push(args?.command || args?.url || args?.ref)
  } else if (key === 'worker') {
    const taskList = Array.isArray(args?.tasks) ? args.tasks : []
    if (taskList.length) push(`${taskList.length} tasks`)
  } else if (key === 'bash' || key === 'terminal' || key === 'execute_command') {
    push(truncateShellCommandBrief(args?.command), 80)
  } else if (key === 'search_code_index') {
    const q = args?.query ? String(args.query).trim() : ''
    const extra = Array.isArray(args?.queries)
      ? args.queries.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    const merged = [q, ...extra.filter((t) => t !== q)].filter(Boolean)
    if (merged.length) push(merged.slice(0, 4).join(' · '), 80)
  } else {
    const pathBrief = formatReadPathBrief(args)
    if (pathBrief) bits.push(pathBrief)
    else {
      push(args?.query || args?.pattern || args?.url || args?.command || args?.prompt || args?.title || args?.action)
      push(args?.path || args?.root || args?.glob || args?.image_path)
    }
  }

  if (!bits.length) return label
  return `${label} · ${bits.join(' · ')}`
}


function pickFirstTrimmed(...values) {
  for (const v of values) {
    const s = v != null ? String(v).trim() : ''
    if (s) return s
  }
  return ''
}

/** 从 formatToolDisplayTitle 结果中提取折叠条右侧摘要（第一个 · 之后） */
export function toolTitleDetailTail(title) {
  const t = String(title || '').trim()
  const i = t.indexOf(' · ')
  return i >= 0 ? t.slice(i + 3).trim() : ''
}

/**
 * 折叠条右侧摘要：优先用 title 的 detail 段，否则从常见入参字段提取。
 * ToolCallList 的 toolBrief 专用分支仍优先；本函数用于兜底与未覆盖工具。
 */
export function formatToolBriefDetail(tool, titleText) {
  const title = String(titleText || formatToolDisplayTitle(tool)).trim()
  const tail = toolTitleDetailTail(title)
  if (tail) return tail

  const args = toolInputArgs(tool)
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''

  const query = pickFirstTrimmed(args.query)
  if (query) return query

  const pattern = pickFirstTrimmed(args.pattern)
  if (pattern) {
    const scope = pickFirstTrimmed(args.path, args.root, args.glob)
    if (scope && scope !== '.') return `${pattern} · ${scope}`
    return pattern
  }

  const pathBrief = formatReadPathBrief(args)
  if (pathBrief) return pathBrief

  const url = pickFirstTrimmed(args.url, args.image_path)
  if (url) return url

  const cmd = pickFirstTrimmed(args.command)
  if (cmd) return truncateShellCommandBrief(cmd)

  const text = pickFirstTrimmed(
    args.text,
    args.message,
    args.prompt,
    args.description,
    args.question,
    args.goal,
    args.summary,
    args.title,
    args.name,
    args.agent_message,
    args.agent_name,
    args.role_name,
    args.role,
    args.status_zh,
    args.status,
  )
  if (text) return text

  // Mode / action labels are ok; never surface raw ids (task_id / agent_code / uuid).
  const channel = pickFirstTrimmed(args.channel, args.task_type, args.mode, args.action, args.scenario_key)
  if (channel) return channel

  return ''
}

const ACTIVITY_HIDDEN_TOOL_KEYS = new Set([
  'ask_clarification',
  'propose_goal',
  'present_files',
  'present_file',
  'todo_write',
  'todo_reminder',
  'mode_set',
  'scenario',
  'scenario_activation',
])

function parseStreamToolCallArgs(tc) {
  if (!tc || typeof tc !== 'object') return {}
  const direct = tc.args ?? tc.input ?? tc.parameters ?? tc.arguments
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct
  const fn = tc.function && typeof tc.function === 'object' ? tc.function : null
  if (fn && typeof fn.arguments === 'string' && fn.arguments.trim()) {
    try {
      const parsed = JSON.parse(fn.arguments)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function workerActivityLabelsFromCall(tc) {
  const args = parseStreamToolCallArgs(tc)
  const tasks = Array.isArray(args.tasks) ? args.tasks : []
  const labels = []
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const action = String(task.action || '').trim().toLowerCase()
    if (action === 'search') {
      labels.push(toolShortLabel('search_code_index'))
    } else if (action === 'locate') {
      labels.push(toolShortLabel('find'))
    } else if (action === 'write' || action === 'replace' || action === 'edit') {
      labels.push(toolShortLabel('write_to_file'))
    } else if (action === 'delete') {
      labels.push(toolShortLabel('delete_file'))
    }
  }
  return labels
}

/** 流式「调用：🔍 搜索 · …」与 ToolCallList 折叠条一致（worker 展开为并发子工具） */
export function formatActivityLabelsFromToolCalls(toolCalls) {
  const labels = []
  const seen = new Set()
  const push = (lab) => {
    const s = String(lab || '').trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    labels.push(s)
  }
  for (const tc of toolCalls || []) {
    if (!tc || typeof tc !== 'object') continue
    const name = resolveEffectiveToolName(tc)
    const key = resolveToolKey(name)
    if (key.startsWith('scheduler:')) continue
    if (key === 'worker') {
      for (const lab of workerActivityLabelsFromCall(tc)) push(lab)
      continue
    }
    if (ACTIVITY_HIDDEN_TOOL_KEYS.has(key)) continue
    push(toolShortLabel(key || name))
  }
  return labels
}

export function formatActivityDetailFromToolCalls(toolCalls) {
  const labels = formatActivityLabelsFromToolCalls(toolCalls)
  return labels.length ? `calling: ${labels.join(' · ')}` : 'calling tools…'
}

function isToolCallRunning(tc) {
  if (!tc || typeof tc !== 'object') return false
  const status = String(tc.status || '').trim().toLowerCase()
  if (!status) return true
  return status === 'running' || status === 'in_progress'
}

/** Last in-flight tool row (chronological); omits completed ok/error rows. */
export function pickLatestRunningToolCall(toolCalls) {
  let latest = null
  for (const tc of toolCalls || []) {
    if (isToolCallRunning(tc)) latest = tc
  }
  return latest
}

/** Live activity line: only the newest tool still in flight. */
export function formatActivityDetailFromRunningToolCalls(toolCalls) {
  const latest = pickLatestRunningToolCall(toolCalls)
  if (!latest) return ''
  const formatted = formatActivityDetailFromToolCalls([latest])
  return formatted !== '调用工具…' ? formatted : ''
}

/** 将后端旧格式 ``调用工具 worker…`` 规范为带图标的 ``调用：…`` */
export function normalizeStreamActivityDetail(detail, { toolName, toolCalls } = {}) {
  const fromRunning = formatActivityDetailFromRunningToolCalls(toolCalls)
  if (fromRunning) return fromRunning
  const d = String(detail || '').trim()
  if (!d) return d
  if (/^调用：/.test(d)) {
    if (Array.isArray(toolCalls) && toolCalls.length) return ''
    return d
  }
  if (/^(调用工具|执行工具)\s+\S+/u.test(d)) {
    const calls = toolName ? [{ name: toolName }] : []
    const formatted = formatActivityDetailFromToolCalls(calls)
    return formatted !== '调用工具…' ? formatted : d
  }
  return d
}
