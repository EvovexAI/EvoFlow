/**
 * 工具卡片头部摘要（brief）注册表 —— 迁移自 ToolCallList 的内联 if 链。
 *
 * 架构与 ZCode 的工具卡体系同构：卡片头部摘要按 toolKind 注册，注册表未命中时
 * 返回 null，调用方继续走遗留链（存量工具逐族迁移，行为零变更）。
 *
 * 迁移进度：终端族（bash / execute_command / terminal）、文件族
 * （read / read_file / write* / replace* / edit / delete* / ls / list_dir）、
 * 检索族（search_code_index / read_files / search_content / rg / grep / find_file / find / tool_search）、
 * 网络/媒体族（web_search / web_fetch / preview_url / media_*）、view_image、协作子任务族、plan、
 * scenario、list_agents、记忆、todo/automation、询问、agent 系列、trae_*、process、read_lints、mind_map。
 * 遗留链剩余：browser_*、supervisor、subagent、worker、invoke_acp_agent、assets（依赖运行时上下文，
 * 迁移时需把注册表检查点前移）与最终兜底。
 *
 * 注意返回值语义：'' 是合法摘要（头部不显示摘要文本），null 才表示"本表不管"。
 */

import { firstMeaningfulShellOutputLine, parseBrowserStepToolOutput } from '../../lib/chat-normalize.js'
import {
  BROWSER_ACTION_ZH,
  formatReadFileBriefWithSource,
  formatReadLineRangeLabel,
  formatReadPathBrief,
  pathLeafBrief,
  supervisorActionZh,
  workerFileActionBriefZh,
} from '../../lib/tool-display.js'
import {
  formatSubtaskOutcomeReportOutput,
  formatSubtaskOutcomeReportTitle,
  formatSubtaskWorkChecklistTitle,
} from '../../lib/collab-tool-display.js'

export type ToolCardBriefContext = {
  toolKind: string
  inputObj: Record<string, unknown> | null
  /** 已在调用方解析好的主路径（可能为空串） */
  path: string
  toolFailed: boolean
  /** 命令类工具拼好的完整命令（无则缺省） */
  bashCommand?: string
  /** 终端流退出码（仅失败态用于拼接 exit N） */
  terminalExitCode?: number | null
  /** 工具原始输出（命令类 fallback 从首行回填摘要） */
  output?: unknown
  isWriteOrEditTool: boolean
  /** 检索类：调用方已解析的 query（inputObj.query 修剪值） */
  query?: string | null
  /** 工具是否执行中（web_search 结果数 / mind_map 语义依赖） */
  running?: boolean
  /** 网络类：调用方已解析的 url */
  url?: string | null
  /** 进程类：活动会话 id（process 工具的 session_id） */
  processSessionId?: string | null
  /** 卡片短标签（subtask_outcome_report 用于去重判断） */
  shortLabel?: string
  /** supervisor 监控分支：当前时间戳（组件节流态） */
  nowTs?: number
  /** supervisor 监控分支：工具起始时间原始值 */
  timeValue?: unknown
  /** supervisor 调试开关（localStorage EVOFLOW_DEBUG_SHOW_TASK_ID） */
  debugShowTaskIds?: boolean
  /** platform 工具行上的 platform_ui 保留对象 */
  platformUi?: unknown
}

/** 实体资产动作中文（卡片摘要与详情元数据共用）。 */
export const ASSETS_ACTION_ZH: Record<string, string> = {
  search: '搜索资产',
  read: '读取资产',
  list: '列出资产',
  note: '记录笔记',
  profile: '更新画像',
}

const TERMINAL_KINDS = new Set(['bash', 'execute_command', 'terminal'])
const WRITE_DELETE_KINDS = new Set([
  'write',
  'replace',
  'write_file',
  'write_to_file',
  'str_replace',
  'replace_in_file',
  'delete',
  'delete_file',
])
const LIST_KINDS = new Set(['ls', 'list_dir'])
const READ_KINDS = new Set(['read', 'read_file'])
const SEARCH_KINDS = new Set([
  'search_code_index',
  'read_files',
  'search_content',
  'rg',
  'grep',
  'find_file',
  'find',
  'tool_search',
])

const briefFull = (s: string) => String(s || '').trim()

const leafName = (path: string): string => pathLeafBrief(path) || String(path || '').trim()

