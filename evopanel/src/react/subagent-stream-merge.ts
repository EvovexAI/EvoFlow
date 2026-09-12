import type { SubagentStreamTask } from './chat-types.js'
import { usesDeltaStreamMerge } from '../lib/subagent-type-policy.js'
import { subtaskStreamDebug } from '../lib/subtask-stream-debug.js'

const LIVE_CAP = 65536
const HINT_LEN = 600

function textFromLangGraphMessage(msg: unknown, maxLen: number): string {
  if (msg == null) return ''
  if (typeof msg === 'string') return msg.slice(0, maxLen)
  if (typeof msg !== 'object') return String(msg).slice(0, maxLen)
  const m = msg as Record<string, unknown>
  const c = m.content
  if (typeof c === 'string') return c.slice(0, maxLen)
  if (Array.isArray(c)) {
    let s = ''
    for (const b of c) {
      if (typeof b === 'string') {
        s += b
        continue
      }
      if (b && typeof b === 'object') {
        const bb = b as Record<string, unknown>
        const ty = String(bb.type || '').toLowerCase()
        if (ty === 'text') {
          const t = bb.text
          if (typeof t === 'string') s += t
        }
      }
    }
    return s.slice(0, maxLen)
  }
  return ''
}

/** LangChain JSON / httpx 序列化常见：顶层带 kwargs */
function flattenLangChainMessage(msg: unknown): unknown {
  if (typeof msg !== 'object' || msg == null) return msg
  const m = msg as Record<string, unknown>
  const kw = m.kwargs
  if (kw && typeof kw === 'object' && !Array.isArray(kw)) {
    const k = kw as Record<string, unknown>
    return {
      ...m,
      type: m.type ?? k.type,
      content: m.content ?? k.content,
      role: m.role ?? k.role,
      name: m.name ?? k.name,
      tool_call_id: m.tool_call_id ?? k.tool_call_id,
      tool_calls: m.tool_calls ?? k.tool_calls,
    }
  }
  return msg
}

const TOOL_LIVE_PREVIEW = 420

/** 工具结果也写入 liveOutput，避免侧栏一直卡在「工具过程」而看不到检索主题/后续模型段 */
function toolMessageLivePreview(m: Record<string, unknown>, maxLen: number): string {
  const raw = m.content
  const s =
    typeof raw === 'string'
      ? raw
      : raw != null
        ? (() => {
            try {
              return JSON.stringify(raw)
            } catch {
              return String(raw)
            }
          })()
        : ''
  const oneLine = s.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
    if (parsed && typeof parsed === 'object') {
      const q = (parsed as Record<string, unknown>).query
      if (typeof q === 'string' && q.trim()) {
        const t = q.trim().slice(0, 220)
        return t.length < q.trim().length ? `搜索：${t}…` : `搜索：${t}`
      }
      const err = (parsed as Record<string, unknown>).error
      if (typeof err === 'string' && err.trim()) {
        const t = err.trim().slice(0, 200)
        return t.length < err.trim().length ? `工具：${t}…` : `工具：${t}`
      }
    }
  } catch {
    // 非 JSON，走截断全文
  }
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine
}

const ARGS_PREVIEW = 6000

function stringifyArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args.slice(0, ARGS_PREVIEW)
  try {
    return JSON.stringify(args, null, 2).slice(0, ARGS_PREVIEW)
  } catch {
    return String(args).slice(0, ARGS_PREVIEW)
  }
}

function upsertToolItem(tools: unknown[], next: Record<string, unknown>) {
  const id = String(next.id || next.tool_call_id || '')
  if (!id) {
    tools.push(next)
    return
  }
  const idx = tools.findIndex((t) => {
    const o = t as Record<string, unknown>
    return String(o.id || o.tool_call_id || '') === id
  })
  if (idx < 0) tools.push(next)
  else tools[idx] = { ...(tools[idx] as Record<string, unknown>), ...next }
}

