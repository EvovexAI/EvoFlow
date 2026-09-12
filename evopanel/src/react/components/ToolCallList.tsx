import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import {
  buildToolCallListRenderDiag,
  logStreamCompareToolRender,
} from '../lib/stream-compare-file-log.js'
import {
  extractPathFromToolInput,
  extractPathFromToolOutput,
  extractSessionIdFromToolInput,
  extractShellCommandFromToolInput,
  formatToolDisplayValue,
  formatToolOutputForUserDisplay,
  getToolInputObject,
  getToolInputObjectFromRow,
  getToolStreamingArgumentsRaw,
  isTerminalToolFailed,
  firstMeaningfulShellOutputLine,
  isToolRunning,
  parseMediaImagePreview,
  toolLabel,
  toolOmitFromChatPanel,
  toolOmitFromStreamingChatPanel,
  isGoalProposalToolName,
} from '../../lib/chat-normalize.js'
import {
  toolApprovalHintFromMeta,
} from '../../lib/tool-approval.js'
import { ToolApprovalPanel, type ToolApprovalChoice } from './ToolApprovalPanel.js'
import { WorkspaceDeliverableCard } from './WorkspaceDeliverableCard.js'

export type ToolApprovalHint = {
  tool_name?: string
  summary?: string
  args?: Record<string, unknown>
}
import {
  formatReadFileBriefWithSource,
  formatReadPathBrief,
  formatReadLineRangeLabel,
  formatSubagentTypeLabel,
  formatToolBriefDetail,
  pathLeafBrief,
  resolveEffectiveToolName,
  resolveToolKey,
  RETIRED_BROWSER_SKILL_TOOL_NAMES,
  supervisorActionZh,
  isSubagentDelegationToolName,
  toolShortLabel,
  workerFileActionBriefZh,
} from '../../lib/tool-display.js'
import { extractSubagentDisplayTextFromTool } from '../../lib/subagent-tool-display.js'
import { dedupeToolsByCallId, expandToolsWithPostSearchReads } from '../post-search-read-tools.js'
import {
  buildToolFilterMap,
  expandToolsForFilterResolution,
  resolveToolByFilterId,
} from '../lib/tool-filter-id-resolve.js'
import {
  formatSubtaskOutcomeReportOutput,
  formatSubtaskOutcomeReportTitle,
  formatSubtaskWorkChecklistOutput,
  formatSubtaskWorkChecklistTitle,
} from '../../lib/collab-tool-display.js'
import type { SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { PlanExecConfirm, type PlanExecConfirmProps } from './PlanExecConfirmDock.js'
import {
  canOpenPlatformFeedbackFromTool,
  requestOpenPlatformFeedbackFromTool,
} from '../../lib/right-stage/platform-feedback-bridge.js'
import { parsePlatformUiFeedbackFromTool } from '../../lib/right-stage/platform-feedback.js'
import { PlatformActionResultCard } from './PlatformActionResultCard.js'
import { MediaImagePreview } from './MediaImagePreview.js'
import { toolBreaksExploringGroup } from '../lib/exploring-activity-group.js'
import { ToolActivityFold } from './ToolActivityFold.js'
import { FileEditDiffModal, type FileEditDiffModalPayload } from './FileEditDiffModal.js'
import { FileEditDiffStatBrief } from './FileEditDiffPanel.js'
import {
  computeFileEditDiffStats,
  formatFileEditDiffStatBrief,
} from '../file-diff-util.js'
import { ToolResultDetailModal, type ToolResultMetaBlock } from './ToolResultDetailModal.js'
import { ViewImageDetailModal } from './ViewImageDetailModal.js'
import { SubagentTranscriptModal } from './SubagentTranscriptModal.js'
import { TerminalToolDetailModal } from './TerminalToolDetailModal.js'
import { SandboxBlockedCard } from './SandboxBlockedCard.js'
import { hasSandboxBlock } from '../../lib/sandbox-blocked-card.js'
import {
  cloneTerminalStreamTask,
  pickTerminalDisplayCommand,
  resolveTerminalStreamTask,
} from '../terminal-stream-merge.js'
import {
  isToolPendingApproval,
  parseToolApprovalFromTool,
} from '../../lib/tool-approval.js'
import { expandWorkerFilterIds, omitWorkerParentWhenExpanded } from '../worker-file-tools.js'

/** assets(action=…) 中文动作名（与后端 assets_tool 的 action 枚举一致） */
const ASSETS_ACTION_ZH: Record<string, string> = {
  search: '搜索资产',
  read: '读取资产',
  list: '列出资产',
  note: '记录笔记',
  profile: '更新画像',
}

/** 运行中工具名/摘要：逐字扫光；周期随字数变化，避免多波叠扫 */
function ToolRunningScanText({
  text,
  className,
  maxChars = 72,
}: {
  text: string
  className?: string
  maxChars?: number
}) {
  const raw = String(text || '')
  if (!raw) return null
  const chars = Array.from(raw)
  const head = chars.slice(0, Math.max(1, maxChars))
  const tail = chars.length > head.length ? chars.slice(head.length).join('') : ''
  const n = head.length
  // 字间步进 + 扫完后留白，保证下一轮开始前上一轮已结束
  const stepSec = 0.048
  const durationSec = Math.max(1.6, n * stepSec + 0.9)
  return (
    <span
      className={className ? `tool-running-scan ${className}` : 'tool-running-scan'}
      style={{
        ['--scan-dur' as string]: `${durationSec}s`,
        ['--scan-step' as string]: `${stepSec}s`,
      }}
    >
      {head.map((ch, i) => (
        <span key={i} className="tool-char-scan" style={{ ['--i' as string]: i }}>
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
      {tail}
    </span>
  )
}

function formatWorkerMultiTaskBrief(
  tasks: unknown[],
  briefFull: (s: string) => string,
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

function isProcessToolKind(kind: string): boolean {
  const k = String(kind || '').trim().toLowerCase()
  return k === 'process' || k.startsWith('process_')
}

function isProcessStartKind(kind: string, inputObj: Record<string, unknown> | null | undefined): boolean {
  const k = String(kind || '').trim().toLowerCase()
  if (k === 'process_start') return true
  if (k === 'process') {
    const act = String(inputObj?.action ?? 'start').trim().toLowerCase()
    return act === 'start'
  }
  return false
}

function pickProcessModalCommand(
  toolKind: string,
  inputObj: Record<string, unknown> | null | undefined,
  bashCommand: string | null,
  processSessionId: string | null,
): string {
  if (isProcessStartKind(toolKind, inputObj)) {
    return (
      String(bashCommand || '').trim() ||
      (typeof inputObj?.command === 'string' ? inputObj.command.trim() : '') ||
      ''
    )
  }
  const sid =
    String(processSessionId || '').trim() ||
    (typeof inputObj?.session_id === 'string' ? inputObj.session_id.trim() : '')
  return sid ? `session: ${sid}` : ''
}

export type PlanExecConfirmAnchor = PlanExecConfirmProps & {
  anchorToolCallId: string
  showStartExecution?: boolean
}

/** 入参丢失时，从 web_search 返回 JSON 中回显 query（仅展示） */
function tryWebSearchQueryFromOutput(output: unknown): string | null {
  if (output == null) return null
  if (typeof output === 'object' && !Array.isArray(output)) {
    const q = (output as Record<string, unknown>).query
    return typeof q === 'string' && q.trim() ? q.trim() : null
  }
  const raw = typeof output === 'string' ? output.trim() : ''
  if (!raw || raw[0] !== '{') return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const q = o.query
    return typeof q === 'string' && q.trim() ? q.trim() : null
  } catch {
    return null
  }
}

/** 从 web_search 返回 JSON 解析结果条数（仅展示） */
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

function formatTime(date: Date | number) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) return `${h}:${m}`
  const mon = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${mon}-${day} ${h}:${m}`
}

function parseToolTimeMs(value: unknown): number | null {
  if (value == null || value === '') return null
  const ts = value instanceof Date ? value.getTime() : new Date(value as any).getTime()
  return Number.isFinite(ts) ? ts : null
}

function formatToolElapsedSeconds(startTs: number, endTs: number): string {
  return `${Math.max(0, Math.floor((endTs - startTs) / 1000))}s`
}

/** 行内待授权：展开「需要权限」面板 */
function ToolApprovalInline({
  approval,
  tool,
  toolCallId,
  detailExtra,
  busy,
  onToolApproval,
}: {
  approval: Record<string, unknown>
  tool: Record<string, unknown>
  toolCallId: string
  detailExtra?: string
  busy?: boolean
  onToolApproval: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: ToolApprovalHint,
  ) => void
}) {
  const toolName = String(approval.tool_name || '').trim()
  const summary = String(approval.summary || '').trim()
  const onConfirm = (choice: ToolApprovalChoice) => {
    const hint = toolApprovalHintFromMeta(approval, tool)
    if (choice === 'deny') {
      void onToolApproval('deny', toolCallId)
      return
    }
    if (choice === 'always_project') {
      void onToolApproval('approve_remember', toolCallId, hint)
      return
    }
    void onToolApproval('approve', toolCallId, hint)
  }
  return (
    <div className="msg-tool-approval-inline">
      <ToolApprovalPanel
        toolName={toolName}
        summary={summary}
        detailExtra={detailExtra}
        busy={busy}
        onConfirm={onConfirm}
      />
    </div>
  )
}

function buildToolDetailMetaBlocks(
  toolKind: string,
  inputObj: Record<string, unknown>,
  path: string,
  query: string,
  url: string,
  inputJson: string,
): ToolResultMetaBlock[] {
  const blocks: ToolResultMetaBlock[] = []
  if (toolKind === 'read' || toolKind === 'read_file' || toolKind === 'read_files' || toolKind === 'read_context_slice') {
    blocks.push({
      title: '文件路径',
      value: path || String(inputObj?.path || inputObj?.file_path || inputJson || ''),
    })
    const hasRange =
      inputObj?.offset != null ||
      inputObj?.limit != null ||
      inputObj?.start_line != null ||
      inputObj?.end_line != null
    if (hasRange) {
      const range = formatReadLineRangeLabel(inputObj)
      blocks.push({
        title: '范围',
        value: range || `offset=${String(inputObj?.offset ?? inputObj?.start_line ?? '')} limit=${String(inputObj?.limit ?? inputObj?.end_line ?? '')}`,
      })
    }
    return blocks
  }
  if (toolKind === 'web_search') {
    blocks.push({ title: '查询', value: query || inputJson || '' })
    return blocks
  }
  if (toolKind === 'web_fetch' || toolKind === 'preview_url' || toolKind === 'fetch_url' || toolKind === 'fetch_url_tool') {
    blocks.push({ title: 'URL', value: url || inputJson || '' })
    return blocks
  }
  if (toolKind === 'search_code_index') {
    const q = typeof inputObj?.query === 'string' ? inputObj.query.trim() : ''
    const extra = Array.isArray(inputObj?.queries)
      ? (inputObj.queries as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
      : []
    const merged = [q, ...extra.filter((t) => t !== q)].filter(Boolean)
    blocks.push({ title: '查询', value: merged.length ? merged.join(' · ') : inputJson || '' })
    const ro = typeof inputObj?.read_offset === 'number' ? inputObj.read_offset : null
    const rl = typeof inputObj?.read_limit === 'number' ? inputObj.read_limit : null
    if (ro != null || rl != null) {
      const range = formatReadLineRangeLabel(
        { offset: ro, limit: rl },
      )
      blocks.push({ title: '读范围', value: range || `offset=${String(ro ?? '')} limit=${String(rl ?? '')}` })
    }
    return blocks
  }
  if (toolKind === 'search_content') {
    blocks.push({
      title: '搜索模式',
      value: typeof inputObj?.pattern === 'string' ? inputObj.pattern : inputJson || '',
    })
    blocks.push({
      title: '搜索范围',
      value: path || '当前会话绑定的工作区（由后台解析）',
    })
    return blocks
  }
  if (toolKind === 'grep' || toolKind === 'rg' || toolKind === 'find_file') {
    blocks.push({
      title: toolKind === 'find_file' ? '文件名模式' : '搜索模式',
      value: typeof inputObj?.pattern === 'string' ? inputObj.pattern : inputJson || '',
    })
    const scopeRaw =
      typeof inputObj?.path === 'string'
        ? inputObj.path
        : typeof inputObj?.glob === 'string'
          ? inputObj.glob
          : path
    if (scopeRaw) blocks.push({ title: '搜索范围', value: scopeRaw })
    return blocks
  }
  if (toolKind === 'ls' || toolKind === 'list_dir') {
    blocks.push({
      title: '目录路径',
      value: path || String(inputObj?.path || inputObj?.directory || inputJson || ''),
    })
    return blocks
  }
  if (toolKind === 'read_lints') {
    const pathsRaw =
      typeof inputObj?.paths === 'string'
        ? inputObj.paths
        : Array.isArray(inputObj?.paths)
          ? (inputObj.paths as unknown[]).map((x) => String(x || '').trim()).filter(Boolean).join(', ')
          : path || String(inputObj?.path || '')
    if (pathsRaw) blocks.push({ title: '检查范围', value: pathsRaw })
    const inv = String(inputObj?.invocation_source || '').trim()
    if (inv) blocks.push({ title: '来源', value: inv })
    return blocks
  }
  if (toolKind === 'assets') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : ''
    if (act) {
      const actZh = ASSETS_ACTION_ZH[act] || act
      blocks.push({ title: '操作', value: actZh })
      if (act === 'search') {
        const q = typeof inputObj?.query === 'string' ? inputObj.query.trim() : ''
        const kinds = typeof inputObj?.kinds === 'string' ? inputObj.kinds.trim() : ''
        if (q) blocks.push({ title: '查询', value: q })
        if (kinds) blocks.push({ title: '范围', value: kinds })
      } else if (act === 'read' || act === 'list') {
        const rel = typeof inputObj?.path === 'string' ? inputObj.path.trim() : ''
        if (rel) blocks.push({ title: '路径', value: rel })
      } else if (act === 'note' || act === 'profile') {
        const text =
          (typeof inputObj?.content === 'string' && inputObj.content.trim())
            ? inputObj.content.trim()
            : (typeof inputObj?.query === 'string' ? inputObj.query.trim() : '')
        const rel = typeof inputObj?.path === 'string' ? inputObj.path.trim() : ''
        if (rel && act === 'profile') blocks.push({ title: '维度', value: rel })
        if (text) blocks.push({ title: '内容', value: text })
      }
      if (inputJson.trim() && inputJson.trim() !== '{}') {
        blocks.push({ title: '参数', value: inputJson })
      }
      return blocks
    }
  }
  if (RETIRED_BROWSER_SKILL_TOOL_NAMES.has(toolKind)) {
    blocks.push({ title: '参数', value: inputJson || formatToolDisplayValue(inputObj) || '—' })
    return blocks
  }
  const genericInput =
    inputJson.trim() && inputJson.trim() !== '{}' ? inputJson : formatToolDisplayValue(inputObj) || ''
  if (toolKind === 'worker') {
    const tasks = Array.isArray(inputObj?.tasks) ? inputObj.tasks : []
    for (let i = 0; i < tasks.length; i++) {
      const raw = tasks[i]
      if (!raw || typeof raw !== 'object') continue
      const task = raw as Record<string, unknown>
      const action = String(task.action || '').trim()
      const label =
        (typeof task.query === 'string' && task.query.trim()) ||
        (typeof task.path === 'string' && task.path.trim()) ||
        (typeof task.instruction === 'string' && task.instruction.trim()) ||
        ''
      const line = [action, label].filter(Boolean).join(' · ') || JSON.stringify(task, null, 2)
      blocks.push({ title: tasks.length > 1 ? `任务 ${i + 1}` : '任务', value: line })
    }
    if (genericInput) blocks.push({ title: '完整参数', value: genericInput })
    return blocks
  }
  if (toolKind === 'plan') {
    const goal = typeof inputObj?.goal === 'string' ? inputObj.goal.trim() : ''
    if (goal) blocks.push({ title: '目标', value: goal })
  } else if (toolKind === 'supervisor') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
    if (act) blocks.push({ title: '操作', value: supervisorActionZh(act) || act })
  } else if (toolKind === 'tasks' || toolKind === 'knowledge' || toolKind === 'platform') {
    const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : ''
    if (act) blocks.push({ title: '操作', value: act })
    if (toolKind === 'platform') {
      const uiTitle = (() => {
        const raw = typeof inputObj?.ui_title === 'string' ? inputObj.ui_title : ''
        if (raw.trim()) return raw.trim()
        return ''
      })()
      if (uiTitle) blocks.push({ title: '结果', value: uiTitle })
    }
    const statusZh = typeof inputObj?.status_zh === 'string' ? inputObj.status_zh.trim() : ''
    const status = typeof inputObj?.status === 'string' ? inputObj.status.trim() : ''
    if (statusZh || status) blocks.push({ title: '状态', value: statusZh || status })
    if (inputObj?.progress != null && inputObj.progress !== '') {
      const n = Number(inputObj.progress)
      blocks.push({
        title: '进度',
        value: Number.isFinite(n) ? `${n}%` : String(inputObj.progress),
      })
    }
    const summary = typeof inputObj?.summary === 'string' ? inputObj.summary.trim() : ''
    if (summary) blocks.push({ title: '摘要', value: summary })
    const title = typeof inputObj?.name === 'string'
      ? inputObj.name.trim()
      : typeof inputObj?.title === 'string'
        ? inputObj.title.trim()
        : ''
    if (title) blocks.push({ title: '任务', value: title })
    const err = typeof inputObj?.error === 'string' ? inputObj.error.trim() : ''
    if (err) blocks.push({ title: '错误', value: err })
  }
  if (!blocks.length && genericInput) blocks.push({ title: '参数', value: genericInput })
  return blocks
}

function toolDetailContentTitle(toolKind: string): string {
  if (toolKind === 'plan') return '计划结果'
  if (toolKind === 'supervisor') return '调度结果'
  if (toolKind === 'platform') return '平台操作结果'
  if (toolKind === 'web_search') return '搜索结果'
  if (toolKind === 'web_fetch' || toolKind === 'preview_url' || toolKind === 'fetch_url' || toolKind === 'fetch_url_tool') {
    return '抓取结果'
  }
  if (toolKind === 'grep' || toolKind === 'rg' || toolKind === 'search_code_index' || toolKind === 'search_content' || toolKind === 'find_file') {
    return '结果'
  }
  if (toolKind === 'ls' || toolKind === 'list_dir') return '目录列表'
  if (toolKind === 'read_lints') return '诊断结果'
  if (RETIRED_BROWSER_SKILL_TOOL_NAMES.has(toolKind)) return '历史结果'
  if (toolKind === 'worker') return '执行结果'
  return '内容'
}

function isFileEditToolKind(toolKind: string): boolean {
  return (
    toolKind === 'write' ||
    toolKind === 'replace' ||
    toolKind === 'delete' ||
    toolKind === 'write_file' ||
    toolKind === 'str_replace' ||
    toolKind === 'write_to_file' ||
    toolKind === 'replace_in_file' ||
    toolKind === 'delete_file'
  )
}

function fileEditActionFromToolKind(toolKind: string): string {
  if (toolKind === 'delete' || toolKind === 'delete_file') return 'delete'
  if (toolKind === 'write' || toolKind === 'write_file' || toolKind === 'write_to_file') return 'write'
  return 'replace'
}

function fileNameFromPath(path: string): string {
  return pathLeafBrief(path) || String(path || '').trim()
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 历史落库工具可能无 tool_call_id，但 output 已嵌在消息里，仍应弹窗展示。 */
function toolHasPersistedDetailOutput(tool: Record<string, unknown>): boolean {
  const out = tool.output ?? tool.result
  if (out == null || out === '') return false
  if (typeof out === 'string') return out.trim().length > 0
  if (Array.isArray(out)) return out.length > 0
  if (typeof out === 'object') return Object.keys(out as object).length > 0
  return true
}

function ToolCallCollapsible({
  toolKind,
  running,
  failed = false,
  summary,
  body,
  defaultOpen = false,
  inActivityFold = false,
  foldInteractive = false,
  modalOnExpand,
  modalOpenWhileRunning = false,
}: {
  toolKind: string
  running: boolean
  failed?: boolean
  summary: ReactNode
  body: ReactNode
  /** 默认展开（如 subagent 委派） */
  defaultOpen?: boolean
  /** 收在 Exploring 折叠区内：紧凑单行、弱化已完成项 */
  inActivityFold?: boolean
  /** Exploring 内可点击：终端展开 / 弹窗工具 */
  foldInteractive?: boolean
  /** 点击展开时打开弹窗，不在行内展示 body（read 工具） */
  modalOnExpand?: () => void
  /** 执行中仍允许点击打开弹窗（文件 diff 流式预览） */
  modalOpenWhileRunning?: boolean
}) {
  const isPlan = toolKind === 'plan'
  const [open, setOpen] = useState(isPlan ? false : Boolean(defaultOpen))
  useEffect(() => {
    if (defaultOpen && !modalOnExpand) queueMicrotask(() => setOpen(true))
  }, [defaultOpen, modalOnExpand])
  return (
    <details
      className={`msg-tool-item${running ? ' msg-tool-item--running' : ''}${
        failed ? ' msg-tool-item--failed' : ''
      } msg-tool-item--${toolKind}${
        inActivityFold ? ' msg-tool-item--in-fold' : ''
      }${inActivityFold && !running ? ' msg-tool-item--in-fold-done' : ''}${
        foldInteractive ? ' msg-tool-item--fold-interactive' : ''
      }${modalOnExpand ? ' msg-tool-item--modal-trigger' : ''}`}
      open={modalOnExpand ? false : open}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => {
        if (modalOnExpand) {
          const wantsOpen = e.currentTarget.open
          e.preventDefault()
          e.currentTarget.open = false
          if (wantsOpen && (!running || modalOpenWhileRunning)) modalOnExpand()
          return
        }
        setOpen(e.currentTarget.open)
      }}
    >
      {summary}
      {!modalOnExpand && open ? <div className="msg-tool-body">{body}</div> : null}
    </details>
  )
}

function resolveSubagentStreamTask(
  subagentTasks: Record<string, SubagentStreamTask> | undefined,
  toolCallId: string,
): SubagentStreamTask | undefined {
  if (!subagentTasks || !toolCallId) return undefined
  if (subagentTasks[toolCallId]) return subagentTasks[toolCallId]
  const hit = Object.values(subagentTasks).find(
    (t) => t.taskId === toolCallId || t.taskExecId === toolCallId || t.collabSubtaskId === toolCallId,
  )
  return hit
}

function ToolCallListInner({
  tools,
  filterIds,
  liveOutput: _liveOutput,
  subagentTasks,
  terminalStreams,
  planExecConfirm,
  onToolApproval,
  toolApprovalBusy,
  /** 仅当前可操作轮次为 true；历史落库轮次只显示「曾待授权」摘要 */
  interactiveToolApproval = true,
  variant = 'default',
  hideSubagentInnerTools = false,
  /** 主会话：多工具收成「过程折叠」滚动区；授权/plan/子智能体等仍单独展示 */
  activityGrouped = true,
  /** 已由外层 Exploring 包裹（与 activityGrouped 互斥） */
  nestedInExploring = false,
  isStreaming = false,
  /** 实时轮次/目标执行：展示工具耗时（与 isStreaming 解耦，历史落库为 false） */
  showToolTiming = false,
  /** 按需拉取完整工具结果（大 read/search 等；terminal 不走此路径） */
  sessionKey,
  compareLogSource,
  compareSessionKey,
  /** mind_map 工具行点击：打开右侧思维导图面板（与顶栏按钮一致） */
  onOpenKnowledgeMap,
}: {
  tools?: unknown[]
  /** 若提供，仅按该顺序展示对应 id 的工具（用于交错 segments） */
  filterIds?: string[]
  /** 子任务实时输出（用于 claude_session 工具展开时显示实际内容） */
  liveOutput?: string
  /** 与 tool_call_id 对齐的 subagent 流式聚合（task_started / task_running / …） */
  subagentTasks?: Record<string, SubagentStreamTask>
  /** 与 tool_call_id 对齐的 terminal 流式聚合（terminal_start / stdout / stderr / exit） */
  terminalStreams?: Record<string, TerminalStreamTask>
  /** 挂在对应 plan 工具块下方的「开始执行」确认（非底部浮层） */
  planExecConfirm?: PlanExecConfirmAnchor | null
  /** 已授权执行时勿在气泡内重复渲染子智能体工具链（见侧栏） */
  hideSubagentInnerTools?: boolean
  /** 工具行内批准 / 拒绝 / 全部授权（附在对应工具右侧） */
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: ToolApprovalHint,
  ) => void
  toolApprovalBusy?: boolean
  interactiveToolApproval?: boolean
  /** 嵌在子智能体展开区内：样式与主会话工具条一致 */
  variant?: 'default' | 'subagent-inner'
  activityGrouped?: boolean
  nestedInExploring?: boolean
  isStreaming?: boolean
  showToolTiming?: boolean
  sessionKey?: string
  compareLogSource?: string
  compareSessionKey?: string
  onOpenKnowledgeMap?: () => void
}) {
  void hideSubagentInnerTools
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [lazyDetailModal, setLazyDetailModal] = useState<{
    toolCallId: string
    title: string
    toolKind: string
    metaBlocks: ToolResultMetaBlock[]
    contentTitle: string
    tool: Record<string, unknown>
  } | null>(null)
  const [viewImageModal, setViewImageModal] = useState<{
    toolCallId: string
    title: string
    imagePath: string
    outputText: string
  } | null>(null)
  const [fileEditModal, setFileEditModal] = useState<FileEditDiffModalPayload | null>(null)
  const [toolStartTimes, setToolStartTimes] = useState<Map<string, number>>(new Map())
  const [toolEndTimes, setToolEndTimes] = useState<Map<string, number>>(new Map())
  /** Completed terminal panels keep a frozen snapshot — live map updates must not bleed upward. */
  const [frozenTerminals, setFrozenTerminals] = useState<Record<string, TerminalStreamTask>>({})
  /** 子智能体对话弹窗：task_id -> title（含流式 liveOutput 兜底，避免内存 transcript 为空） */
  const [transcriptModal, setTranscriptModal] = useState<{
    taskId: string
    title?: string
    fallbackText?: string
    fallbackTools?: unknown[]
    fallbackStatus?: string
  } | null>(null)
  /** 终端工具详情弹窗：行只显示命令摘要，点击后弹窗看完整输出（支持运行中实时刷新） */
  const [terminalModal, setTerminalModal] = useState<{
    toolCallId: string
    title: string
    command: string
    outputFallback: string
  } | null>(null)
  // Stable close/approval handlers — prevent memo'd modals from re-rendering on every stream tick (~450ms)
  const handleCloseLazyDetail = useCallback(() => setLazyDetailModal(null), [])
  const handleCloseViewImage = useCallback(() => setViewImageModal(null), [])
  const handleCloseFileEdit = useCallback(() => setFileEditModal(null), [])
  const handleCloseTranscript = useCallback(() => setTranscriptModal(null), [])
  const handleCloseTerminal = useCallback(() => setTerminalModal(null), [])
  const debugShowTaskIds = (() => {
    try {
      return localStorage.getItem('EVOFLOW_DEBUG_SHOW_TASK_ID') === '1'
    } catch {
      return false
    }
  })()
  const safeToolKind = (name: unknown) => {
    const s = String(name || '').trim()
    if (!s) return 'tool'
    return s.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  }

  const list = useMemo(() => {
    const baseTools = expandToolsForFilterResolution(tools || [])
    let next: unknown[] = isStreaming
      ? dedupeToolsByCallId(baseTools)
      : expandToolsWithPostSearchReads(baseTools)
    next = omitWorkerParentWhenExpanded(next)
    if (filterIds?.length) {
      const m = buildToolFilterMap(baseTools)
      const resolveFilteredTool = (fid: string): unknown | undefined =>
        resolveToolByFilterId(baseTools, fid, m)
      const seenFilter = new Set<string>()
      const orderedIds: string[] = []
      for (const fid of expandWorkerFilterIds(filterIds, baseTools)) {
        const id = String(fid).trim()
        if (!id || seenFilter.has(id)) continue
        seenFilter.add(id)
        orderedIds.push(id)
      }
      next = dedupeToolsByCallId(
        orderedIds.map((fid) => resolveFilteredTool(fid)).filter(Boolean) as unknown[],
      )
      if (!next.length) {
        next = orderedIds
          .map((fid) => {
            const hit = resolveFilteredTool(fid)
            if (hit) return hit
            return {
              id: fid,
              tool_call_id: fid,
              name: '工具',
              status: isStreaming ? 'running' : 'completed',
              _streamToolPending: isStreaming,
              _filterIdStub: !isStreaming,
            }
          })
          .filter(Boolean) as unknown[]
      }
    }
    return next
  }, [tools, filterIds, isStreaming])

  const renderDiag = useMemo(
    () =>
      compareLogSource
        ? buildToolCallListRenderDiag({
            tools,
            filterIds,
            list,
            isStreaming,
            activityGrouped,
            nestedInExploring,
            planExecConfirm,
          })
        : null,
    [
      compareLogSource,
      tools,
      filterIds,
      list,
      isStreaming,
      activityGrouped,
      nestedInExploring,
      planExecConfirm,
    ],
  )

  useEffect(() => {
    if (!compareLogSource || !renderDiag) return
    logStreamCompareToolRender({
      sessionKey: compareSessionKey,
      source: compareLogSource,
      diag: renderDiag,
    })
  }, [compareLogSource, compareSessionKey, renderDiag])

  const hasRunningTools = useMemo(() => list.some((tool) => isToolRunning(tool)), [list])

  const hasLiveToolTicker = useMemo(() => {
    if (showToolTiming && hasRunningTools) return true
    for (const tool of list) {
      if (isToolRunning(tool)) return true
      const t = tool as Record<string, unknown>
      const rawName = t.name ?? t.tool_name ?? t.toolName
      const toolName = String(rawName != null && String(rawName).trim() ? rawName : 'tool')
      const toolKind = safeToolKind(toolName)
      if (toolKind !== 'supervisor') continue
      const inputObj = getToolInputObject(t.input) as Record<string, unknown> | null
      const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
      if (act !== 'monitor_execution_step' && act !== 'monitor_execution') continue
      const timeValue = (t.time || t.messageTimestamp) as number | string | undefined
      const baseTs = parseToolTimeMs(timeValue)
      if (!Number.isFinite(baseTs)) continue
      const stepSecRaw =
        inputObj?.monitor_step_seconds ??
        inputObj?.monitorStepSeconds ??
        inputObj?.monitor_poll_seconds ??
        inputObj?.monitorPollSeconds
      const stepSec = typeof stepSecRaw === 'number' ? stepSecRaw : typeof stepSecRaw === 'string' ? Number(stepSecRaw) : NaN
      if (!Number.isFinite(stepSec) || stepSec <= 0) continue
      const remain = Math.ceil(stepSec - (nowTs - (baseTs as number)) / 1000)
      if (remain > 0) return true
    }
    return false
  }, [list, showToolTiming, hasRunningTools])

  useEffect(() => {
    if (!showToolTiming) {
      queueMicrotask(() => {
        setToolStartTimes(new Map())
        setToolEndTimes(new Map())
      })
    }
  }, [showToolTiming])

  // Freeze completed terminal streams to prevent live map updates from bleeding into finished panels
  useEffect(() => {
    queueMicrotask(() => {
      setFrozenTerminals((prev) => {
        const next = { ...prev }
        for (const tool of list) {
          const t = tool as Record<string, unknown>
          const toolCallId =
            t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
              ? String(t.tool_call_id).trim()
              : t.id != null && String(t.id).trim() !== ''
                ? String(t.id).trim()
                : ''
          const key = toolCallId || ''
          const rawTerminalStream = resolveTerminalStreamTask(terminalStreams, t)
          const freezeKey = `${key}@${list.indexOf(tool)}`
          const running = !isToolPendingApproval(t) && isToolRunning(tool)
          if (running) {
            delete next[freezeKey]
          } else if (rawTerminalStream && !next[freezeKey]) {
            next[freezeKey] = cloneTerminalStreamTask(rawTerminalStream)
          }
        }
        return next
      })
    })
  }, [list, terminalStreams])

  useEffect(() => {
    if (!hasLiveToolTicker) return
    const t = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [hasLiveToolTicker])

  // Keep FileEditDiffModal payload fresh *only if user already opened it manually*.
  // We do NOT auto-open — progress is shown inline in the tool row summary so users
  // can see writes happening without a modal popping up in their face.
  useEffect(() => {
    if (variant === 'subagent-inner') return
    if (!fileEditModal?.toolCallId) return // nothing to keep alive
    let matched: Record<string, unknown> | null = null
    for (const tool of list) {
      const t = tool as Record<string, unknown>
      const tcid =
        t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
          ? String(t.tool_call_id).trim()
          : t.id != null && String(t.id).trim() !== ''
            ? String(t.id).trim()
            : ''
      if (tcid === fileEditModal.toolCallId) { matched = t; break }
    }
    if (!matched) return
    const wp = matched._writeProgress && typeof matched._writeProgress === 'object'
      ? (matched._writeProgress as Record<string, unknown>)
      : null
    if (!wp) return
    const toolKind = resolveToolKey(matched)
    const inputObj = getToolInputObjectFromRow(matched) as Record<string, unknown> | null
    const content =
      (typeof wp?.content === 'string' ? wp.content : '') ||
      (typeof inputObj?.content === 'string' ? inputObj.content : undefined) ||
      ''
    const old_string =
      (typeof wp?.old_string === 'string' ? wp.old_string : '') ||
      (typeof inputObj?.old_string === 'string' ? inputObj.old_string : undefined)
    const new_string =
      (typeof wp?.new_string === 'string' ? wp.new_string : '') ||
      (typeof wp?.content === 'string' ? wp.content : '') ||
      (typeof inputObj?.new_string === 'string' ? inputObj.new_string : undefined)
    queueMicrotask(() => {
      setFileEditModal((prev) => {
        if (!prev || prev.toolCallId !== fileEditModal.toolCallId) return prev
        return {
          ...prev,
          // Prefer live body; never fall back to a previous tool's content.
          ...(content ? { content } : {}),
          ...(old_string ? { old_string } : {}),
          ...(new_string ? { new_string } : {}),
          running: !isToolPendingApproval(matched) && isToolRunning(matched),
          phase: typeof wp?.phase === 'string' ? wp.phase : prev.phase,
          bytes_total: typeof wp?.bytes_total === 'number' ? wp.bytes_total : prev.bytes_total,
          bytes_written: typeof wp?.bytes_written === 'number' ? wp.bytes_written : prev.bytes_written,
          lines_added: typeof wp?.lines_added === 'number' ? wp.lines_added : prev.lines_added,
          lines_removed: typeof wp?.lines_removed === 'number' ? wp.lines_removed : prev.lines_removed,
          content_len: typeof wp?.content_len === 'number' ? wp.content_len : prev.content_len,
          message: typeof wp?.message === 'string' ? wp.message : prev.message,
          path:
            (typeof wp?.path === 'string' && wp.path.trim()) ||
            (typeof inputObj?.path === 'string' && inputObj.path.trim()) ||
            prev.path,
        }
      })
    })
  }, [list, fileEditModal?.toolCallId, variant])

  if (!list.length && !planExecConfirm) return null

  const toolRootClass =
    variant === 'subagent-inner'
      ? 'msg-tool react-msg-tool react-msg-tool--subagent-inner'
      : 'msg-tool react-msg-tool'

  const useActivityFold =
    !nestedInExploring &&
    variant === 'default' &&
    activityGrouped !== false &&
    list.length > 0 &&
    !list.some((t) => toolBreaksExploringGroup(t, interactiveToolApproval))

  /** 平台 Action Result 提到折叠外，始终可见（Exploring 外层 fold 在 PlatformResultCards 渲染） */
  const hoistPlatformResults = useActivityFold
  const platformResultTools = list.filter((tool) => {
    const row = tool as Record<string, unknown>
    if (resolveToolKey(row) !== 'platform') return false
    if (isToolPendingApproval(row) || isToolRunning(tool)) return false
    return Boolean(parsePlatformUiFeedbackFromTool(row))
  })

  const toolListBody = (
    <div
      className={`${toolRootClass}${useActivityFold || nestedInExploring ? ' msg-tool--in-activity-fold' : ''}`}
    >
      {list.map((tool, i) => {
        const t = tool as Record<string, unknown>
        const pendingApproval = isToolPendingApproval(t)
        const showInteractiveApproval = pendingApproval && interactiveToolApproval
        const running = !pendingApproval && isToolRunning(tool)
        const approvalMeta = pendingApproval ? parseToolApprovalFromTool(t) : null
        const timeValue = (t.time || t.messageTimestamp) as number | string | undefined
        const timeText = timeValue ? formatTime(new Date(timeValue)) : ''
        const toolName = resolveEffectiveToolName(t)
        const toolKind = isSubagentDelegationToolName(t) ? 'subagent' : resolveToolKey(t)
        const toolCallId =
          t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
            ? String(t.tool_call_id).trim()
            : t.id != null && String(t.id).trim() !== ''
              ? String(t.id).trim()
              : ''
        const key = toolCallId || `t-${i}`
        const timeTs = parseToolTimeMs(timeValue)
        const isShellTool =
          toolKind === 'bash' || toolKind === 'execute_command' || toolKind === 'terminal'
        const isTerminalModalTool = isShellTool || isProcessToolKind(toolKind)
        const isWriteOrEditTool =
          toolKind === 'write' ||
          toolKind === 'replace' ||
          toolKind === 'write_file' ||
          toolKind === 'str_replace' ||
          toolKind === 'write_to_file' ||
          toolKind === 'replace_in_file'
        const rawTerminalStream = resolveTerminalStreamTask(terminalStreams, t)
        const freezeKey = `${toolCallId || key}@${i}`
        let terminalStream = rawTerminalStream
        if (!running && rawTerminalStream) {
          // Use frozen snapshot if available
          terminalStream = frozenTerminals[freezeKey] ?? rawTerminalStream
        } else if (!running && frozenTerminals[freezeKey]) {
          terminalStream = frozenTerminals[freezeKey]
        }

        let elapsedText = ''
        let displayTimeText = ''
        if (showToolTiming) {
          // Always surface the absolute clock when we have one (history trail needs
          // per-call times; completed tools previously only showed elapsed).
          displayTimeText = timeText
          const uiStartedTs = parseToolTimeMs(t._uiStartedAtMs)
          const uiEndedTs = parseToolTimeMs(t._uiEndedAtMs)
          const streamStartTs = rawTerminalStream?.startedAt
            ? parseToolTimeMs(rawTerminalStream.startedAt)
            : null
          const streamEndTs = rawTerminalStream?.endedAt
            ? parseToolTimeMs(rawTerminalStream.endedAt)
            : null
          let toolStartTs =
            uiStartedTs ?? streamStartTs ?? toolStartTimes.get(key) ?? null

          if (running) {
            if (!toolStartTs) {
              toolStartTs = timeTs ?? nowTs
              queueMicrotask(() => setToolStartTimes((prev) => { const m = new Map(prev); m.set(key, toolStartTs!); return m }))
            }
            if (toolEndTimes.has(key)) {
              queueMicrotask(() => setToolEndTimes((prev) => { const m = new Map(prev); m.delete(key); return m }))
            }
            if (toolStartTs) {
              elapsedText = formatToolElapsedSeconds(toolStartTs, nowTs)
            }
          } else {
            let toolEndTs =
              uiEndedTs ?? streamEndTs ?? toolEndTimes.get(key) ?? null
            if (toolStartTs && !toolEndTs && toolStartTimes.has(key)) {
              queueMicrotask(() => setToolEndTimes((prev) => { const m = new Map(prev); m.set(key, nowTs); return m }))
              toolEndTs = nowTs
            }
            if (toolStartTs && toolEndTs) {
              elapsedText = formatToolElapsedSeconds(toolStartTs, toolEndTs)
            }
          }
        }
        const inActivityFoldRow = useActivityFold || nestedInExploring
        const streamTask = resolveSubagentStreamTask(subagentTasks, toolCallId)
        const titleText = toolLabel(t)
        const inputObj = getToolInputObjectFromRow(t) as Record<string, unknown> | null
        if (toolKind === 'ask_clarification' || isGoalProposalToolName(toolKind)) {
          return null
        }
        if (toolOmitFromChatPanel(t as Record<string, unknown>)) {
          return null
        }
        if (
          isStreaming &&
          toolOmitFromStreamingChatPanel(t as Record<string, unknown>) &&
          !nestedInExploring &&
          !(t as Record<string, unknown>)._aguiPhase &&
          !(t as Record<string, unknown>)._aguiTracked
        ) {
          return null
        }
        const aguiPhase = (t as Record<string, unknown>)._aguiPhase as string | undefined
        const isFileEditStatTool =
          isWriteOrEditTool || toolKind === 'delete' || toolKind === 'delete_file'
        const fileEditAction = isFileEditStatTool ? fileEditActionFromToolKind(toolKind) : ''
        const writeProgress =
          t._writeProgress && typeof t._writeProgress === 'object'
            ? (t._writeProgress as {
                path?: string
                tool_name?: string
                phase?: 'args' | 'writing' | 'done' | 'error' | string
                lines_added?: number
                lines_removed?: number
                bytes_total?: number
                bytes_written?: number
                message?: string
                content?: string
                old_string?: string
                new_string?: string
                content_len?: number
              })
            : null
        const streamedWriteContent =
          typeof writeProgress?.content === 'string' && writeProgress.content
            ? writeProgress.content
            : ''
        const streamedOldString =
          typeof writeProgress?.old_string === 'string' && writeProgress.old_string
            ? writeProgress.old_string
            : ''
        const streamedNewString =
          typeof writeProgress?.new_string === 'string' && writeProgress.new_string
            ? writeProgress.new_string
            : ''
        const fileEditContent =
          streamedWriteContent ||
          (typeof inputObj?.content === 'string' ? inputObj.content : undefined)
        const fileEditOldString =
          streamedOldString ||
          (typeof inputObj?.old_string === 'string' ? inputObj.old_string : undefined)
        const fileEditNewString =
          streamedNewString ||
          streamedWriteContent ||
          (typeof inputObj?.new_string === 'string' ? inputObj.new_string : undefined)
        const fileEditStatInput = isFileEditStatTool
          ? {
              content: fileEditContent,
              old_string: fileEditOldString,
              new_string: fileEditNewString,
            }
          : null
        // Prefer server line counts when present; else compute from streamed body
        // (progress often exists with 0/0 during args streaming).
        const progressAdded = Number(writeProgress?.lines_added) || 0
        const progressRemoved = Number(writeProgress?.lines_removed) || 0
        const computedFileEditStats = fileEditStatInput
          ? computeFileEditDiffStats({ action: fileEditAction, ...fileEditStatInput })
          : null
        // Prefer latest server line counts. Do NOT Math.max with computed snippet
        // sizes — args-phase counts full old/new strings; writing/done sends the
        // real diff. Max-with-history made later replaces keep earlier +N/−N.
        const progressPhase = String(writeProgress?.phase || '').trim().toLowerCase()
        const progressIsFinal =
          progressPhase === 'writing' || progressPhase === 'done' || progressPhase === 'error'
        const hasProgressLines = progressAdded > 0 || progressRemoved > 0 || progressIsFinal
        const fileEditStats = hasProgressLines
          ? { added: progressAdded, removed: progressRemoved }
          : computedFileEditStats
        const writeCharCount =
          fileEditAction === 'write' && !(fileEditStats?.added || fileEditStats?.removed)
            ? typeof writeProgress?.content_len === 'number' && writeProgress.content_len > 0
              ? writeProgress.content_len
              : typeof fileEditContent === 'string'
                ? fileEditContent.length
                : 0
            : 0
        const writeByteCount =
          fileEditAction === 'write' &&
          !fileEditStats?.added &&
          !fileEditStats?.removed &&
          writeCharCount === 0 &&
          typeof writeProgress?.bytes_written === 'number' &&
          writeProgress.bytes_written > 0
            ? writeProgress.bytes_written
            : 0
        const fileEditStatBrief =
          fileEditStats && fileEditAction
            ? formatFileEditDiffStatBrief(fileEditStats, fileEditAction)
            : writeCharCount > 0
              ? `${writeCharCount} 字`
              : writeByteCount > 0
                ? `${formatBytesShort(writeByteCount)}`
                : ''
        const fileEditStatNode =
          fileEditStats && fileEditAction ? (
            <FileEditDiffStatBrief stats={fileEditStats} action={fileEditAction} />
          ) : writeCharCount > 0 ? (
            <span className="file-diff-stat-brief">
              <span className="file-diff-stat file-diff-stat--add">{writeCharCount} 字</span>
            </span>
          ) : writeByteCount > 0 ? (
            <span className="file-diff-stat-brief">
              <span className="file-diff-stat file-diff-stat--add">
                {formatBytesShort(writeByteCount)}
              </span>
            </span>
          ) : null
        const hasFileEditStats =
          isFileEditStatTool &&
          fileEditAction !== 'delete' &&
          Boolean(
            (fileEditStats && (fileEditStats.added || fileEditStats.removed)) ||
              writeCharCount > 0 ||
              writeByteCount > 0,
          )
        const shortLabel = (() => {
          // supervisor/task: show English tool name (not action detail)
          if (toolKind === 'supervisor') return 'Supervisor'
          if (toolKind === 'subagent') {
            const st =
              (streamTask?.subagentType && String(streamTask.subagentType).trim()) ||
              (typeof inputObj?.subagent_type === 'string' ? String(inputObj.subagent_type).trim() : '') ||
              (typeof inputObj?.subagentType === 'string' ? String(inputObj.subagentType).trim() : '')
            return formatSubagentTypeLabel(st)
          }
          return toolShortLabel(toolName)
        })()
        const inputJson = formatToolDisplayValue(t.input)
        const outputJson =
          toolKind === 'subtask_outcome_report'
            ? formatSubtaskOutcomeReportOutput(t.output, inputObj)
            : toolKind === 'subtask_work_checklist'
              ? formatSubtaskWorkChecklistOutput(t.output)
              : formatToolOutputForUserDisplay(t.output, toolName)
        const toolFailed = isTerminalToolFailed({
          status: t.status,
          output: t.output ?? t.result,
          streamPhase: terminalStream?.phase,
          streamExitCode: terminalStream?.exitCode,
        })
        const mediaImagePreview =
          toolKind === 'media_image_generate' || toolKind === 'media_task_wait'
            ? parseMediaImagePreview(t.output, toolName)
            : null
        const rawInput =
          getToolStreamingArgumentsRaw(t) ||
          t.input ||
          t.args ||
          t.parameters ||
          t.arguments
        const bashCommand = isShellTool
          ? pickTerminalDisplayCommand(terminalStream, rawInput, inputObj, extractShellCommandFromToolInput)
          : extractShellCommandFromToolInput(rawInput, inputObj) ||
            (typeof inputObj?.command === 'string' ? inputObj.command : null) ||
            (typeof terminalStream?.command === 'string' && terminalStream.command.trim()
              ? terminalStream.command.trim()
              : null) ||
            (typeof t.input === 'string' && !String(t.input).trim().startsWith('{') ? String(t.input) : null)
        const query =
          (typeof inputObj?.query === 'string' && inputObj.query.trim() ? inputObj.query.trim() : null) ??
          (toolKind === 'web_search' ? tryWebSearchQueryFromOutput(t.output) : null)
        const url = typeof inputObj?.url === 'string' ? inputObj.url : null
        const path =
          (typeof writeProgress?.path === 'string' && writeProgress.path.trim()
            ? writeProgress.path.trim()
            : null) ||
          extractPathFromToolInput(rawInput, inputObj) ||
          extractPathFromToolOutput(toolName, t.output) ||
          (typeof inputObj?.path === 'string'
            ? inputObj.path
            : typeof inputObj?.file_path === 'string'
              ? inputObj.file_path
              : typeof inputObj?.target_file === 'string'
                ? inputObj.target_file
                : null)
        const processSessionId = extractSessionIdFromToolInput(rawInput, inputObj)
        const processModalCommand = isProcessToolKind(toolKind)
          ? pickProcessModalCommand(toolKind, inputObj, bashCommand, processSessionId)
          : ''

        /** 视觉截断交给 CSS ellipsis；仅对极长内部 id 等保留字符上限 */
        const briefFull = (s: string) => String(s || '').trim()

        /** 折叠时显示的操作摘要 */
        const toolBrief = (() => {
          // Write tools often get path on `_writeProgress` before args parse finishes —
          // prefer showing the target filename over a generic "生成参数中…".
          if (aguiPhase === 'args' && !inputObj) {
            if (isWriteOrEditTool && path) return briefFull(fileNameFromPath(path))
            if ((toolKind === 'delete' || toolKind === 'delete_file') && path) {
              return briefFull(fileNameFromPath(path))
            }
            return '生成参数中…'
          }
          if (pendingApproval && !showInteractiveApproval) return '曾待授权，未执行'
          if (pendingApproval && showInteractiveApproval) {
            const sum = String(approvalMeta?.summary || '').trim()
            if (sum) return briefFull(sum)
          }
          // ── supervisor / task（带 action 的复杂工具） ──
          if (toolKind === 'supervisor') {
            const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
            const actZh = act ? supervisorActionZh(act) : ''
            // 监控类：只显示轮询/倒计时信息，不展示任务 id（避免把内部 id 暴露给用户）
            if (act === 'monitor_execution_step' || act === 'monitor_execution') {
              const stepSecRaw = inputObj?.monitor_step_seconds ?? inputObj?.monitorStepSeconds ?? inputObj?.monitor_poll_seconds ?? inputObj?.monitorPollSeconds
              const stepSec = typeof stepSecRaw === 'number' ? stepSecRaw : (typeof stepSecRaw === 'string' ? Number(stepSecRaw) : NaN)
              const baseTs = timeValue ? new Date(timeValue).getTime() : NaN
              if (running && Number.isFinite(stepSec) && stepSec > 0 && Number.isFinite(baseTs)) {
                const remain = Math.ceil(stepSec - (nowTs - baseTs) / 1000)
                if (remain > 0) return `${actZh} · ${remain}s`
              }
              // 到 0 后不再显示秒数
              return actZh || '监控执行进度'
            }
            if (act === 'create_task' || act === 'create_task_with_subtasks') {
              const tn = typeof inputObj?.task_name === 'string' ? inputObj.task_name as string : ''
              if (tn) return `${actZh} · ${briefFull(tn)}`
              const td = typeof inputObj?.task_description === 'string' ? inputObj.task_description as string : ''
              if (td) return `${actZh} · ${briefFull(td)}`
            }
            if (act === 'create_subtask') {
              const sn = typeof inputObj?.subtask_name === 'string' ? inputObj.subtask_name as string : ''
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
              const sid = typeof inputObj?.subtask_id === 'string' ? inputObj.subtask_id as string : ''
              if (debugShowTaskIds && sid) return `${actZh} · ${briefFull(sid)}`
              return actZh
            }
            if (act === 'start_execution') {
              const tid = typeof inputObj?.task_id === 'string' ? inputObj.task_id as string : ''
              if (debugShowTaskIds && tid) return `${actZh} · ${briefFull(tid)}`
              return actZh
            }
            if (act === 'continue_subtask_session') {
              const tid = typeof inputObj?.task_id === 'string' ? inputObj.task_id as string : ''
              if (debugShowTaskIds && tid) return `${actZh} · ${briefFull(tid)}`
              const msg = typeof inputObj?.agent_message === 'string' ? inputObj.agent_message as string : ''
              if (msg) return `${actZh} · ${briefFull(msg)}`
              return actZh
            }
            // get_status / list_subtasks / set_task_planned / set_task_state / monitor_execution_step / get_task_memory / monitor_execution
            const tid = typeof inputObj?.task_id === 'string' ? inputObj.task_id as string : ''
            const sid = typeof inputObj?.subtask_id === 'string' ? inputObj.subtask_id as string : ''
            if (debugShowTaskIds && tid) return `${actZh} · ${briefFull(tid)}`
            if (debugShowTaskIds && sid) return `${actZh} · ${briefFull(sid)}`
            if (actZh) return actZh
            if (act) return act
          }
          if (toolKind === 'subagent') {
            const desc = typeof inputObj?.description === 'string' ? inputObj.description as string : ''
            if (desc.trim()) return briefFull(desc)
            const pr = typeof inputObj?.prompt === 'string' ? inputObj.prompt as string : ''
            if (pr.trim()) return briefFull(pr)
          }
          if (toolKind === 'worker') {
            const tasks = Array.isArray(inputObj?.tasks) ? inputObj.tasks : []
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
              return formatWorkerMultiTaskBrief(tasks, briefFull, running)
            }
          }
          if (toolKind === 'invoke_acp_agent' || toolKind === 'invoke_acp_agent_tool') {
            const agent = typeof inputObj?.agent === 'string' ? inputObj.agent : ''
            const pr = typeof inputObj?.prompt === 'string' ? inputObj.prompt as string : ''
            if (agent && pr) return `${briefFull(agent)}: ${briefFull(pr)}`
            if (agent) return briefFull(agent)
          }
          // ── 实体资产 assets：优先入参摘要；历史落库只有 output 时从输出 JSON 回填 ──
          if (toolKind === 'assets') {
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
            const rawOut = typeof t.output === 'string' ? t.output.trim() : ''
            if (rawOut) {
              let out: Record<string, unknown> | null = null
              try {
                const p = JSON.parse(rawOut)
                if (p && typeof p === 'object' && !Array.isArray(p)) out = p
              } catch { /* not json */ }
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
          }
          // ── 任务看板 tasks：优先摘要；缺入参时从 output 回填后仍走此分支 ──
          if (toolKind === 'tasks') {
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
            const rawOut = typeof t.output === 'string' ? t.output.trim() : ''
            if (rawOut) {
              if (/重复调用|已拦截/.test(rawOut)) return '重复调用已拦截'
              const firstLine = rawOut.split('\n').map((l) => l.trim()).find(Boolean)
              if (firstLine) return briefFull(firstLine)
            }
          }
          if (toolKind === 'platform') {
            const preservedUi =
              t.platform_ui && typeof t.platform_ui === 'object' && !Array.isArray(t.platform_ui)
                ? (t.platform_ui as { title?: string })
                : null
            const preservedTitle = String(preservedUi?.title || '').trim()
            if (preservedTitle) return briefFull(preservedTitle)
            const rawOut = typeof t.output === 'string' ? t.output.trim() : ''
            if (rawOut) {
              try {
                const parsed = JSON.parse(rawOut) as { ui?: { title?: string }; action?: string; pending_confirm?: boolean }
                const uiTitle = String(parsed?.ui?.title || '').trim()
                if (uiTitle) return briefFull(uiTitle)
                if (parsed?.pending_confirm) {
                  const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : String(parsed?.action || '').trim()
                  return act ? `${act} · 待确认` : '待确认'
                }
              } catch {
                /* ignore */
              }
            }
            const act = typeof inputObj?.action === 'string' ? inputObj.action.trim() : ''
            if (act) return briefFull(act)
          }
          // ── 命令类：完整命令交给 CSS ellipsis，title 保留全文 ──
          if ((toolKind === 'bash' || toolKind === 'execute_command' || toolKind === 'terminal') && bashCommand) {
            const cmd = briefFull(bashCommand.trim())
            if (toolFailed) {
              const exit = terminalStream?.exitCode ?? null
              return exit != null && exit !== 0 ? `${cmd} · exit ${exit}` : `${cmd} · 失败`
            }
            return cmd
          }
          // 命令类 fallback：历史孤儿 tool result（无 input 仅有 output）时从 output 回填摘要
          if (toolKind === 'bash' || toolKind === 'execute_command' || toolKind === 'terminal') {
            const meaningful = firstMeaningfulShellOutputLine(t.output)
            if (meaningful) {
              return briefFull(toolFailed ? `失败 · ${meaningful}` : meaningful)
            }
          }
          // ── 网络类 ──
          if (toolKind === 'web_search' && query) {
            if (running) return briefFull(query)
            const n = tryWebSearchResultCount(t.output)
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
          // ── 文件类 ──
          if (toolKind === 'read' || toolKind === 'read_file') {
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
            // Write/delete row briefs: show leaf filename so CSS ellipsis does not hide
            // the target name behind a long directory prefix (esp. while streaming).
            if (isWriteOrEditTool || toolKind === 'delete' || toolKind === 'delete_file') {
              const leaf = path ? fileNameFromPath(path) : ''
              return leaf ? briefFull(leaf) : ''
            }
            const brief = formatReadPathBrief(inputObj)
            const pathBrief = brief || (path ? briefFull(path) : '')
            if (pathBrief) return pathBrief
          }
          if (toolKind === 'view_image') {
            const imgPath = typeof inputObj?.image_path === 'string' ? inputObj.image_path : path
            if (imgPath) return briefFull(imgPath)
          }
          if (toolKind === 'subtask_work_checklist') {
            const t = formatSubtaskWorkChecklistTitle(inputObj || {})
            return t.replace(/^执行步骤 · /, '').trim() || '更新步骤'
          }
          if (toolKind === 'subtask_outcome_report') {
            let outPreview = formatSubtaskOutcomeReportOutput(t.output, inputObj)
            if (!String(outPreview || '').trim()) {
              const rawOut = typeof t.output === 'string' ? String(t.output).trim() : ''
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
          if (toolKind === 'plan') {
            const g = typeof inputObj?.goal === 'string' ? inputObj.goal.trim() : ''
            if (g) return briefFull(g)
            let steps = inputObj?.steps
            if (typeof steps === 'string') {
              try { steps = JSON.parse(steps) } catch { steps = null }
            }
            if (Array.isArray(steps) && steps.length) return `${steps.length} 个步骤`
            return '提交规划'
          }
          // ── 搜索类 ──
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
          // ── 场景类 ──
          if (
            toolKind === 'mode_set' ||
            toolKind === 'scenario' ||
            toolKind === 'scenario_activation'
          ) {
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
          }
          if (toolKind === 'list_agents') {
            const type = typeof inputObj?.task_type === 'string' ? inputObj.task_type : ''
            const q = typeof inputObj?.query === 'string' ? inputObj.query : ''
            if (type && q) return `${type} · ${briefFull(q)}`
            if (type) return type
            if (q) return briefFull(q)
          }
          // ── 记忆类 ──
          if (toolKind === 'remember' && typeof inputObj?.title === 'string') return briefFull(inputObj.title as string)
          if (toolKind === 'recall' && query) return briefFull(query)
          // ── 待办/自动化 ──
          if (toolKind === 'todo') {
            const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
            const cnt = typeof inputObj?.content === 'string' ? inputObj.content as string : ''
            if (act && cnt) return `${act}: ${briefFull(cnt)}`
            if (act) return act
          }
          if (toolKind === 'automation') {
            const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
            const nm = typeof inputObj?.name === 'string' ? inputObj.name as string : ''
            const sched = typeof inputObj?.schedule === 'string' ? inputObj.schedule as string : ''
            const aidRaw = inputObj?.id ?? inputObj?.task_id
            const aid = typeof aidRaw === 'string' ? aidRaw : ''
            if (act === 'create' && nm) return `${nm}${sched ? ` · ${briefFull(sched)}` : ''}`
            if (act && aid) return `${act}: ${briefFull(aid)}`
            if (act && nm) return `${act}: ${briefFull(nm)}`
            if (act) return act
          }
          // ── 询问 ──
          if (toolKind === 'ask_clarification' && typeof inputObj?.question === 'string') {
            return briefFull(inputObj.question as string)
          }
          // ── Agent 相关 ──
          if (toolKind === 'create_agent' || toolKind === 'update_agent') {
            const code = typeof inputObj?.agent_code === 'string' ? inputObj.agent_code : ''
            if (code) return briefFull(code)
          }
          if (toolKind === 'setup_agent' && typeof inputObj?.description === 'string') {
            return briefFull(inputObj.description as string)
          }
          if (toolKind === 'skill_manager') {
            const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
            const nm = typeof inputObj?.name === 'string' ? inputObj.name as string : ''
            if (act && nm) return `${act}: ${briefFull(nm)}`
            if (act) return act
          }
          if (toolKind === 'claude_session') {
            const act = typeof inputObj?.action === 'string' ? inputObj.action : ''
            if (act === 'send') {
              const msg = typeof inputObj?.message === 'string' ? inputObj.message as string : ''
              if (msg) return briefFull(msg)
            }
            if (act === 'create') {
              const pp = typeof inputObj?.project_path === 'string' ? inputObj.project_path as string : ''
              if (pp) return briefFull(pp)
            }
            if (act) return act
          }
          // ── External CLI (legacy wire id: trae_*) ──
          if (toolKind === 'trae_delegate' && typeof inputObj?.prompt === 'string') return briefFull(inputObj.prompt as string)
          if (toolKind === 'trae_switch_mode' && typeof inputObj?.mode === 'string') return briefFull(inputObj.mode as string)
          if (toolKind === 'trae_start') {
            const ws = typeof inputObj?.workspace === 'string' ? inputObj.workspace : ''
            if (ws) return briefFull(ws)
          }
          // ── Process ──
          if (isProcessStartKind(toolKind, inputObj)) {
            const cmd =
              bashCommand ||
              (typeof inputObj?.command === 'string' ? inputObj.command : null)
            if (cmd) return briefFull(cmd)
          }
          if (isProcessToolKind(toolKind) && !isProcessStartKind(toolKind, inputObj)) {
            const sid =
              processSessionId ||
              (typeof inputObj?.session_id === 'string' ? inputObj.session_id : null)
            if (sid) return briefFull(sid)
          }
          // ── Lint ──
          if (toolKind === 'read_lints') {
            const inv = String(inputObj?.invocation_source || '').trim().toLowerCase()
            const p = typeof inputObj?.paths === 'string' ? inputObj.paths : (Array.isArray(inputObj?.paths) ? (inputObj.paths as string[]).join(', ') : '')
            if (inv === 'post_edit') {
              const short = p ? p.replace(/\\/g, '/').split('/').pop() || p : ''
              return short ? `编辑后 · ${briefFull(short)}` : '编辑后诊断'
            }
            if (p) return briefFull(p)
          }
          // ── 思维导图 ──
          if (toolKind === 'mind_map') {
            const opsList = Array.isArray(inputObj?.ops) ? inputObj.ops : []
            if (running) {
              return opsList.length ? `${opsList.length} 个操作` : '更新导图…'
            }
            const outStr = typeof t.output === 'string' ? t.output : ''
            const appliedM = outStr.match(/applied=(\d+)/)
            if (appliedM) {
              const applied = parseInt(appliedM[1])
              return applied > 0 ? `已更新 ${applied} 个操作` : '无变更'
            }
            return opsList.length ? `${opsList.length} 个操作` : '更新导图'
          }
          // ── 兜底 ──
          const hasOutput = t.output != null && t.output !== '' && !(typeof t.output === 'object' && Object.keys(t.output as object).length === 0)
          if (running && !hasOutput) {
            if (
              path &&
              (isWriteOrEditTool || toolKind === 'delete' || toolKind === 'delete_file')
            ) {
              return briefFull(path)
            }
            return '正在执行...'
          }
          const detail = formatToolBriefDetail(t, titleText)
          if (detail) return briefFull(detail)
          return ''
        })()

        const showElapsedChip = !!(showToolTiming && elapsedText && !isFileEditStatTool)
        const toolBriefCore = toolBrief ? String(toolBrief) : ''

        // Write/edit status text only (no progress bar) — +/- line stats shown separately.
        const writePhase = writeProgress?.phase || ''
        const writeMsg = typeof writeProgress?.message === 'string' ? writeProgress.message : ''
        const briefWriteError = (() => {
          if (!writeMsg) return '写入错误'
          if (/String not found/i.test(writeMsg)) return '写入错误：未找到匹配文本'
          if (/File not found/i.test(writeMsg)) return '写入错误：文件不存在'
          if (/appears \d+ times/i.test(writeMsg)) return '写入错误：匹配不唯一'
          if (/Permission denied/i.test(writeMsg)) return '写入错误：权限不足'
          const first = writeMsg.split(/\r?\n/)[0]!.replace(/^Error:\s*/i, '').trim()
          if (!first) return '写入错误'
          return first.length > 36 ? `写入错误：${first.slice(0, 36)}…` : `写入错误：${first}`
        })()
        const writePhaseLabel =
          writePhase === 'error'
            ? briefWriteError
            : writePhase === 'done'
              ? '写入完成'
              : writePhase === 'writing'
                ? '写入中'
                : writePhase === 'args'
                  ? '生成中'
                  : ''
        const writeStatusTitle =
          writePhase === 'error' && writeMsg ? writeMsg : writePhaseLabel
        const showWriteStatus =
          isWriteOrEditTool &&
          Boolean(writePhaseLabel) &&
          (writePhase === 'writing' || writePhase === 'args' || writePhase === 'error' || (writePhase === 'done' && running))
        const writeStatusNode = showWriteStatus ? (
          <span className="msg-tool-write-progress" title={writeStatusTitle}>
            <span className="msg-tool-write-progress-label">{writePhaseLabel}</span>
          </span>
        ) : null

        const inlineMetricsNode =
          isFileEditStatTool && (toolBriefCore || hasFileEditStats || elapsedText || writeStatusNode)
            ? (
                <span className="msg-tool-inline-metrics">
                  {toolBriefCore ? (
                    <span
                      className={`msg-tool-brief${running ? ' msg-tool-brief--running' : ''}`}
                      title={toolBriefCore}
                    >
                      {running ? (
                        <ToolRunningScanText text={toolBriefCore} maxChars={64} />
                      ) : (
                        toolBriefCore
                      )}
                    </span>
                  ) : null}
                  {hasFileEditStats && fileEditStatNode ? (
                    <span className="msg-tool-inline-stat">{fileEditStatNode}</span>
                  ) : null}
                  {writeStatusNode ? (
                    <span className="msg-tool-inline-stat">{writeStatusNode}</span>
                  ) : null}
                  {elapsedText ? (
                    <span className="msg-tool-elapsed msg-tool-elapsed--inline" aria-label={`耗时 ${elapsedText}`}>
                      {elapsedText}
                    </span>
                  ) : null}
                </span>
              )
            : null
        const toolBriefWithStats =
          toolBriefCore || hasFileEditStats ? (
            <>
              {running && toolBriefCore ? (
                <ToolRunningScanText text={toolBriefCore} maxChars={80} />
              ) : (
                toolBriefCore
              )}
              {toolBriefCore && hasFileEditStats ? ' · ' : null}
              {hasFileEditStats ? fileEditStatNode : null}
            </>
          ) : null
        const toolBriefWithElapsedMerged =
          elapsedText && !showElapsedChip
            ? toolBriefWithStats
              ? (
                  <>
                    {toolBriefWithStats} · {elapsedText}
                  </>
                )
              : elapsedText
            : toolBriefWithStats
        const toolBriefDisplay = inlineMetricsNode
          ? inlineMetricsNode
          : showElapsedChip
            ? toolBriefWithStats
            : toolBriefWithElapsedMerged
        const toolBriefTitleText = [toolBriefCore, hasFileEditStats ? fileEditStatBrief : '']
          .filter(Boolean)
          .join(' · ')
        const summaryTitle =
          isShellTool && bashCommand
            ? bashCommand.trim()
            : isProcessStartKind(toolKind, inputObj) && processModalCommand
              ? processModalCommand.trim()
              : toolBriefTitleText
              ? toolBriefTitleText.trim()
              : titleText
        const summary = (
          <summary title={summaryTitle}>
            <span className="msg-tool-short-label">
              {running ? (
                <ToolRunningScanText text={shortLabel} className="tool-label-running" maxChars={32} />
              ) : (
                shortLabel
              )}
            </span>
            {toolBriefDisplay ? (
              <span
                className={`msg-tool-brief${
                  pendingApproval && showInteractiveApproval ? ' msg-tool-brief--awaiting-approval' : ''
                }${
                  isTerminalModalTool &&
                  (isShellTool || isProcessStartKind(toolKind, inputObj))
                    ? ' msg-tool-brief--shell'
                    : ''
                }${
                  inActivityFoldRow &&
                  isTerminalModalTool &&
                  (isShellTool || isProcessStartKind(toolKind, inputObj))
                    ? ' msg-tool-brief--shell-fold'
                    : ''
                }${running && !inlineMetricsNode ? ' msg-tool-brief--running' : ''}`}
              >
                {toolBriefDisplay}
              </span>
            ) : running && useActivityFold ? (
              <span className="msg-tool-brief msg-tool-brief--pending msg-tool-brief--running">
                <ToolRunningScanText text="…" maxChars={4} />
              </span>
            ) : null}
            {showElapsedChip ? (
              <span className="msg-tool-elapsed" aria-label={`耗时 ${elapsedText}`}>
                {elapsedText}
              </span>
            ) : null}
            <span className="msg-tool-chevron" aria-hidden="true">›</span>
            {displayTimeText && !useActivityFold ? (
              <span className="msg-tool-time">{displayTimeText}</span>
            ) : null}
          </summary>
        )
        const approvalPanel =
          showInteractiveApproval && onToolApproval && toolCallId ? (
            <ToolApprovalInline
              approval={
                approvalMeta || {
                  tool_name: toolName,
                  tool_call_id: toolCallId,
                  summary: String(path || toolName || '').trim(),
                }
              }
              tool={t as Record<string, unknown>}
              toolCallId={toolCallId}
              detailExtra={hasFileEditStats ? fileEditStatBrief : undefined}
              busy={toolApprovalBusy}
              onToolApproval={onToolApproval}
            />
          ) : null
        const sandboxBlockedCard = hasSandboxBlock(t as Record<string, unknown>) ? (
          <SandboxBlockedCard tool={t as Record<string, unknown>} />
        ) : null
        const entryClass = `msg-tool-entry${nestedInExploring || useActivityFold ? ' msg-tool-entry--in-fold' : ''}${
          showInteractiveApproval ? ' msg-tool-entry--awaiting-approval' : ''
        }`
        if (toolKind === 'subagent') {
          // Prefer background/tool_call id for transcript API; collab map key alone 404s empty.
          const subagentTaskId =
            streamTask?.taskExecId || toolCallId || streamTask?.taskId || ''
          const subagentTypeRaw =
            (streamTask?.subagentType && String(streamTask.subagentType).trim()) ||
            (typeof inputObj?.subagent_type === 'string' ? String(inputObj.subagent_type).trim() : '') ||
            (typeof inputObj?.subagentType === 'string' ? String(inputObj.subagentType).trim() : '')
          const subagentTitleText = formatSubagentTypeLabel(subagentTypeRaw) || 'Subagent'
          const liveFallbackText =
            String(streamTask?.liveOutput || streamTask?.progressHint || '').trim() ||
            extractSubagentDisplayTextFromTool(t as Record<string, unknown>)
          return (
            <div key={key} className={entryClass}>
              <ToolCallCollapsible
                toolKind={toolKind}
                running={running}
                defaultOpen={false}
                inActivityFold={useActivityFold}
                summary={summary}
                body={null}
                modalOnExpand={
                  subagentTaskId
                    ? () =>
                        setTranscriptModal({
                          taskId: subagentTaskId,
                          title: subagentTitleText,
                          fallbackText: liveFallbackText || undefined,
                          fallbackTools: streamTask?.tools,
                          fallbackStatus: streamTask?.phase,
                        })
                    : undefined
                }
                modalOpenWhileRunning
              />
              {sandboxBlockedCard}
            </div>
          )
        }
        const isViewImageModalTool = toolKind === 'view_image'
        const isMindMapTool = toolKind === 'mind_map' || toolKind === 'session_mind_map'
        const isFileEditModalTool = isFileEditToolKind(toolKind)
        const fileEditPath = path || String(inputObj?.path || '')
        const openFileEditModal = () =>
          setFileEditModal({
            toolCallId,
            title: summaryTitle || titleText,
            path: fileEditPath,
            action: fileEditActionFromToolKind(toolKind),
            content: fileEditContent,
            old_string: fileEditOldString,
            new_string: fileEditNewString,
            running,
            ok: !running ? !toolFailed : undefined,
            phase: writeProgress?.phase,
            bytes_total: writeProgress?.bytes_total,
            bytes_written: writeProgress?.bytes_written,
            lines_added: writeProgress?.lines_added,
            lines_removed: writeProgress?.lines_removed,
            content_len: writeProgress?.content_len,
            message: writeProgress?.message,
          })
        const openToolDetailModal = () =>
          setLazyDetailModal({
            toolCallId,
            title: summaryTitle || titleText,
            toolKind,
            metaBlocks: buildToolDetailMetaBlocks(
              toolKind,
              (inputObj || {}) as Record<string, unknown>,
              path || '',
              query || '',
              url || '',
              inputJson,
            ),
            contentTitle: toolDetailContentTitle(toolKind),
            tool: t as Record<string, unknown>,
          })
        const inFold = useActivityFold || nestedInExploring
        const viewImagePath =
          typeof inputObj?.image_path === 'string'
            ? inputObj.image_path.trim()
            : path
              ? String(path).trim()
              : ''
        const openApprovalIfPending = undefined
        const openPlatformFeedbackPanel =
          toolKind === 'platform' && canOpenPlatformFeedbackFromTool(t as Record<string, unknown>)
            ? () => {
                requestOpenPlatformFeedbackFromTool(t as Record<string, unknown>)
              }
            : undefined
        const canOpenToolDetailModal =
          Boolean(toolCallId) || toolHasPersistedDetailOutput(t as Record<string, unknown>)
        const modalOnExpand =
          openApprovalIfPending ??
          openPlatformFeedbackPanel ??
          (isMindMapTool && onOpenKnowledgeMap
            ? onOpenKnowledgeMap
            : isTerminalModalTool && (toolCallId || outputJson)
            ? () =>
                setTerminalModal({
                  toolCallId,
                  title:
                    summaryTitle ||
                    titleText ||
                    (isProcessToolKind(toolKind) ? '进程输出' : '终端输出'),
                  command: isShellTool
                    ? bashCommand || terminalStream?.command || ''
                    : processModalCommand,
                  outputFallback: outputJson || '',
                })
            : isViewImageModalTool && (toolCallId || viewImagePath || outputJson)
              ? () =>
                  setViewImageModal({
                    toolCallId,
                    title: summaryTitle || titleText,
                    imagePath: viewImagePath,
                    outputText: outputJson || '',
                  })
              : isFileEditModalTool
                ? openFileEditModal
                : canOpenToolDetailModal
                  ? openToolDetailModal
                  : undefined)
        const foldInteractive = inFold && Boolean(modalOnExpand)
        if (isFileEditModalTool && !inFold) {
          const displayPath =
            fileNameFromPath(String(fileEditPath || path || '').trim()) ||
            (running ? '…' : '')
          const pathTitle = String(fileEditPath || path || displayPath)
          return (
            <div
              key={key}
              className={`msg-tool-entry msg-tool-entry--file-line${running ? ' is-running' : ''}${
                showInteractiveApproval ? ' msg-tool-entry--awaiting-approval' : ''
              }`}
            >
              <button
                type="button"
                className="msg-tool-item--file-mutation msg-tool-item--file-mutation-btn"
                title={pathTitle}
                onClick={() => {
                  if (showInteractiveApproval) return
                  openFileEditModal()
                }}
              >
                <span className="msg-tool-short-label">
                  {running ? (
                    <ToolRunningScanText text={shortLabel} className="tool-label-running" maxChars={32} />
                  ) : (
                    shortLabel
                  )}
                </span>
                <span className="msg-tool-inline-metrics">
                  {displayPath ? (
                    <span
                      className={`msg-tool-brief${running ? ' msg-tool-brief--running' : ''}`}
                      title={pathTitle}
                    >
                      {running ? (
                        <ToolRunningScanText text={displayPath} maxChars={64} />
                      ) : (
                        displayPath
                      )}
                    </span>
                  ) : null}
                  {hasFileEditStats && fileEditStatNode ? (
                    <span className="msg-tool-inline-stat">{fileEditStatNode}</span>
                  ) : null}
                  {elapsedText ? (
                    <span
                      className="msg-tool-elapsed msg-tool-elapsed--inline"
                      aria-label={`耗时 ${elapsedText}`}
                    >
                      {elapsedText}
                    </span>
                  ) : null}
                </span>
                {running && !displayPath ? (
                  <span className="msg-tool-brief msg-tool-brief--pending" aria-hidden>
                    …
                  </span>
                ) : null}
              </button>
              {approvalPanel}
              {!running && pathTitle && pathTitle !== '…' ? (
                <WorkspaceDeliverableCard path={pathTitle} name={displayPath} variant="compact" />
              ) : null}
              {sandboxBlockedCard}
            </div>
          )
        }
        // 平台工具完成后：结构化 Action Result（已创建待办等），不再用日志式 tool 行
        if (toolKind === 'platform' && !running && !toolFailed) {
          const platformUi = parsePlatformUiFeedbackFromTool(t as Record<string, unknown>)
          if (platformUi) {
            // 折叠 / Exploring 外层 fold：平台卡在外侧渲染，避免收起后看不见
            if (hoistPlatformResults || nestedInExploring) return null
            return (
              <div key={key} className={`${entryClass} msg-tool-entry--platform-result`}>
                <PlatformActionResultCard tool={t as Record<string, unknown>} />
                {sandboxBlockedCard}
              </div>
            )
          }
        }
        return (
          <div key={key} className={entryClass}>
            {mediaImagePreview ? (
              <MediaImagePreview
                key={String((mediaImagePreview as { cacheKey?: string }).cacheKey || key)}
                output={t.output}
                toolName={toolName}
              />
            ) : null}
            <ToolCallCollapsible
              toolKind={toolKind}
              running={running}
              failed={toolFailed}
              defaultOpen={false}
              inActivityFold={inFold}
              foldInteractive={foldInteractive}
              summary={summary}
              body={null}
              modalOnExpand={modalOnExpand}
              modalOpenWhileRunning={Boolean(modalOnExpand)}
            />
            {approvalPanel}
            {sandboxBlockedCard}
          </div>
        )
      })}
    </div>
  )

  return (
    <>
      {useActivityFold ? (
        <ToolActivityFold tools={list} isStreaming={isStreaming} forceCollapsed={!isStreaming}>
          {toolListBody}
        </ToolActivityFold>
      ) : (
        toolListBody
      )}
      {hoistPlatformResults && platformResultTools.length > 0 ? (
        <div className="msg-platform-results">
          {platformResultTools.map((tool, i) => {
            const row = tool as Record<string, unknown>
            const id =
              row.tool_call_id != null && String(row.tool_call_id).trim() !== ''
                ? String(row.tool_call_id).trim()
                : row.id != null && String(row.id).trim() !== ''
                  ? String(row.id).trim()
                  : `platform-result-${i}`
            return (
              <div key={id} className="msg-tool-entry msg-tool-entry--platform-result">
                <PlatformActionResultCard tool={row} />
              </div>
            )
          })}
        </div>
      ) : null}
    {planExecConfirm ? (
      <PlanExecConfirm
        taskId={planExecConfirm.taskId}
        taskName={planExecConfirm.taskName}
        subtaskCount={planExecConfirm.subtaskCount}
        showStartExecution={planExecConfirm.showStartExecution}
        statusLabel={planExecConfirm.statusLabel}
        planTitle={planExecConfirm.planTitle}
        planStructuredFallback={planExecConfirm.planStructuredFallback}
        skipApiFetch={planExecConfirm.skipApiFetch}
        syncedSubtasks={planExecConfirm.syncedSubtasks}
        sessionKey={planExecConfirm.sessionKey}
        busy={planExecConfirm.busy}
        onStartExecution={planExecConfirm.onStartExecution}
      />
    ) : null}
    {lazyDetailModal ? (
      <ToolResultDetailModal
        open
        title={lazyDetailModal.title}
        sessionKey={sessionKey}
        toolCallId={lazyDetailModal.toolCallId}
        tool={lazyDetailModal.tool}
        metaBlocks={lazyDetailModal.metaBlocks}
        contentTitle={lazyDetailModal.contentTitle}
        onClose={handleCloseLazyDetail}
      />
    ) : null}
    {viewImageModal ? (
      <ViewImageDetailModal
        open
        title={viewImageModal.title}
        imagePath={viewImageModal.imagePath}
        outputText={viewImageModal.outputText}
        onClose={handleCloseViewImage}
      />
    ) : null}
    {fileEditModal ? (() => {
      // 运行中实时从 list 取 _writeProgress 正文，避免弹窗打开后仍空白
      const liveTool = list.find((x) => {
        const xx = x as { id?: string; tool_call_id?: string }
        const tId = String(xx.tool_call_id || '').trim()
        const xId = String(xx.id || '').trim()
        const want = String(fileEditModal.toolCallId || '').trim()
        return Boolean(want) && (tId === want || xId === want)
      }) as Record<string, unknown> | undefined
      const liveInput = liveTool
        ? (getToolInputObjectFromRow(liveTool) as Record<string, unknown> | null)
        : null
      const liveWp =
        liveTool?._writeProgress && typeof liveTool._writeProgress === 'object'
          ? (liveTool._writeProgress as {
              path?: string
              content?: string
              old_string?: string
              new_string?: string
              phase?: string
              bytes_total?: number
              bytes_written?: number
              lines_added?: number
              lines_removed?: number
              content_len?: number
              message?: string
            })
          : null
      const liveContent =
        (typeof liveWp?.content === 'string' && liveWp.content) ||
        (typeof liveInput?.content === 'string' ? liveInput.content : '') ||
        fileEditModal.content ||
        ''
      const liveOld =
        (typeof liveWp?.old_string === 'string' && liveWp.old_string) ||
        (typeof liveInput?.old_string === 'string' ? liveInput.old_string : '') ||
        fileEditModal.old_string ||
        ''
      const liveNew =
        (typeof liveWp?.new_string === 'string' && liveWp.new_string) ||
        (typeof liveWp?.content === 'string' && liveWp.content) ||
        (typeof liveInput?.new_string === 'string' ? liveInput.new_string : '') ||
        fileEditModal.new_string ||
        ''
      const liveRunning = liveTool ? isToolRunning(liveTool) : Boolean(fileEditModal.running)
      const livePayload: FileEditDiffModalPayload = {
        ...fileEditModal,
        path:
          (typeof liveWp?.path === 'string' && liveWp.path.trim()) ||
          fileEditModal.path,
        content: liveContent || undefined,
        old_string: liveOld || undefined,
        new_string: liveNew || undefined,
        running: liveRunning,
        ok: !liveRunning ? fileEditModal.ok : undefined,
        phase: liveWp?.phase ?? fileEditModal.phase,
        bytes_total: liveWp?.bytes_total ?? fileEditModal.bytes_total,
        bytes_written: liveWp?.bytes_written ?? fileEditModal.bytes_written,
        lines_added: liveWp?.lines_added ?? fileEditModal.lines_added,
        lines_removed: liveWp?.lines_removed ?? fileEditModal.lines_removed,
        content_len:
          typeof liveWp?.content_len === 'number' && Number.isFinite(liveWp.content_len)
            ? liveWp.content_len
            : typeof liveContent === 'string' && liveContent
              ? liveContent.length
              : fileEditModal.content_len,
        message: liveWp?.message ?? fileEditModal.message,
      }
      return (
        <FileEditDiffModal
          open
          sessionKey={sessionKey}
          payload={livePayload}
          onClose={handleCloseFileEdit}
        />
      )
    })() : null}
    {transcriptModal ? (() => {
      const liveTask =
        resolveSubagentStreamTask(subagentTasks, transcriptModal.taskId) ||
        (subagentTasks ? subagentTasks[transcriptModal.taskId] : undefined)
      const liveFallbackText =
        String(liveTask?.liveOutput || liveTask?.progressHint || transcriptModal.fallbackText || '').trim() ||
        undefined
      const transcriptFetchId =
        liveTask?.taskExecId || transcriptModal.taskId || liveTask?.taskId || ''
      return (
        <SubagentTranscriptModal
          taskId={transcriptFetchId}
          title={transcriptModal.title}
          sessionKey={sessionKey}
          fallbackText={liveFallbackText}
          fallbackTools={liveTask?.tools || transcriptModal.fallbackTools}
          fallbackStatus={liveTask?.phase || transcriptModal.fallbackStatus}
          onClose={handleCloseTranscript}
        />
      )
    })() : null}
    {terminalModal ? (() => {
      // 运行中也能打开弹窗，从最新 list 里实时找回工具状态 + 流式输出，让 modal 实时刷新
      const liveTool = list.find((x) => {
        const xx = x as { id?: string; tool_call_id?: string }
        // 与 toolCallId 派生逻辑保持一致：优先 tool_call_id，再回退 id；同时双字段匹配以防 LangGraph id(msg_*) ≠ tool_call_id(call_*)
        const tId = String(xx.tool_call_id || '').trim()
        const xId = String(xx.id || '').trim()
        return tId === terminalModal.toolCallId || xId === terminalModal.toolCallId
      }) as Record<string, unknown> | undefined
      const liveStream = liveTool ? resolveTerminalStreamTask(terminalStreams, liveTool) : undefined
      const liveRunning =
        (liveTool ? isToolRunning(liveTool) : false) || liveStream?.phase === 'running'
      const liveOutputFallback = liveTool
        ? String(liveTool.output ?? liveTool.result ?? '') || terminalModal.outputFallback
        : terminalModal.outputFallback
      return (
        <TerminalToolDetailModal
          open
          title={terminalModal.title}
          command={terminalModal.command}
          sessionKey={sessionKey}
          toolCallId={terminalModal.toolCallId}
          outputFallback={liveOutputFallback}
          stream={liveStream}
          running={liveRunning}
          onClose={handleCloseTerminal}
        />
      )
    })() : null}
    </>
  )
}

export const ToolCallList = memo(ToolCallListInner, areToolCallListPropsEqual)

function _toolRowSig(tool: unknown): string {
  const t = (tool && typeof tool === 'object' ? tool : {}) as Record<string, unknown>
  const id =
    t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
      ? String(t.tool_call_id).trim()
      : t.id != null
        ? String(t.id).trim()
        : ''
  const status = String(t.status ?? t.state ?? '')
  const name = String(t.name ?? t.tool_name ?? '')
  const argsRaw = t.argumentsRaw ?? t.arguments_raw ?? t.input ?? ''
  const out = t.output ?? t.content ?? t.result ?? ''
  const argsLen = typeof argsRaw === 'string' ? argsRaw.length : JSON.stringify(argsRaw ?? '').length
  const outLen = typeof out === 'string' ? out.length : JSON.stringify(out ?? '').length
  // 写入/修改文件时 _writeProgress 持续更新（行数/字节/阶段），
  // 必须纳入签名，否则 ToolCallList 被 memo 冻结，卡片上 +N/-N 行停留在第一次快照，
  // 直到 final 才整体刷新（表现为「行数卡住、最后一瞬间才显示」）。
  const wp =
    t._writeProgress && typeof t._writeProgress === 'object'
      ? (t._writeProgress as Record<string, unknown>)
      : null
  let wpSig = ''
  if (wp) {
    const added = Number(wp.lines_added) || 0
    const removed = Number(wp.lines_removed) || 0
    const bw = Number(wp.bytes_written) || 0
    const phase = String(wp.phase ?? '')
    const cl = Number(wp.content_len) || 0
    if (added || removed || bw || phase || cl) {
      wpSig = `|wp:${added}:${removed}:${bw}:${phase}:${cl}`
    }
  }
  return `${id}|${name}|${status}|${argsLen}|${outLen}${wpSig}`
}

function areToolCallListPropsEqual(prev: any, next: any): boolean {
  if (prev === next) return true
  if (prev.isStreaming !== next.isStreaming) return false
  if (prev.showToolTiming !== next.showToolTiming) return false
  if (prev.interactiveToolApproval !== next.interactiveToolApproval) return false
  if (prev.variant !== next.variant) return false
  if (prev.activityGrouped !== next.activityGrouped) return false
  if (prev.nestedInExploring !== next.nestedInExploring) return false
  if (prev.sessionKey !== next.sessionKey) return false
  if (prev.toolApprovalBusy !== next.toolApprovalBusy) return false
  if (prev.planExecConfirm !== next.planExecConfirm) return false
  if (prev.onToolApproval !== next.onToolApproval) return false
  if (prev.onOpenKnowledgeMap !== next.onOpenKnowledgeMap) return false
  if (prev.subagentTasks !== next.subagentTasks) return false
  if (prev.terminalStreams !== next.terminalStreams) return false
  const prevIds = prev.filterIds as string[] | undefined
  const nextIds = next.filterIds as string[] | undefined
  if (prevIds !== nextIds) {
    if (!prevIds || !nextIds || prevIds.length !== nextIds.length) return false
    for (let i = 0; i < prevIds.length; i++) {
      if (prevIds[i] !== nextIds[i]) return false
    }
  }
  const a = prev.tools as unknown[] | undefined
  const b = next.tools as unknown[] | undefined
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (_toolRowSig(a[i]) !== _toolRowSig(b[i])) return false
  }
  return true
}