/** 终端族：优先完整命令（失败拼 exit 码），无入参时从输出首行回填。 */
function terminalBrief(ctx: ToolCardBriefContext): string | null {
  const { bashCommand, toolFailed, terminalExitCode, output } = ctx
  if (bashCommand) {
    const cmd = briefFull(bashCommand.trim())
    if (toolFailed) {
      const exit = terminalExitCode ?? null
      return exit != null && exit !== 0 ? `${cmd} · exit ${exit}` : `${cmd} · 失败`
    }
    return cmd
  }
  const meaningful = firstMeaningfulShellOutputLine(output)
  if (meaningful) {
    return briefFull(toolFailed ? `失败 · ${meaningful}` : meaningful)
  }
  return null
}

/** 文件族：read 走来源标注摘要；写/删显示叶子文件名（流式期间也不被目录前缀挤没）；ls 走路径摘要。 */
function fileBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj, path, isWriteOrEditTool } = ctx
  if (READ_KINDS.has(toolKind)) {
    const brief = formatReadFileBriefWithSource(inputObj)
    if (brief) return brief
    if (path) return briefFull(path)
  }
  if (
    isWriteOrEditTool ||
    toolKind === 'delete' ||
    toolKind === 'delete_file' ||
    toolKind === 'ls' ||
    toolKind === 'list_dir'
  ) {
    if (isWriteOrEditTool || toolKind === 'delete' || toolKind === 'delete_file') {
      const leaf = path ? leafName(path) : ''
      return leaf ? briefFull(leaf) : ''
    }
    const brief = formatReadPathBrief(inputObj)
    const pathBrief = brief || (path ? briefFull(path) : '')
    if (pathBrief) return pathBrief
  }
  return null
}

/** 检索族：代码索引检索（query+queries 合并去重，行号区间 L*）、多文件读取、内容/正则检索（带作用域）。 */
function searchBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj, query } = ctx
  if (toolKind === 'search_code_index') {
    const q = typeof inputObj?.query === 'string' ? inputObj.query.trim() : ''
    const extra = Array.isArray(inputObj?.queries)
      ? (inputObj.queries as unknown[])
          .map((x) => (typeof x === 'string' ? x.trim() : ''))
          .filter(Boolean)
      : []
    const merged = [q, ...extra.filter((t) => t !== q)].filter(Boolean)
    const ro = typeof inputObj?.read_offset === 'number' ? inputObj.read_offset : 0
    const rl = typeof inputObj?.read_limit === 'number' ? inputObj.read_limit : 0
    const kw = merged.length ? briefFull(merged.join(' · ')) : ''
    if (rl > 0) {
      const range = formatReadLineRangeLabel({ offset: ro, limit: rl })
      return kw ? `${kw} · ${range}` : range
    }
    if (merged.length > 1) return briefFull(merged.join(' · '))
    if (merged.length === 1) return briefFull(merged[0])
    // 无关键词且无行区间 → 与遗留链一致，继续后续分支
  }
  if (toolKind === 'read_files' && Array.isArray(inputObj?.paths) && inputObj.paths.length) {
    const paths = inputObj.paths as unknown[]
    const first = paths.find((p) => typeof p === 'string') as string | undefined
    if (first) {
      const short = first.replace(/\\/g, '/').split('/').pop() || first
      return paths.length > 1 ? `${briefFull(short)} +${paths.length - 1}` : briefFull(short)
    }
  }
  if (toolKind === 'search_content' && typeof inputObj?.pattern === 'string') {
    return briefFull(inputObj.pattern as string)
  }
  if (
    (toolKind === 'rg' || toolKind === 'grep' || toolKind === 'find_file' || toolKind === 'find') &&
    typeof inputObj?.pattern === 'string'
  ) {
    const pat = briefFull(inputObj.pattern as string)
    const scopeRaw =
      toolKind === 'find_file' || toolKind === 'find'
        ? (typeof inputObj?.root === 'string' ? inputObj.root : '')
        : (typeof inputObj?.path === 'string' ? inputObj.path : typeof inputObj?.glob === 'string' ? inputObj.glob : '')
    const scope = String(scopeRaw || '').trim()
    if (scope && scope !== '.') return `${pat} · ${briefFull(scope)}`
    return pat
  }
  if (toolKind === 'tool_search' && query) return briefFull(query)
  return null
}