function mergeToolsFromLangGraphMessage(cur: unknown[] | undefined, msg: unknown): unknown[] | undefined {
  const flat = flattenLangChainMessage(msg)
  if (typeof flat !== 'object' || flat == null) return cur
  const m = flat as Record<string, unknown>
  const tools = cur ? [...cur] : []

  // AIMessage.tool_calls
  const rawCalls = m.tool_calls
  if (Array.isArray(rawCalls)) {
    for (const item of rawCalls) {
      if (!item || typeof item !== 'object') continue
      const tc = item as Record<string, unknown>
      const id = typeof tc.id === 'string' ? tc.id : ''
      const name = typeof tc.name === 'string' ? tc.name : 'tool'
      upsertToolItem(tools, {
        id,
        tool_call_id: id,
        name,
        input: tc.args ?? null,
        status: 'running',
      })
    }
  }

  // ToolMessage（工具返回）
  if (m.type === 'tool') {
    const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
    const name = typeof m.name === 'string' ? m.name : 'tool'
    const raw = m.content
    const output = typeof raw === 'string' ? raw.slice(0, 12000) : stringifyArgs(raw).slice(0, 12000)
    upsertToolItem(tools, {
      id,
      tool_call_id: id,
      name,
      output,
      status: 'completed',
    })
  }
  return tools.length ? tools : cur
}

/** task_running 单条消息 → 写入 liveOutput 的片段（含工具返回摘要 + 模型正文） */
function liveChunkFromStreamMessage(msg: unknown, maxTextLen: number): string {
  const flat = flattenLangChainMessage(msg)
  if (typeof flat !== 'object' || flat === null) {
    return textFromLangGraphMessage(flat, maxTextLen).trim()
  }
  const m = flat as Record<string, unknown>
  const kind = String(m.type || m.role || '').toLowerCase()
  if (kind === 'tool') {
    return toolMessageLivePreview(m, Math.min(TOOL_LIVE_PREVIEW, maxTextLen))
  }
  return textFromLangGraphMessage(m, maxTextLen).trim()
}

/** 不同 task_running 片段之间的分隔（不再插入装饰横线，避免弹窗里工具/段落之间出现 ───） */
const LIVE_SEGMENT_SEP = '\n\n'

/**
 * Claude Code（claude_session）：后端 task_running 的 AI `content` 仅为**本段 delta**（与 trae_stream_delta 一致）；
 * 完整正文由前端顺序拼接；落库/完成仍由后端 output_buffer 拼接。
 */
function mergeClaudeSessionLiveOutput(prevLive: string, chunk: string): string {
  if (chunk === '') return prevLive || ''
  const next = `${prevLive || ''}${chunk}`
  return capLiveOutput(next)
}

/** 内置 + 自定义子智能体（见 subagent-type-policy）：按 delta 拼接 liveOutput */
function mergeDeltaLiveOutput(prevLive: string, chunk: string): string {
  const c = String(chunk || '')
  if (!c) return prevLive || ''
  const base = prevLive || ''
  if (!base) return capLiveOutput(c)
  if (c.startsWith(base)) return capLiveOutput(c)
  if (base.startsWith(c)) return capLiveOutput(base)
  if (base.endsWith(c)) return capLiveOutput(base)
  return capLiveOutput(base + c)
}

function capLiveOutput(s: string): string {
  const t = String(s || '').trim()
  if (t.length <= LIVE_CAP) return t
  return t.slice(-LIVE_CAP)
}