/** 网络/媒体族：检索结果数、URL 抓取、图/视频生成入参摘要。 */
function networkMediaBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj, query, url, output, running } = ctx
  if (toolKind === 'web_search' && query) {
    if (running) return briefFull(query)
    const n = tryWebSearchResultCount(output)
    if (n != null) return n > 0 ? `${briefFull(query)} · ${n} 条` : `${briefFull(query)} · 无结果`
    return briefFull(query)
  }
  if (toolKind === 'web_fetch' && url) return briefFull(url)
  if (toolKind === 'preview_url' && url) return briefFull(url)
  if (toolKind === 'media_image_generate') {
    const pr = typeof inputObj?.prompt === 'string' ? inputObj.prompt.trim() : ''
    const ar = typeof inputObj?.aspect_ratio === 'string' ? inputObj.aspect_ratio.trim() : ''
    if (pr) return ar ? `${briefFull(pr)} · ${ar}` : briefFull(pr)
    if (ar) return ar
  }
  if (toolKind === 'media_video_generate') {
    const pr = typeof inputObj?.prompt === 'string' ? inputObj.prompt.trim() : ''
    const mode = typeof inputObj?.mode === 'string' ? inputObj.mode.trim() : ''
    const dur = inputObj?.duration != null ? String(inputObj.duration) : ''
    const modeZh = mode === 'image2video' ? '图生视频' : mode === 'text2video' ? '文生视频' : mode
    if (pr && modeZh && dur) return `${modeZh} · ${dur}s · ${briefFull(pr)}`
    if (pr && modeZh) return `${modeZh} · ${briefFull(pr)}`
    if (pr) return briefFull(pr)
    if (modeZh) return modeZh
  }
  return null
}

/** 图像查看（遗留链位于文件类之后；kind 独立无冲突）。 */
function viewImageBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'view_image') return null
  const imgPath = typeof ctx.inputObj?.image_path === 'string' ? ctx.inputObj.image_path : ctx.path
  if (imgPath) return briefFull(imgPath)
  return null
}

/** 协作子任务族：步骤清单标题 / 完成汇报（输出优先，入参兜底）。 */
function subtaskBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj, output, shortLabel } = ctx
  if (toolKind === 'subtask_work_checklist') {
    const title = formatSubtaskWorkChecklistTitle(inputObj || {})
    return title.replace(/^执行步骤 · /, '').trim() || '更新步骤'
  }
  if (toolKind === 'subtask_outcome_report') {
    let outPreview = formatSubtaskOutcomeReportOutput(output, inputObj)
    if (!String(outPreview || '').trim()) {
      const rawOut = typeof output === 'string' ? String(output).trim() : ''
      if (rawOut) outPreview = rawOut
    }
    if (String(outPreview || '').trim()) {
      const firstLine = String(outPreview)
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
      if (firstLine) return briefFull(firstLine)
    }
    const outcomeTitle = formatSubtaskOutcomeReportTitle(inputObj || {})
    const stripped = outcomeTitle.replace(/^完成汇报 · /, '').trim() || '提交汇报'
    if (stripped === shortLabel) return ''
    return stripped
  }
  return null
}

/** 规划族：goal 优先，steps 数量次之，恒有产出。 */
function planBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'plan') return null
  const inputObj = ctx.inputObj
  const g = typeof inputObj?.goal === 'string' ? inputObj.goal.trim() : ''
  if (g) return briefFull(g)
  let steps: unknown = inputObj?.steps
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps)
    } catch {
      steps = null
    }
  }
  if (Array.isArray(steps) && steps.length) return `${steps.length} 个步骤`
  return '提交规划'
}

/** 场景/模式切换族。 */
function scenarioBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj } = ctx
  if (toolKind !== 'mode_set' && toolKind !== 'scenario' && toolKind !== 'scenario_activation') {
    return null
  }
  const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
  const key =
    typeof inputObj?.mode === 'string'
      ? inputObj.mode
      : typeof inputObj?.scenario_key === 'string'
        ? inputObj.scenario_key
        : ''
  const rs = typeof inputObj?.reason === 'string' ? inputObj.reason : ''
  if (act && key) return `${act} · ${key}`
  if (act && rs) return `${act} · ${briefFull(rs)}`
  if (act) return act
  if (key) return key
  return null
}

/** 协作/记忆/杂项族：list_agents、remember/recall、todo、automation、询问、agent 系列、trae、进程、诊断、思维导图。 */
function miscBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj, query, running, output, processSessionId } = ctx
  if (toolKind === 'list_agents') {
    const type = typeof inputObj?.task_type === 'string' ? inputObj.task_type : ''
    const q = typeof inputObj?.query === 'string' ? inputObj.query : ''
    if (type && q) return `${type} · ${briefFull(q)}`
    if (type) return type
    if (q) return briefFull(q)
    return null
  }
  // ── 记忆类 ──
  if (toolKind === 'remember' && typeof inputObj?.title === 'string') return briefFull(inputObj.title as string)
  if (toolKind === 'recall' && query) return briefFull(query)
  // ── 待办/自动化 ──
  if (toolKind === 'todo') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
    const cnt = typeof inputObj?.content === 'string' ? (inputObj.content as string) : ''
    if (act && cnt) return `${act}: ${briefFull(cnt)}`
    if (act) return act
    return null
  }
  if (toolKind === 'automation') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
    const nm = typeof inputObj?.name === 'string' ? (inputObj.name as string) : ''
    const sched = typeof inputObj?.schedule === 'string' ? inputObj.schedule as string : ''
    const aidRaw = inputObj?.id ?? inputObj?.task_id
    const aid = typeof aidRaw === 'string' ? aidRaw : ''
    if (act === 'create' && nm) return `${nm}${sched ? ` · ${briefFull(sched)}` : ''}`
    if (act && aid) return `${act}: ${briefFull(aid)}`
    if (act && nm) return `${act}: ${briefFull(nm)}`
    if (act) return act
    return null
  }
  // ── 询问 ──
  if (toolKind === 'ask_clarification' && typeof inputObj?.question === 'string') {
    return briefFull(inputObj.question as string)
  }
  // ── Agent 相关 ──
  if (toolKind === 'create_agent' || toolKind === 'update_agent') {
    const code = typeof inputObj?.agent_code === 'string' ? inputObj.agent_code : ''
    if (code) return briefFull(code)
    return null
  }
  if (toolKind === 'setup_agent' && typeof inputObj?.description === 'string') {
    return briefFull(inputObj.description as string)
  }
  if (toolKind === 'skill_manager') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
    const nm = typeof inputObj?.name === 'string' ? (inputObj.name as string) : ''
    if (act && nm) return `${act}: ${briefFull(nm)}`
    if (act) return act
    return null
  }
  if (toolKind === 'claude_session') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
    if (act === 'send') {
      const msg = typeof inputObj?.message === 'string' ? (inputObj.message as string) : ''
      if (msg) return briefFull(msg)
    }
    if (act === 'create') {
      const pp = typeof inputObj?.project_path === 'string' ? (inputObj.project_path as string) : ''
      if (pp) return briefFull(pp)
    }
    if (act) return act
    return null
  }
  // ── External CLI (legacy wire id: trae_*) ──
  if (toolKind === 'trae_delegate' && typeof inputObj?.prompt === 'string') return briefFull(inputObj.prompt as string)
  if (toolKind === 'trae_switch_mode' && typeof inputObj?.mode === 'string') return briefFull(inputObj.mode as string)
  if (toolKind === 'trae_start') {
    const ws = typeof inputObj?.workspace === 'string' ? inputObj.workspace : ''
    if (ws) return briefFull(ws)
    return null
  }
  // ── 进程 ──
  if (isProcessStartKind(toolKind, inputObj)) {
    const cmd = ctx.bashCommand || (typeof inputObj?.command === 'string' ? inputObj.command : null)
    if (cmd) return briefFull(cmd)
    return null
  }
  if (isProcessToolKind(toolKind) && !isProcessStartKind(toolKind, inputObj)) {
    const sid =
      processSessionId || (typeof inputObj?.session_id === 'string' ? inputObj.session_id : null)
    if (sid) return briefFull(sid)
    return null
  }
  // ── Lint ──
  if (toolKind === 'read_lints') {
    const inv = String(inputObj?.invocation_source || '').trim().toLowerCase()
    const p =
      typeof inputObj?.paths === 'string'
        ? inputObj.paths
        : Array.isArray(inputObj?.paths)
          ? (inputObj.paths as string[]).join(', ')
          : ''
    if (inv === 'post_edit') {
      const short = p ? p.replace(/\\/g, '/').split('/').pop() || p : ''
      return short ? `编辑后 · ${briefFull(short)}` : '编辑后诊断'
    }
    if (p) return briefFull(p)
    return null
  }
  // ── 思维导图 ──
  if (toolKind === 'mind_map') {
    const opsList = Array.isArray(inputObj?.ops) ? inputObj.ops : []
    if (running) {
      return opsList.length ? `${opsList.length} 个操作` : '更新导图…'
    }
    const outStr = typeof output === 'string' ? output : ''
    const appliedM = outStr.match(/applied=(\d+)/)
    if (appliedM) {
      const applied = parseInt(appliedM[1])
      return applied > 0 ? `已更新 ${applied} 个操作` : '无变更'
    }
    return opsList.length ? `${opsList.length} 个操作` : '更新导图'
  }
  return null
}

/** 进程类工具：process_ 前缀或 process 本身。 */
function isProcessToolKind(kind: string): boolean {
  const k = String(kind || '').trim().toLowerCase()
  return k === 'process' || k.startsWith('process_')
}