/** 与上一段内容相同则不再追加（custom 通道 + project SSE 双源、或轮询重复投递会导致成对重复） */
function appendLive(cur: string | undefined, chunk: string, opts?: { claudePrefixMerge?: boolean }): string {
  const c = chunk.trim()
  if (!c) return cur || ''
  const base = cur || ''
  const segs = base ? base.split(LIVE_SEGMENT_SEP) : []
  const lastSeg = segs.length ? (segs[segs.length - 1] || '').trim() : ''
  if (lastSeg === c) return base
  const smart = Boolean(opts?.claudePrefixMerge)
  // 流式常见「前缀递增」：后 chunk 以前一段为前缀则只更新末段（通用 / Claude 均适用）。
  if (smart && lastSeg && c.startsWith(lastSeg)) {
    const nextSegs = segs.slice()
    nextSegs[nextSegs.length - 1] = c
    let next = nextSegs.join(LIVE_SEGMENT_SEP)
    if (next.length > LIVE_CAP) next = next.slice(-LIVE_CAP)
    return next
  }
  // 更短且为上一段前缀 → 旧快照回放，忽略。
  // 但只在「明显更短」（≥4 字符差）时才视为回放；否则保守保留新帧，
  // 避免 Claude Code 末尾 token 修正导致首帧标点被吞。
  if (smart && lastSeg && lastSeg.startsWith(c) && lastSeg.length - c.length >= 4) return base
  // 整条 task_running 有时是「整段快照」：新正文里完整包含上一段，但前面又插了状态句，不满足 startsWith；
  // 若再追加分隔会叠成多段重复墙（通用助手、Claude 都会出现）。
  const minSuperset = 64
  if (smart && lastSeg.length >= minSuperset && c.length >= lastSeg.length - 24 && c.includes(lastSeg)) {
    const nextSegs = segs.slice()
    nextSegs[nextSegs.length - 1] = c
    let next = nextSegs.join(LIVE_SEGMENT_SEP)
    if (next.length > LIVE_CAP) next = next.slice(-LIVE_CAP)
    return next
  }
  // 语义与已展示正文重复（换行/【完成】/Markdown 差异），勿再拼一段。
  if (base && c) {
    const unified = base.split(LIVE_SEGMENT_SEP).join('\n')
    if (isCompletionTailRedundant(unified, c) || (lastSeg && isCompletionTailRedundant(lastSeg, c))) {
      return base
    }
  }
  const sep = base ? LIVE_SEGMENT_SEP : ''
  let next = base + sep + chunk
  if (next.length > LIVE_CAP) next = next.slice(-LIVE_CAP)
  return next
}

function stringifyResult(res: unknown, maxLen: number): string {
  if (res == null) return ''
  if (typeof res === 'string') return res.slice(0, maxLen)
  try {
    return JSON.stringify(res).slice(0, maxLen)
  } catch {
    return String(res).slice(0, maxLen)
  }
}

function isTerminalStreamPhase(phase: SubagentStreamTask['phase'] | undefined): boolean {
  const p = String(phase || '').trim().toLowerCase()
  return p === 'completed' || p === 'failed' || p === 'timed_out' || p === 'cancelled'
}

/**
 * Claude Code：task_running 已把正文流式写入 liveOutput，task_completed 的 result 常与之一致；
 * 仅用 includes/尾部相等会漏判（空白、换行、Markdown 表格差异），导致「实时一段 + 【完成】再整段」重复。
 */
/**
 * task_running 的 AIMessage 与 subagent_token_delta 流式累积的双源去重：
 * 若 task_running 携带的整段文本（chunk）已被 token 流累积的 liveOutput 实质包含，则不再追加。
 * 比 startsWith / endsWith 更鲁棒，处理空白差异。
 */
function isChunkAlreadyInLive(prevLive: string, chunk: string): boolean {
  const c = String(chunk || '').trim()
  if (!c) return true
  const base = String(prevLive || '').trim()
  if (!base) return false
  if (base.includes(c)) return true
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  const bs = squash(base)
  const cs = squash(c)
  if (!cs) return true
  if (bs.includes(cs)) return true
  // 长正文：取前/中/尾段命中即视为已流式发完
  if (cs.length >= 80) {
    const head = cs.slice(0, 120)
    if (head.length >= 60 && bs.includes(head)) return true
    const tail = cs.slice(-120)
    if (tail.length >= 60 && bs.includes(tail)) return true
  }
  return false
}

/** 供子任务弹窗等对「已完成摘要 vs 仍挂在流上的正文」做展示去重（与 task_completed 合并逻辑一致） */
export function isCompletionTailRedundant(prevFull: string, tail: string): boolean {
  const tailTrim = tail.trim()
  if (!tailTrim) return true
  const prev = String(prevFull || '').trim()
  if (!prev) return false

  if (prev.includes(tailTrim)) return true

  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  const ps = squash(prev)
  const ts = squash(tailTrim)
  if (ts.length >= 16 && ps.includes(ts)) return true

  if (ts.length >= 48) {
    const head = ts.slice(0, 140)
    if (head.length >= 48 && ps.includes(head)) return true
    const mid = ts.slice(Math.max(0, Math.floor(ts.length / 2) - 50), Math.floor(ts.length / 2) + 50)
    if (mid.length >= 40 && ps.includes(mid)) return true
    const end = ts.slice(-140)
    if (end.length >= 48 && ps.includes(end)) return true
  }

  const stripPipe = (s: string) => s.replace(/\|\s+/g, '|').replace(/\s+\|/g, '|')
  const pp = stripPipe(ps)
  const tp = stripPipe(ts)
  if (tp.length >= 24 && pp.includes(tp)) return true

  return false
}