function isProcessStartKind(
  kind: string,
  inputObj: Record<string, unknown> | null | undefined,
): boolean {
  const k = String(kind || '').trim().toLowerCase()
  if (k === 'process_start') return true
  if (k === 'process') {
    const act = String(inputObj?.action ?? 'start').trim().toLowerCase()
    return act === 'start'
  }
  return false
}

/** 从 web_search 返回 JSON 解析结果条数（仅展示）。 */
function tryWebSearchResultCount(output: unknown): number | null {
  let obj: Record<string, unknown> | null = null
  if (output != null && typeof output === 'object' && !Array.isArray(output)) {
    obj = output as Record<string, unknown>
  } else if (typeof output === 'string') {
    const raw = output.trim()
    if (!raw || raw[0] !== '{') return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed
    } catch {
      return null
    }
  }
  if (!obj) return null
  const results = obj.results
  if (Array.isArray(results)) return results.length
  if (typeof results === 'number' && Number.isFinite(results) && results >= 0) return results
  return null
}

/** 浏览器族（browser / browser_*）：ZCode 风格步骤摘要（打开网页 · host / 点击元素 [e2] "提交"）。 */
function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return raw
  }
}

function browserBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj, output, running } = ctx
  if (toolKind !== 'browser' && !toolKind.startsWith('browser_')) return null
  const step = parseBrowserStepToolOutput(output)
  const act =
    (typeof inputObj?.action === 'string' && inputObj.action.trim().toLowerCase()) ||
    step?.action ||
    ''
  const actZh = (BROWSER_ACTION_ZH as Record<string, string>)[act] || act
  if (running && !step) {
    const urlArg = typeof inputObj?.url === 'string' ? inputObj.url.trim() : ''
    const host = urlArg ? hostFromUrl(urlArg) : ''
    return briefFull(`${actZh || '浏览器操作'}…${host ? ` ${host}` : ''}`)
  }
  if (step && step.ok === false) {
    const code = step.error?.code || 'error'
    return briefFull(`${actZh || step.action} · 失败（${code}）`)
  }
  if (step) {
    if (act === 'open' && step.url) {
      return briefFull(`${actZh || step.action} · ${hostFromUrl(step.url)}`)
    }
    const refTag = step.ref ? ` [${step.ref.replace(/^@/, '')}]` : ''
    const name = step.element?.name ? ` "${step.element.name}"` : ''
    return briefFull(`${actZh || step.action}${refTag}${name}`)
  }
  return null
}

/** supervisor 族：带 action 的任务编排工具（监控分支带倒计时）。 */
function supervisorBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'supervisor') return null
  const { inputObj, running, nowTs, timeValue, debugShowTaskIds } = ctx
  const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
  const actZh = act ? supervisorActionZh(act) : ''
  // 监控类：只显示轮询/倒计时信息，不展示任务 id（避免把内部 id 暴露给用户）
  if (act === 'monitor_execution_step' || act === 'monitor_execution') {
    const stepSecRaw =
      inputObj?.monitor_step_seconds ??
      inputObj?.monitorStepSeconds ??
      inputObj?.monitor_poll_seconds ??
      inputObj?.monitorPollSeconds
    const stepSec =
      typeof stepSecRaw === 'number' ? stepSecRaw : typeof stepSecRaw === 'string' ? Number(stepSecRaw) : NaN
    const baseTs = timeValue ? new Date(timeValue as string | number).getTime() : NaN
    if (running && Number.isFinite(stepSec) && stepSec > 0 && Number.isFinite(baseTs)) {
      const remain = Math.ceil(stepSec - ((nowTs ?? Date.now()) - baseTs) / 1000)
      if (remain > 0) return `${actZh} · ${remain}s`
    }
    // 到 0 后不再显示秒数
    return actZh || '监控执行进度'
  }
  if (act === 'create_task' || act === 'create_task_with_subtasks') {
    const tn = typeof inputObj?.task_name === 'string' ? (inputObj.task_name as string) : ''
    if (tn) return `${actZh} · ${briefFull(tn)}`
    const td = typeof inputObj?.task_description === 'string' ? (inputObj.task_description as string) : ''
    if (td) return `${actZh} · ${briefFull(td)}`
  }
  if (act === 'create_subtask') {
    const sn = typeof inputObj?.subtask_name === 'string' ? (inputObj.subtask_name as string) : ''
    if (sn) return `${actZh} · ${briefFull(sn)}`
  }
  if (act === 'create_subtasks') {
    const subs = inputObj?.subtasks
    if (Array.isArray(subs)) return `${actZh} · ${subs.length} 个子任务`
  }
  if (act === 'update_progress') {
    const prog = inputObj?.progress
    if (typeof prog === 'number') return `${actZh} · ${prog}%`
    if (typeof prog === 'string') return `${actZh} · ${prog}%`
  }
  if (act === 'complete_subtask') {
    const sid = typeof inputObj?.subtask_id === 'string' ? (inputObj.subtask_id as string) : ''
    if (debugShowTaskIds && sid) return `${actZh} · ${briefFull(sid)}`
    return actZh
  }
  if (act === 'start_execution') {
    const tid = typeof inputObj?.task_id === 'string' ? (inputObj.task_id as string) : ''
    if (debugShowTaskIds && tid) return `${actZh} · ${briefFull(tid)}`
    return actZh
  }
  if (act === 'continue_subtask_session') {
    const tid = typeof inputObj?.task_id === 'string' ? (inputObj.task_id as string) : ''
    if (debugShowTaskIds && tid) return `${actZh} · ${briefFull(tid)}`
    const msg = typeof inputObj?.agent_message === 'string' ? (inputObj.agent_message as string) : ''
    if (msg) return `${actZh} · ${briefFull(msg)}`
    return actZh
  }
  // get_status / list_subtasks / set_task_planned / set_task_state / monitor_execution_step / get_task_memory / monitor_execution
  const tid = typeof inputObj?.task_id === 'string' ? (inputObj.task_id as string) : ''
  const sid = typeof inputObj?.subtask_id === 'string' ? (inputObj.subtask_id as string) : ''
  if (debugShowTaskIds && tid) return `${actZh} · ${briefFull(tid)}`
  if (debugShowTaskIds && sid) return `${actZh} · ${briefFull(sid)}`
  if (actZh) return actZh
  if (act) return act
  return null
}

/** 子智能体委派族。 */
function subagentBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'subagent') return null
  const inputObj = ctx.inputObj
  const desc = typeof inputObj?.description === 'string' ? (inputObj.description as string) : ''
  if (desc.trim()) return briefFull(desc)
  const pr = typeof inputObj?.prompt === 'string' ? (inputObj.prompt as string) : ''
  if (pr.trim()) return briefFull(pr)
  return null
}

/** worker 批处理族：单任务显示动作+目标，多任务合并前两条。 */
function formatWorkerMultiTaskBrief(
  tasks: unknown[],
  running: boolean,
): string {
  const parts: string[] = []
  for (const raw of tasks) {
    if (!raw || typeof raw !== 'object') continue
    const task = raw as Record<string, unknown>
    const action = String(task.action || '').trim().toLowerCase()
    const label =
      (typeof task.query === 'string' && task.query.trim()) ||
      (typeof task.path === 'string' && task.path.trim()) ||
      (typeof task.instruction === 'string' && task.instruction.trim()) ||
      ''
    if (!label) continue
    if (action === 'search' || action === 'locate') parts.push(`搜索 · ${briefFull(label)}`)
    else if (action === 'write' || action === 'replace' || action === 'edit' || action === 'delete') {
      parts.push(`${workerFileActionBriefZh(action)} · ${briefFull(label)}`)
    } else {
      parts.push(briefFull(label))
    }
  }
  if (!parts.length) return running ? `${tasks.length} 项进行中` : `${tasks.length} 项`
  if (parts.length === 1) return parts[0]
  const head = parts.slice(0, 2).join(' · ')
  const rest = parts.length - 2
  return rest > 0 ? `${head} · +${rest}` : head
}

function workerBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'worker') return null
  const tasks = Array.isArray(ctx.inputObj?.tasks) ? ctx.inputObj.tasks : []
  if (tasks.length === 1) {
    const task = tasks[0] as Record<string, unknown>
    const action = String(task.action || '').trim().toLowerCase()
    const label =
      (typeof task.query === 'string' && task.query.trim()) ||
      (typeof task.path === 'string' && task.path.trim()) ||
      (typeof task.instruction === 'string' && task.instruction.trim()) ||
      ''
    if (label) {
      if (action === 'search' || action === 'locate') return `搜索 · ${briefFull(label)}`
      if (action === 'write' || action === 'replace' || action === 'edit' || action === 'delete') {
        return `${workerFileActionBriefZh(action)} · ${briefFull(label)}`
      }
      return briefFull(label)
    }
  }
  if (tasks.length > 1) {
    return formatWorkerMultiTaskBrief(tasks, ctx.running === true)
  }
  return null
}

/** ACP 外部智能体调用族。 */
function acpBrief(ctx: ToolCardBriefContext): string | null {
  const { toolKind, inputObj } = ctx
  if (toolKind !== 'invoke_acp_agent' && toolKind !== 'invoke_acp_agent_tool') return null
  const agent = typeof inputObj?.agent === 'string' ? inputObj.agent : ''
  const pr = typeof inputObj?.prompt === 'string' ? inputObj.prompt : ''
  if (agent && pr) return `${briefFull(agent)}: ${briefFull(pr)}`
  if (agent) return briefFull(agent)
  return null
}