function readCollabSubtaskId(ev: Record<string, unknown>): string {
  const a = typeof ev.collab_subtask_id === 'string' ? ev.collab_subtask_id.trim() : ''
  const b = typeof ev.collabSubtaskId === 'string' ? ev.collabSubtaskId.trim() : ''
  const taskId = typeof ev.task_id === 'string' ? ev.task_id.trim() : ''
  if (a) return a
  if (b) return b
  if (/^Subtask_/i.test(taskId)) return taskId
  return ''
}

/** Collapse task_started / task_running keys onto one stable id per collab subtask. */
export function normalizeSubagentStreamEvent(ev: Record<string, unknown>): Record<string, unknown> {
  const collabSid = readCollabSubtaskId(ev)
  const priorExec =
    typeof ev.task_exec_id === 'string' && ev.task_exec_id.trim() ? ev.task_exec_id.trim() : ''
  const rawTaskId = typeof ev.task_id === 'string' ? ev.task_id.trim() : ''
  // Background / tool_call id used by GET /api/tasks/subagent/{id}/transcript.
  // Collab injects collab_subtask_id onto events and remaps map key; preserve the
  // original task_id (or prior task_exec_id) so the modal can still fetch transcript.
  const taskExec =
    priorExec ||
    (collabSid && rawTaskId && rawTaskId !== collabSid ? rawTaskId : '') ||
    (!collabSid ? rawTaskId : '')
  const mapKey = collabSid || taskExec || rawTaskId
  const out: Record<string, unknown> = { ...ev, task_id: mapKey }
  if (collabSid) {
    out.collab_subtask_id = collabSid
    out.collabSubtaskId = collabSid
  }
  if (taskExec) out.task_exec_id = taskExec
  return out
}

function pinSubtaskStreamRow(
  map: Record<string, SubagentStreamTask>,
  taskId: string,
  row: SubagentStreamTask,
): void {
  map[taskId] = row
  const sid = String(row.collabSubtaskId || '').trim()
  if (sid && sid !== taskId) {
    map[sid] = row
  }
  const execId = String(row.taskExecId || '').trim()
  if (execId && execId !== taskId && execId !== sid) {
    map[execId] = row
  }
}