/** 实体资产族：入参优先；历史回放从 output JSON 回填（含 search/read/list 各自形态）。 */
function assetsBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'assets') return null
  const { inputObj, output } = ctx
  const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : ''
  if (act) {
    const actZh = ASSETS_ACTION_ZH[act] || act
    if (act === 'search') {
      const q = typeof inputObj?.query === 'string' ? inputObj.query.trim() : ''
      if (q) return briefFull(`${actZh} · ${q}`)
    }
    if (act === 'read' || act === 'list') {
      const rel = typeof inputObj?.path === 'string' ? inputObj.path.trim() : ''
      if (rel) return briefFull(`${actZh} · ${rel}`)
    }
    if (act === 'note') {
      const text = (typeof inputObj?.content === 'string' && inputObj.content.trim())
        ? inputObj.content.trim()
        : (typeof inputObj?.query === 'string' && inputObj.query.trim() ? inputObj.query.trim() : '')
      if (text) return briefFull(`${actZh} · ${text}`)
    }
    if (act === 'profile') {
      const dim = typeof inputObj?.path === 'string' ? inputObj.path.trim() : ''
      const text = (typeof inputObj?.content === 'string' && inputObj.content.trim())
        ? inputObj.content.trim()
        : (typeof inputObj?.query === 'string' && inputObj.query.trim() ? inputObj.query.trim() : '')
      const bits = [actZh, dim && dim !== 'profile' ? dim : '', text].filter(Boolean)
      if (bits.length) return briefFull(bits.join(' · '))
    }
    return briefFull(actZh)
  }
  // ── 历史回放：output 是 JSON 字符串，含 action / path / matches 等 ──
  const rawOut = typeof output === 'string' ? output.trim() : ''
  if (rawOut) {
    let out: Record<string, unknown> | null = null
    try {
      const p = JSON.parse(rawOut)
      if (p && typeof p === 'object' && !Array.isArray(p)) out = p
    } catch {
      /* not json */
    }
    if (out) {
      const outAct = String(out.action || '').trim()
      const actZh = ASSETS_ACTION_ZH[outAct] || outAct
      const pathOut = String(out.path || '').trim()
      if (out.ok === false) {
        const err = String(out.error || '')
        return briefFull(err ? `${actZh || '资产'} · 失败：${err}` : `${actZh || '资产'} · 失败`)
      }
      if (outAct === 'search') {
        const matches = Array.isArray(out.matches) ? out.matches.length : 0
        const q = String(out.query || '').trim()
        const head = actZh ? actZh : 'search'
        if (matches > 0 && q) return briefFull(`${head} · ${q} · ${matches} 条`)
        if (matches > 0) return briefFull(`${head} · ${matches} 条`)
        if (q) return briefFull(`${head} · ${q} · 无结果`)
        return briefFull(`${head} · 无结果`)
      }
      if (outAct === 'read') {
        const body = String(out.content || '')
        const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean)
        const brief = firstLine || pathOut
        return brief ? briefFull(`${actZh} · ${brief}`) : briefFull(actZh)
      }
      if (outAct === 'list') {
        const entries = Array.isArray(out.entries) ? out.entries.length : 0
        const head = pathOut ? `${actZh} · ${pathOut}` : actZh
        return briefFull(entries ? `${head} · ${entries} 项` : head)
      }
      if (pathOut) return briefFull(`${actZh} · ${pathOut}`)
      if (actZh) return briefFull(actZh)
    }
    // 非 JSON 输出：取首行
    const firstLine = rawOut.split('\n').map((l) => l.trim()).find(Boolean)
    if (firstLine) return briefFull(firstLine)
  }
  return null
}

/** 任务看板族：入参摘要优先；缺入参时从 output 回填（重复调用拦截 / 首行）。 */
function tasksBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'tasks') return null
  const { inputObj, output } = ctx
  const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : ''
  const statusZh = typeof inputObj?.status_zh === 'string' ? inputObj.status_zh.trim() : ''
  const status = typeof inputObj?.status === 'string' ? inputObj.status.trim() : ''
  const summary = typeof inputObj?.summary === 'string' ? inputObj.summary.trim() : ''
  const prog = inputObj?.progress
  const bits = [
    act,
    prog != null && prog !== ''
      ? `${Number.isFinite(Number(prog)) ? Number(prog) : prog}%`
      : '',
    statusZh || status,
    summary,
  ].filter(Boolean)
  if (bits.length) return briefFull(bits.join(' · '))
  const rawOut = typeof output === 'string' ? output.trim() : ''
  if (rawOut) {
    if (/重复调用|已拦截/.test(rawOut)) return '重复调用已拦截'
    const firstLine = rawOut.split('\n').map((l) => l.trim()).find(Boolean)
    if (firstLine) return briefFull(firstLine)
  }
  return null
}