/** 将后端 task_tool writer 单条事件合并进按 task_id 聚合的映射（就地修改） */
export function mergeSubagentStreamEvent(
  map: Record<string, SubagentStreamTask>,
  ev: Record<string, unknown>,
): void {
  const normalized = normalizeSubagentStreamEvent(ev)
  const type = normalized.type
  if (
    type !== 'task_started' &&
    type !== 'task_running' &&
    type !== 'task_completed' &&
    type !== 'task_failed' &&
    type !== 'task_timed_out' &&
    type !== 'task_cancelled' &&
    type !== 'subagent_token_delta'
  ) {
    return
  }
  const taskId = typeof normalized.task_id === 'string' ? normalized.task_id.trim() : ''
  if (!taskId) return

  const cur = map[taskId] || {
    taskId,
    phase: 'running' as const,
    startedAt: Date.now(),
  }

  const collabSubtaskId =
    typeof normalized.collab_subtask_id === 'string' && normalized.collab_subtask_id.trim()
      ? normalized.collab_subtask_id.trim()
      : typeof normalized.collabSubtaskId === 'string' && normalized.collabSubtaskId.trim()
        ? normalized.collabSubtaskId.trim()
        : undefined

  const subagentFromEv =
    typeof normalized.subagent_type === 'string' && normalized.subagent_type.trim()
      ? normalized.subagent_type.trim()
      : undefined

  const taskExecId =
    typeof normalized.task_exec_id === 'string' && normalized.task_exec_id.trim()
      ? normalized.task_exec_id.trim()
      : undefined

  if (type === 'task_started') {
    const description = typeof normalized.description === 'string' ? normalized.description : undefined
    pinSubtaskStreamRow(map, taskId, {
      ...cur,
      taskId,
      taskExecId: taskExecId ?? cur.taskExecId,
      collabSubtaskId: collabSubtaskId ?? cur.collabSubtaskId,
      description: description ?? cur.description,
      subagentType: subagentFromEv ?? cur.subagentType,
      phase: 'running',
      startedAt: cur.startedAt ?? Date.now(),
    })
    return
  }

  if (type === 'subagent_token_delta') {
    // 后端 SubagentExecutor 通过 parent_chat_stream_writer 推送的 token 级增量；
    // 用 mergeDeltaLiveOutput 直接追加到 liveOutput，无需等待节点完成快照。
    if (isTerminalStreamPhase(cur.phase)) return
    const text = typeof normalized.text === 'string' ? normalized.text : ''
    if (!text) return
    const prevLive = cur.liveOutput || ''
    const liveOutput = mergeDeltaLiveOutput(prevLive, text)
    pinSubtaskStreamRow(map, taskId, {
      ...cur,
      taskId,
      taskExecId: taskExecId ?? cur.taskExecId,
      collabSubtaskId: collabSubtaskId ?? cur.collabSubtaskId,
      subagentType: subagentFromEv ?? cur.subagentType,
      phase: 'running',
      liveOutput,
      progressHint: text.slice(-HINT_LEN) || cur.progressHint,
      startedAt: cur.startedAt ?? Date.now(),
    })
    return
  }

  if (type === 'task_running') {
    // Claude Code 路径对每个 chunk fire-and-forget 广播 task:running；可能与 task_completed
    // 乱序到达。勿在已终态后把 phase 打回 running，否则侧栏「完成 / 执行中」来回跳。
    // 若 collab_subtask_id 已变（旧 bucket 被主任务 id 共用），视为新子任务流，允许写入。
    let base = cur
    if (isTerminalStreamPhase(cur.phase)) {
      const incomingSid = String(collabSubtaskId || '').trim()
      const curSid = String(cur.collabSubtaskId || '').trim()
      if (incomingSid && curSid && incomingSid !== curSid) {
        subtaskStreamDebug('merge_running_new_bucket_after_terminal', {
          mapKey: taskId,
          curSid,
          incomingSid,
          curPhase: cur.phase,
        })
        base = { taskId, phase: 'running' as const, startedAt: Date.now() }
      } else {
        subtaskStreamDebug('merge_running_dropped_terminal', {
          mapKey: taskId,
          collabSubtaskId,
          curSid,
          incomingSid,
          curPhase: cur.phase,
        })
        return
      }
    }
    const chunk = liveChunkFromStreamMessage(normalized.message, 32000)
    const tools = mergeToolsFromLangGraphMessage(base.tools, normalized.message)
    const mi = typeof normalized.message_index === 'number' ? normalized.message_index : undefined
    const tm = typeof normalized.total_messages === 'number' ? normalized.total_messages : undefined
    const prevLive = base.liveOutput || ''
    const subType = subagentFromEv ?? base.subagentType
    // 当 subagent_token_delta 已经把整条 AIMessage 文本流式累积进 liveOutput 时，
    // 紧接到达的 task_running（携带完整 AIMessage 快照）会触发"双源拼接"导致正文重复。
    // 通过 squash 归一化后比较：若 chunk 实质已被 prevLive 包含，则仅更新 tools / 索引等元数据，
    // 不再追加文本。
    const chunkIsAlreadyStreamed = isChunkAlreadyInLive(prevLive, chunk)
    const liveOutput = chunkIsAlreadyStreamed
      ? prevLive
      : usesDeltaStreamMerge(subType)
        ? mergeDeltaLiveOutput(prevLive, chunk)
        : mergeClaudeSessionLiveOutput(prevLive, chunk)
    const hintTail =
      liveOutput === prevLive && chunk.trim()
        ? base.progressHint
        : chunk.slice(-HINT_LEN) || base.progressHint
    pinSubtaskStreamRow(map, taskId, {
      ...base,
      taskId,
      taskExecId: taskExecId ?? base.taskExecId,
      collabSubtaskId: collabSubtaskId ?? base.collabSubtaskId,
      phase: 'running',
      subagentType: subagentFromEv ?? base.subagentType,
      tools,
      progressHint: hintTail || base.progressHint,
      messageIndex: mi ?? base.messageIndex,
      totalMessages: tm ?? base.totalMessages,
      liveOutput,
      startedAt: base.startedAt ?? Date.now(),
    })
    return
  }

  if (type === 'task_completed') {
    const tail = stringifyResult(normalized.result, 12000).trim()
    const prevFull = cur.liveOutput || ''
    const prev = prevFull.trim()
    // 避免最终 result 与流式 liveOutput 重复再拼一整段（Claude Code 最常见）
    let liveOutput = cur.liveOutput
    if (tail) {
      const redundant = prev.length > 0 && isCompletionTailRedundant(prevFull, tail)
      if (!redundant) {
        liveOutput = appendLive(cur.liveOutput, `【完成】\n${tail}`)
      } else if (!prev.includes('【完成】')) {
        liveOutput = appendLive(cur.liveOutput, '【完成】')
      }
    }
    pinSubtaskStreamRow(map, taskId, {
      ...cur,
      taskId,
      taskExecId: taskExecId ?? cur.taskExecId,
      collabSubtaskId: collabSubtaskId ?? cur.collabSubtaskId,
      phase: 'completed',
      subagentType: subagentFromEv ?? cur.subagentType,
      tools: (cur.tools || []).map((t) => {
        const o = t as Record<string, unknown>
        if (o.status === 'running' || o.status == null) return { ...o, status: 'completed' }
        return o
      }),
      liveOutput,
      startedAt: cur.startedAt ?? Date.now(),
    })
    return
  }

  if (type === 'task_failed') {
    const err = typeof normalized.error === 'string' ? normalized.error : 'failed'
    pinSubtaskStreamRow(map, taskId, {
      ...cur,
      taskId,
      taskExecId: taskExecId ?? cur.taskExecId,
      collabSubtaskId: collabSubtaskId ?? cur.collabSubtaskId,
      phase: 'failed',
      subagentType: subagentFromEv ?? cur.subagentType,
      tools: (cur.tools || []).map((t) => {
        const o = t as Record<string, unknown>
        if (o.status === 'running' || o.status == null) return { ...o, status: 'error' }
        return o
      }),
      error: err,
      startedAt: cur.startedAt ?? Date.now(),
    })
    return
  }

  if (type === 'task_timed_out') {
    const err = typeof normalized.error === 'string' ? normalized.error : 'timed out'
    pinSubtaskStreamRow(map, taskId, {
      ...cur,
      taskId,
      taskExecId: taskExecId ?? cur.taskExecId,
      collabSubtaskId: collabSubtaskId ?? cur.collabSubtaskId,
      phase: 'timed_out',
      subagentType: subagentFromEv ?? cur.subagentType,
      tools: (cur.tools || []).map((t) => {
        const o = t as Record<string, unknown>
        if (o.status === 'running' || o.status == null) return { ...o, status: 'error' }
        return o
      }),
      error: err,
      startedAt: cur.startedAt ?? Date.now(),
    })
  }

  if (type === 'task_cancelled') {
    const err = typeof normalized.error === 'string' ? normalized.error : ''
    const prevFull = cur.liveOutput || ''
    const prev = prevFull.trim()
    let liveOutput = cur.liveOutput
    if (err) {
      const redundant = prev.length > 0 && isCompletionTailRedundant(prevFull, err)
      if (!redundant) {
        liveOutput = appendLive(cur.liveOutput, `【已取消】\n${err}`)
      } else if (!prev.includes('【已取消】')) {
        liveOutput = appendLive(cur.liveOutput, '【已取消】')
      }
    } else if (!prev.includes('【已取消】')) {
      liveOutput = appendLive(cur.liveOutput, '【已取消】')
    }
    pinSubtaskStreamRow(map, taskId, {
      ...cur,
      taskId,
      taskExecId: taskExecId ?? cur.taskExecId,
      collabSubtaskId: collabSubtaskId ?? cur.collabSubtaskId,
      phase: 'cancelled',
      subagentType: subagentFromEv ?? cur.subagentType,
      tools: (cur.tools || []).map((t) => {
        const o = t as Record<string, unknown>
        if (o.status === 'running' || o.status == null) return { ...o, status: 'error' }
        return o
      }),
      error: err || 'cancelled',
      liveOutput,
      startedAt: cur.startedAt ?? Date.now(),
    })
  }
}