/** 平台动作卡族：保留 UI 标题优先；output JSON 的 ui.title / 待确认次之；入参 action 兜底。 */
function platformBrief(ctx: ToolCardBriefContext): string | null {
  if (ctx.toolKind !== 'platform') return null
  const { inputObj, output, platformUi } = ctx
  const preservedUi =
    platformUi && typeof platformUi === 'object' && !Array.isArray(platformUi)
      ? (platformUi as { title?: string })
      : null
  const preservedTitle = String(preservedUi?.title || '').trim()
  if (preservedTitle) return briefFull(preservedTitle)
  const rawOut = typeof output === 'string' ? output.trim() : ''
  if (rawOut) {
    try {
      const parsed = JSON.parse(rawOut) as { ui?: { title?: string }; action?: string; pending_confirm?: boolean }
      const uiTitle = String(parsed?.ui?.title || '').trim()
      if (uiTitle) return briefFull(uiTitle)
      if (parsed?.pending_confirm) {
        const act =
          typeof inputObj?.action === 'string' ? inputObj.action.trim() : String(parsed?.action || '').trim()
        return act ? `${act} · 待确认` : '待确认'
      }
    } catch {
      /* ignore */
    }
  }
  const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : ''
  if (act) return briefFull(act)
  return null
}

type ToolCardBriefEntry = {
  /** 精确 kind 集合（与 match 二选一） */
  kinds?: ReadonlySet<string>
  /** 前缀/自定义匹配（browser_* 这类带前缀族用） */
  match?: (toolKind: string) => boolean
  build: (ctx: ToolCardBriefContext) => string | null
}

/** 迁移顺序即匹配顺序；新迁移的族追加到此处。 */
const REGISTRY: ReadonlyArray<ToolCardBriefEntry> = [
  { kinds: TERMINAL_KINDS, build: terminalBrief },
  {
    kinds: new Set([...READ_KINDS, ...WRITE_DELETE_KINDS, ...LIST_KINDS]),
    build: fileBrief,
  },
  { kinds: SEARCH_KINDS, build: searchBrief },
  {
    kinds: new Set([
      'web_search',
      'web_fetch',
      'preview_url',
      'media_image_generate',
      'media_video_generate',
    ]),
    build: networkMediaBrief,
  },
  { kinds: new Set(['view_image']), build: viewImageBrief },
  { kinds: new Set(['subtask_work_checklist', 'subtask_outcome_report']), build: subtaskBrief },
  { kinds: new Set(['plan']), build: planBrief },
  { kinds: new Set(['mode_set', 'scenario', 'scenario_activation']), build: scenarioBrief },
  {
    kinds: new Set([
      'list_agents',
      'remember',
      'recall',
      'todo',
      'automation',
      'ask_clarification',
      'create_agent',
      'update_agent',
      'setup_agent',
      'skill_manager',
      'claude_session',
      'trae_delegate',
      'trae_switch_mode',
      'trae_start',
      'process',
      'process_start',
      'read_lints',
      'mind_map',
    ]),
    build: miscBrief,
  },
  {
    match: (k) => k === 'browser' || k.startsWith('browser_'),
    build: browserBrief,
  },
  { kinds: new Set(['supervisor']), build: supervisorBrief },
  { kinds: new Set(['subagent']), build: subagentBrief },
  { kinds: new Set(['worker']), build: workerBrief },
  { kinds: new Set(['invoke_acp_agent', 'invoke_acp_agent_tool']), build: acpBrief },
  { kinds: new Set(['assets']), build: assetsBrief },
  { kinds: new Set(['tasks']), build: tasksBrief },
  { kinds: new Set(['platform']), build: platformBrief },
]

/**
 * 注册表查询：命中且产出摘要 → 返回字符串；未命中 / 命中但无产出 → null
 * （调用方继续走遗留链，保证迁移期行为完全一致）。
 */
export function resolveRegisteredToolCardBrief(ctx: ToolCardBriefContext): string | null {
  for (const entry of REGISTRY) {
    const hit = entry.kinds
      ? entry.kinds.has(ctx.toolKind)
      : entry.match
        ? entry.match(ctx.toolKind)
        : false
    if (!hit) continue
    const brief = entry.build(ctx)
    if (brief != null) return brief
  }
  return null
}
