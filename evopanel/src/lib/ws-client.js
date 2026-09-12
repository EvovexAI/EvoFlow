/**
 * EvoFlow 聊天客户端（HTTP/SSE 版本）
 * 兼容原 wsClient 的调用接口，彻底移除旧 ws-rpc 聊天链路。
 */

import {
  isInjectedCheckpointHuman,
  mergeToolCallArgsObjects,
  mergeStreamingToolCallArgStrings,
  extractContentLikeFromPartialJsonString,
  accumulateStreamAssistantText,
  isStreamAssistantLineRewrite,
  stripThinkingTags,
  stripThinkingTagsPreserveNewlines,
  stripLegacyEmbeddedReasoningPrefix,
  unwrapAssistantContentJsonEnvelope,
  resolveHistoryMessageContent,
  normalizeUsage,
  usageWirePayloadFromTriplet,
  usageEmitSignature,
  usageTripletFromStreamPart,
} from './chat-normalize.js'
import { formatActivityDetailFromToolCalls, normalizeStreamActivityDetail } from './tool-display.js'
import {
  findAskClarification,
  findAskClarificationAfterHuman,
  resolveClarificationPreview,
  readAskClarificationInput,
  isClarificationPreviewRenderable,
} from './clarify-preview-resolve.js'
import { getPanelSetting } from './panel-settings.js'
import { getUseVirtualPaths as getPanelUseVirtualPaths } from './path-mode.js'
import {
  userBlocksToFlatTranscriptRow,
} from './transcript-persist.js'
import {
  applyTranscriptResumeAnchorToLane,
  laneShouldSkipPersistedTool,
} from './transcript-resume-anchor.js'
import { srLog, srWarn } from '../react/lib/stream-resume-debug.js'
import { sfLog } from '../react/lib/stream-final-debug.ts'
import { markSessionResumeCatchupReplay, markSessionStreamWireSource } from '../react/lib/session-runtime-store.js'
import { normalizeSubagentStreamEvent } from '../react/subagent-stream-merge.js'
import { isTerminalStreamEvent } from '../react/terminal-stream-merge.js'
import {
  normalizePriorTurnStripBundle,
  stripPriorTurnPollutants,
  stripPriorTurnReasoningFromStream,
} from '../react/lib/turn-text-isolation.ts'
import {
  createOpenAiStreamLane,
  openAiChunkToStreamTurnEvents,
  openAiMetaSideEffect,
  openAiMetaToStreamTurnEvents,
} from '../react/lib/openai-stream-turn.ts'
import { logStreamCompareSseRecv, markStreamCompareSession, markStreamCompareRun } from '../react/lib/stream-compare-file-log.ts'

/** ``agui`` (default) | ``openai`` | ``evf`` — override via localStorage EVOFLOW_STREAM_FORMAT */
function resolveStreamWireFormat() {
  try {
    const v = String(localStorage.getItem('EVOFLOW_STREAM_FORMAT') || '').trim().toLowerCase()
    if (v === 'openai' || v === 'evf' || v === 'agui' || v === 'ag-ui') return v === 'ag-ui' ? 'agui' : v
  } catch {
    /* ignore */
  }
  return 'agui'
}

function streamFormatQueryParam(fmt) {
  const f = fmt === 'evf' ? 'evf' : fmt === 'openai' ? 'openai' : 'agui'
  return `ui_sse=1&stream_format=${f}`
}

/** LangGraph run stream (POST create + GET attach): keep run alive on browser disconnect. */
function langGraphRunStreamQueryParam(fmt) {
  const base = streamFormatQueryParam(fmt)
  return `${base}&cancel_on_disconnect=false&stream_mode=values&stream_mode=messages-tuple&stream_mode=custom`
}

function dispatchAgUiWireFrame(self, key, runId, data, lane) {
  if (!data || typeof data !== 'object') return
  const t = String(data.type || '').trim()
  if (!t) return

  logStreamCompareSseRecv({
    sessionKey: key,
    runId,
    eventName: 'ag-ui',
    data,
    wire: 'agui',
  })

  if (t === 'TEXT_MESSAGE_CONTENT') {
    const delta = typeof data.delta === 'string' ? data.delta : ''
    if (delta) {
      lane.deltaCount = (lane.deltaCount || 0) + 1
      lane.finalText = accumulateStreamAssistantText(lane.finalText || '', delta)
      if (lane?.suppressHeaderReplay) {
        lane.suppressHeaderReplay = false
        markSessionResumeCatchupReplay(key, false)
      }
      if (!lane.firstPageTokenReported) {
        lane.firstPageTokenReported = true
        void reportClientFirstTokenTiming({
          trace_id: lane.traceId,
          thread_id: lane.threadId,
          path: lane.streamPath,
          user_input_ts_ms: lane.userInputTsMs,
          page_first_token_ts_ms: nowTs(),
        })
      }
    }
  }

  if (t === 'RUN_STARTED') {
    const aguiRid = String(data.runId || '').trim()
    if (aguiRid) lane.aguiChatRunId = aguiRid
  }

  if (t === 'RUN_FINISHED') {
    lane.evfRunEndSeen = true
    sfLog('agui-wire RUN_FINISHED', {
      sessionKey: key,
      runId: String(lane.aguiChatRunId || runId || ''),
      laneFinalTextLen: String(lane.finalText || '').length,
      deltaCount: lane.deltaCount || 0,
      finalEmitted: !!lane.finalEmitted,
    })
    scheduleAgUiDeferredStreamFinal(lane)
  } else if (t === 'RUN_ERROR') {
    lane.evfRunEndSeen = true
    const errMsg = String(data.message || data.code || 'RUN_ERROR').trim()
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(lane.aguiChatRunId || runId || ''),
      state: 'error',
      errorMessage: errMsg,
      error: { message: errMsg },
    })
    try {
      lane.tryEmitChatStreamFinal?.()
    } catch (err) {
      console.warn('[evoflow] agui RUN_ERROR final emit failed', err)
    }
  }

  if (t === 'MESSAGES_SNAPSHOT') {
    const msgs = data.messages
    if (Array.isArray(msgs) && msgs.length) {
      lane.aguiMessagesSnapshot = msgs
      const derived = agUiDisplaySegmentsFromMessagesSnapshot(msgs)
      if (derived.length) {
        const prev = lane.authoritativeDisplaySegments
        const derivedTools = derived.filter((s) => s?.kind === 'tools').length
        const prevTools = Array.isArray(prev) ? prev.filter((s) => s?.kind === 'tools').length : 0
        const shouldReplace =
          !prev ||
          derivedTools >= prevTools ||
          (derivedTools > 0 && prevTools === 0)
        if (shouldReplace) {
          lane.authoritativeDisplaySegments = derived
        }
      }
      sfLog('agui-wire MESSAGES_SNAPSHOT', {
        sessionKey: key,
        runId: String(lane.aguiChatRunId || runId || ''),
        messageCount: msgs.length,
        derivedSegCount: derived.length,
        assistantPreview: String(
          msgs.find((m) => String(m?.role || '') === 'assistant')?.content || '',
        ).slice(0, 120),
      })
    }
  }

  const chatRunId = String(lane.aguiChatRunId || runId || '').trim() || runId
  let flushFinalAfterAgUiEvent = false

  if (t === 'CUSTOM') {
    const name = String(data.name || '')
    const value = data.value
    if (name === 'display_segments' && Array.isArray(value) && value.length) {
      lane.authoritativeDisplaySegments = value
      flushFinalAfterAgUiEvent = true
      sfLog('agui-wire display_segments', {
        sessionKey: key,
        runId: chatRunId,
        segCount: value.length,
        hasSeq: value.every((s) => s && typeof s.seq === 'number'),
        kinds: value.map((s) => s?.kind),
      })
    } else if (name === 'write_file_progress' && value && typeof value === 'object') {
      const toolCallId = String(value.tool_call_id || '').trim()
      if (toolCallId) {
        self._emitEvent('chat', {
          sessionKey: key,
          runId: chatRunId,
          state: 'write_progress',
          toolCallId,
          writeProgress: {
            path: typeof value.path === 'string' ? value.path : '',
            tool_name: typeof value.tool_name === 'string' ? value.tool_name : '',
            phase: typeof value.phase === 'string' ? value.phase : 'args',
            lines_added: Number(value.lines_added) || 0,
            lines_removed: Number(value.lines_removed) || 0,
            bytes_total:
              typeof value.bytes_total === 'number' && Number.isFinite(value.bytes_total)
                ? value.bytes_total
                : undefined,
            bytes_written:
              typeof value.bytes_written === 'number' && Number.isFinite(value.bytes_written)
                ? value.bytes_written
                : undefined,
            message: typeof value.message === 'string' ? value.message : undefined,
            content_delta: typeof value.content_delta === 'string' ? value.content_delta : undefined,
            old_string_delta:
              typeof value.old_string_delta === 'string' ? value.old_string_delta : undefined,
            new_string_delta:
              typeof value.new_string_delta === 'string' ? value.new_string_delta : undefined,
            content_len:
              typeof value.content_len === 'number' && Number.isFinite(value.content_len)
                ? value.content_len
                : undefined,
          },
        })
      }
    } else if (name === 'right_stage' || name === 'right_stage_stream') {
      try {
        applyRightStageAgUiCustom(name, value)
      } catch (err) {
        console.warn('[evoflow] right_stage custom failed', err)
      }
    } else if (name === 'chat_artifacts' && value && typeof value === 'object') {
      self._emitEvent('chat', {
        sessionKey: key,
        runId: chatRunId,
        state: 'chat_artifacts',
        action: String(value.action || 'upsert'),
        items: Array.isArray(value.items) ? value.items : [],
        threadId: String(value.threadId || value.thread_id || '').trim(),
      })
    } else if (name === 'model_fallback_switch' && value && typeof value === 'object') {
      self._emitEvent('chat', {
        sessionKey: key,
        runId: chatRunId,
        state: 'model_fallback_switch',
        modelName: String(value.model_name || '').trim(),
        fromModel: String(value.from_model || '').trim(),
        text: String(value.text || '').trim(),
      })
    } else if (name === 'pending_inject_consumed' && value && typeof value === 'object') {
      emitPendingInjectConsumedEvent(self, key, chatRunId, value)
    } else if (name === 'custom' && value && typeof value === 'object') {
      // LangGraph stream_writer / EVF custom envelope → AG-UI CUSTOM name=custom
      const chunk =
        value.chunk && typeof value.chunk === 'object' && !Array.isArray(value.chunk)
          ? value.chunk
          : value
      if (String(chunk.type || '').trim() === 'pending_inject_consumed') {
        emitPendingInjectConsumedEvent(self, key, chatRunId, chunk)
      } else {
        dispatchLangGraphCustomStreamChunk(self, key, chatRunId, chunk)
      }
    } else if (name === 'run_end' || (name === 'thread_state' && value) || name === 'usage') {
      try {
        dispatchEvfUiStreamEvent(self, key, runId, value && typeof value === 'object' ? value : data, lane)
      } catch (err) {
        console.warn('[evoflow] agui custom side effect failed', name, err)
      }
    }
  }

  self._emitEvent('chat', {
    sessionKey: key,
    runId: chatRunId,
    state: 'agui_event',
    aguiEvent: data,
    streamFormat: 'agui',
  })

  // MESSAGES_SNAPSHOT is followed by CUSTOM display_segments on run_end; flushing here
  // would emit tool-less segments before the authoritative tail arrives.
  if (flushFinalAfterAgUiEvent) {
    sfLog('agui-wire flush final after tail', {
      sessionKey: key,
      runId: chatRunId,
      wireType: t,
      finalEmitted: !!lane.finalEmitted,
      displaySegCount: Array.isArray(lane.authoritativeDisplaySegments)
        ? lane.authoritativeDisplaySegments.length
        : 0,
      laneFinalTextLen: String(lane.finalText || '').length,
    })
    flushAgUiDeferredStreamFinal(lane)
  }
}
import { subtaskStreamDebug } from './subtask-stream-debug.js'
import { applyRightStageAgUiCustom } from './right-stage/right-stage-agui.js'
import { isLanggraphLeadThreadId, resolveLanggraphLeadThreadId } from './collab-thread-ids.js'
import { LONG_RUN_RECURSION_LIMIT, LONG_RUN_WALL_MS, LONG_RUN_WALL_SECONDS, FRONTEND_STREAM_IDLE_TIMEOUT_MS } from './long-run-limits.js'
import { getCachedMe, ensureMeReady } from './account-session.js'
import { takeCompleteSseFrames, createSseFrameQueue } from './sse-frame-batch.js'
import {
  flushChatPieceCoalesce,
  scheduleChatReasoningCoalesce,
  scheduleChatTextPieceCoalesce,
} from './chat-piece-coalesce.js'
import {
  NetworkErrorCode,
  classifyNetworkError,
  messageForNetworkErrorCode,
} from './user-facing-error.js'

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

/** Map backend prefetch_tool_result custom event to chat tool result payload. */
function prefetchToolResultChatPayload(chunk) {
  const tcId = String(chunk?.tool_call_id || '').trim()
  if (!tcId) return null
  const filePath = String(chunk.path || '').trim()
  const ok = chunk.ok !== false && chunk.status !== 'error'
  const preview = String(chunk.output_preview || chunk.error || '').trim()
  const toolName = String(chunk.tool_name || 'read_file').trim() || 'read_file'
  const args = { ...(filePath ? { path: filePath } : {}) }
  if (chunk.action != null && String(chunk.action).trim()) args.action = String(chunk.action).trim()
  if (chunk.instruction != null && String(chunk.instruction).trim()) {
    args.instruction = String(chunk.instruction)
  }
  if (chunk.content != null) args.content = chunk.content
  if (chunk.old_string != null) args.old_string = chunk.old_string
  if (chunk.new_string != null) args.new_string = chunk.new_string
  const parentWorkerId = String(chunk.parent_tool_call_id || chunk.parent_worker_tool_call_id || '').trim()
  if (parentWorkerId) args.parent_worker_tool_call_id = parentWorkerId
  const inv = String(chunk.invocation_source || '').trim()
  if (inv) args.invocation_source = inv
  else if (/^worker-\d+-/.test(tcId)) args.invocation_source = 'worker'
  let content = preview || (ok ? 'OK' : 'Error')
  const data = {
    type: 'tool',
    name: toolName,
    tool_call_id: tcId,
    content,
    status: ok ? 'ok' : 'error',
    args,
  }
  if (content && content !== 'OK') {
    const bytes = Number(chunk.output_bytes ?? chunk.content_bytes ?? 0)
    data.content = ok ? '' : content
    data.output_truncated = true
    data.outputTruncated = true
    data.truncated = true
    if (Number.isFinite(bytes) && bytes > 0) {
      data.output_bytes = bytes
      data.outputBytes = bytes
    } else if (preview) {
      data.output_bytes = preview.length
      data.outputBytes = preview.length
    }
  }
  return {
    tcId,
    toolName,
    data,
  }
}

function workerFileCompletedChatPayload(chunk) {
  const parentId = String(chunk?.parent_tool_call_id || '').trim()
  const tcId = String(chunk?.tool_call_id || '').trim()
  if (!parentId || !tcId) return null
  const filePath = String(chunk.path || '').trim()
  const ok = chunk.ok !== false && chunk.status !== 'error'
  const preview = String(chunk.output_preview || chunk.error || '').trim()
  const index = Number(chunk.index)
  if (!Number.isFinite(index)) return null
  return {
    parentId,
    tcId,
    entry: {
      index,
      total: Number.isFinite(Number(chunk.total)) ? Number(chunk.total) : undefined,
      path: filePath,
      action: chunk.action != null ? String(chunk.action) : undefined,
      instruction: chunk.instruction != null ? String(chunk.instruction) : undefined,
      content: chunk.content,
      old_string: chunk.old_string,
      new_string: chunk.new_string,
      before_content: chunk.before_content,
      after_content: chunk.after_content,
      query: chunk.query != null ? String(chunk.query) : undefined,
      inner_tools: Array.isArray(chunk.inner_tools) ? chunk.inner_tools : undefined,
      ok,
      preview,
      tool_call_id: tcId,
      tool_name: String(chunk.tool_name || 'write_to_file').trim() || 'write_to_file',
    },
  }
}

function emitWorkerFileCompletedChat(self, key, runId, chunk) {
  const mapped = workerFileCompletedChatPayload(chunk)
  if (!mapped) return
  self._emitEvent('chat', {
    sessionKey: key,
    runId: String(runId),
    state: 'worker_file',
    parentToolCallId: mapped.parentId,
    workerFileEntry: mapped.entry,
  })
  const child = prefetchToolResultChatPayload(chunk)
  if (child) {
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(runId),
      state: 'tool',
      data: child.data,
      toolCallId: child.tcId,
      name: child.toolName,
    })
  }
}

function makeFormattedId(prefix) {
  const d = new Date()
  const ts = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
    String(d.getUTCHours()).padStart(2, '0'),
    String(d.getUTCMinutes()).padStart(2, '0'),
    String(d.getUTCSeconds()).padStart(2, '0'),
  ].join('')
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0')
  const p = String(prefix || 'ID').trim() || 'ID'
  return `${p}_${ts}_${rand}`
}

/** LangGraph ``/threads/{id}/runs*`` accepts lead UUIDs only (not collab executor composites). */
function isLanggraphQueryableThreadId(threadId) {
  return isLanggraphLeadThreadId(threadId)
}

const SESSION_MAP_KEY = 'evoflow-chat-session-map-v1'
/** 用户已删除的 sessionKey：合并侧栏草稿时勿把已删会话粘回列表 */
const SESSION_DELETE_TOMBSTONE_KEY = 'evoflow-chat-deleted-session-keys-v1'
const SESSION_DELETE_TOMBSTONE_CAP = 120
const MAIN_SESSION_KEY = 'agent:main:main'
const VIRTUAL_PATH_MODE_KEY = 'evopanel_use_virtual_paths'
const LEGACY_LOCAL_WORKSPACE_ROOT_KEY = 'evopanel_local_workspace_root'
const LEGACY_LOCAL_WORKSPACE_HISTORY_KEY = 'evopanel_local_workspace_history'
const WORKSPACE_HISTORY_BY_SESSION_KEY = 'evopanel_workspace_history_by_session_v1'
const WORKSPACE_HISTORY_GLOBAL_KEY = 'evopanel_workspace_history_global_v1'
let _legacyWorkspaceMigrated = false
/** 旧版全局工作空间路径，供下一次新建会话写入 DB */
let _pendingLegacyWorkspace = null
/** 同会话并发 messages / workspace hydrate 合并为单次请求 */
const _chatHistoryInflight = new Map()
const _sessionWorkspaceHistoryInflight = new Map()
/** 同 sessionKey 并发 ensure-thread 合并为单次 POST */
const _ensureThreadInflight = new Map()
/** ensure-thread 成功后短时 TTL 缓存，避免每次 chatSend 都 POST */
const _ensureThreadCachedAt = new Map()
/** ensure-thread 失败后短时退避，避免 502 时前端疯狂重试 */
const _ensureThreadFailedAt = new Map()
/** 仅用户点「停止」时为 true；刷新/断线 abort 不应写 run-idle */
const _userStopSessionKeys = new Set()
/** stopSessionExecution 已调 execution/stop — wire abort 勿再 POST run-idle */
const _userStopSkipRunIdleKeys = new Set()
/** LangGraph 已被判定不可用（所有 /api/langgraph/* 404），后续请求快速失败 */
let _langGraphDead = false
const ENSURE_THREAD_FAIL_BACKOFF_MS = 15000
/** Soft cache of last successful ensure; local map trust covers most sends without POST. */
const _ENSURE_THREAD_TTL_MS = 30 * 60 * 1000
let _globalWorkspaceHistoryInflight = null

/** 会话 / 全局工作空间历史（服务端 ``evoflow_workspaces`` + history 表） */
let _sessionWsHistCache = {}
/** 已从 API 拉取过 workspace-history 的 sessionKey（切换会话只读缓存，不在会话内重复 GET） */
const _sessionWsHistHydratedKeys = new Set()
let _globalWsHistCache = []
let _globalWsHistLoaded = false
let _localWsHistMigratedToDb = false
/** In-memory cache of ``evoflow_chat_sessions`` (server is source of truth). */
let _sessionMapCache = null
let _sessionMapHydrated = false

function nowTs() {
  return Date.now()
}

function safeParseJSON(raw, fallback) {
  try { return JSON.parse(raw) } catch { return fallback }
}

/** Append one SSE ``data:`` line (LF-separated, no strip) per the SSE spec. */
function appendSseDataLine(dataRaw, line) {
  const chunk = line.slice(5)
  return dataRaw ? `${dataRaw}\n${chunk}` : chunk
}

function _logStreamRecv(eventName, key, runId, data) {
  try {
    // Only log stream receive events as requested.
    let preview = ''
    try {
      if (eventName === 'custom' && data && typeof data === 'object') {
        const t = data.type
        if (t === 'trae_stream_delta') {
          const raw = data.delta != null ? data.delta : (data.text != null ? data.text : '')
          preview = String(raw || '').slice(0, 240)
        } else if (t === 'trae_stream_error') {
          preview = String(data.error || '').slice(0, 240)
        } else if (String(t || '').includes('task_') || String(t || '').includes('subtask')) {
          preview = String(data.message || data.output || '').slice(0, 240)
        }
      } else if ((eventName === 'messages' || eventName === 'messages-tuple') && data) {
        const root = unwrapMessagesTupleRoot(data)
        preview = String(textFromLangGraphStreamPart(root) || '').slice(0, 240)
      } else if (eventName === 'values' && data && typeof data === 'object') {
        const { messages } = normalizeStreamValues(data)
        const humanIdx = findLastNonCollabHumanIndex(messages)
        const anyLastAi = findLastAssistantAfterIndex(messages, humanIdx)
        preview = String(extractAssistantText(anyLastAi) || '').slice(0, 240)
      }
    } catch {}
     
  } catch {}
}

function _logStreamEmit(_state, _key, _runId, _message, _extra = undefined) {
  /* 默认静默；排查工具入参/流式事件时：localStorage EVOFLOW_DEBUG_TOOL_STREAM=1 */
}

/** 与 chat-normalize 同源开关：看 WS 层 emit 前 tool_calls 是否已有 args / function.arguments */
function evfWsToolStreamDebug(label, compactPayload) {
  try {
    if (typeof localStorage === 'undefined' || localStorage.getItem('EVOFLOW_DEBUG_TOOL_STREAM') !== '1') return
    const text =
      typeof compactPayload === 'string'
        ? compactPayload
        : JSON.stringify(compactPayload, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
     
  } catch {
    /* ignore */
  }
}

function evfBriefEmittedToolCallsForDebug(calls) {
  if (!Array.isArray(calls)) return []
  return calls.map((tc) => {
    if (!tc || typeof tc !== 'object') return {}
    const args = tc.args
    const ak = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).slice(0, 12) : []
    const fa =
      tc.function && typeof tc.function === 'object' && typeof tc.function.arguments === 'string'
        ? tc.function.arguments
        : ''
    const ik =
      tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input) ? Object.keys(tc.input).slice(0, 12) : []
    const kk =
      tc.kwargs && typeof tc.kwargs === 'object' && !Array.isArray(tc.kwargs) ? Object.keys(tc.kwargs).slice(0, 12) : []
    return {
      i: String(tc.id || tc.tool_call_id || '').slice(0, 44),
      n: String(tc.name || (tc.function && tc.function.name) || '').slice(0, 36),
      argK: ak.length ? ak : undefined,
      inputK: ik.length ? ik : undefined,
      kwK: kk.length ? kk : undefined,
      faLen: fa.length || undefined,
    }
  })
}

/** Tauri 桌面包直接 fetch Gateway 后端（已添加 CORS 支持），不再走 Rust invoke 代理。 */
export function isEvoflowTauri() {
  if (typeof window === 'undefined') return false
  return !!(
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__ ||
    window.isTauri
  )
}

let _cachedGwBaseUrl = null

/** 获取 Gateway 后端地址（缓存结果，避免重复 invoke） */
async function _getGatewayBaseUrl() {
  if (_cachedGwBaseUrl !== null) return _cachedGwBaseUrl
  if (isEvoflowTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    _cachedGwBaseUrl = await invoke('get_gateway_base_url')
  } else {
    _cachedGwBaseUrl = ''
  }
  return _cachedGwBaseUrl
}

/** 合并 WebUI JWT（切换用户 / SSO 后按登录身份访问 Gateway）。 */
function _authHeaders(options = {}) {
  try {
    // 动态 import 避免循环依赖（webui-remote.js 不依赖 ws-client）
    // 此处仅同步读取 localStorage，不触发请求
    if (typeof localStorage === 'undefined') return options.headers
    const token = localStorage.getItem('evoflow_webui_token')
    if (!token) return options.headers
    const headers = new Headers(options.headers || {})
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    return headers
  } catch {
    return options.headers
  }
}

/** Tauri 下直连 Gateway 的 fetch：自动附加登录 token。 */
async function _gatewayAuthFetch(url, options = {}) {
  return fetch(url, { ...options, headers: _authHeaders(options) })
}

function buildGatewayProxyRequest(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const [pathPart, search] = url.split('?')
  let query = null
  if (search) {
    query = {}
    new URLSearchParams(search).forEach((v, k) => {
      query[k] = v
    })
  }
  let body = null
  if (options.body != null && options.body !== '') {
    if (typeof options.body === 'string') {
      try {
        body = JSON.parse(options.body)
      } catch {
        body = options.body
      }
    } else {
      body = options.body
    }
  }
  return { method, path: pathPart, body, query }
}

export async function evoflowInvokeGatewayJson(url, options = {}) {
  if (isEvoflowTauri() && String(url || '').startsWith('/')) {
    return fetchJson(url, options)
  }
  const base = isEvoflowTauri() ? await _getGatewayBaseUrl() : ''
  const fullUrl = url.startsWith('/') ? `${base}${url}` : url
  const resp = await _gatewayAuthFetch(fullUrl, options)
  const text = await resp.text().catch(() => '')
  const data = text ? safeParseJSON(text, null) : null
  if (!resp.ok) {
    const msg = data?.detail || data?.error || data?.message || `HTTP ${resp.status}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return data
}

/** Tauri: JSON via gatewayProxy/pipe. Browser: relative fetch. */
async function evoflowFetch(url, options = {}) {
  if (!isEvoflowTauri() || !String(url || '').startsWith('/')) {
    return fetch(url, options)
  }
  try {
    const data = await fetchJson(url, options)
    const text = data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data)
    return {
      ok: true,
      status: 200,
      async text() {
        return text
      },
      async json() {
        return data
      },
    }
  } catch (e) {
    const status = Number(e?.status) || 0
    const body = e?.body ?? e?.gatewayResult
    const text =
      typeof body === 'string'
        ? body
        : body != null
          ? JSON.stringify(body)
          : String(e?.message || e || '')
    return {
      ok: false,
      status: status || 500,
      async text() {
        return text
      },
      async json() {
        return body ?? { detail: text }
      },
    }
  }
}

/** After 404, skip POST /runs/cancel for this tab (legacy gateway without runs router). */
const LS_GLOBAL_RUN_CANCEL_UNSUPPORTED = 'evoflow-global-run-cancel-unsupported'
let _globalRunCancelUnsupported = null

function _globalRunCancelIsUnsupported() {
  if (_globalRunCancelUnsupported === true) return true
  if (typeof sessionStorage === 'undefined') return false
  try {
    if (sessionStorage.getItem(LS_GLOBAL_RUN_CANCEL_UNSUPPORTED) === '1') {
      _globalRunCancelUnsupported = true
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function _markGlobalRunCancelUnsupported() {
  _globalRunCancelUnsupported = true
  try {
    sessionStorage.setItem(LS_GLOBAL_RUN_CANCEL_UNSUPPORTED, '1')
  } catch {
    /* ignore */
  }
}

const EVOFLOW_STREAM_EOF = '__DF_EOF__'

/**
 * Desktop chat stream via Rust ``gateway_proxy_stream`` (reqwest → Gateway SSE bytes).
 * Page never needs the listen port — Tauri owns it. Faster than stdio JSON-RPC for fat frames.
 *
 * Connect gate: do not return ``ok: true`` until the upstream HTTP response is known.
 * LangGraph restart 404 (``Thread or assistant not found``) must reject here so
 * ``chatSend``'s streamAttempt can force-recreate the thread — pushing the error into
 * ``ReadableStream`` mid-read used to bypass that recovery.
 */
async function gatewayProxyFetchStream(url, options = {}) {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const onChunk = new Channel()
  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
  let controller = null
  let finished = false
  let connectSettled = false
  /** @type {(() => void) | null} */
  let resolveConnect = null
  /** @type {((err: Error) => void) | null} */
  let rejectConnect = null
  const connectGate = new Promise((resolve, reject) => {
    resolveConnect = resolve
    rejectConnect = reject
  })

  const markConnectOk = () => {
    if (connectSettled) return
    connectSettled = true
    try {
      resolveConnect?.()
    } catch {
      /* ignore */
    }
  }

  const toStreamError = (err) =>
    err instanceof Error ? err : new Error(String(err || 'gateway_proxy_stream failed'))

  const b64ToBytes = (b64) => {
    const bin = atob(String(b64 || ''))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  }

  const readable = new ReadableStream({
    start(c) {
      controller = c
    },
    cancel() {
      finished = true
    },
  })

  onChunk.onmessage = (encoded) => {
    if (finished || !controller) return
    // First chunk or EOF ⇒ HTTP connect succeeded (Rust only sends after 2xx).
    markConnectOk()
    if (encoded === EVOFLOW_STREAM_EOF || encoded === '__DF_EOF__') {
      finished = true
      try {
        controller.close()
      } catch {
        /* ignore */
      }
      return
    }
    try {
      controller.enqueue(b64ToBytes(encoded))
    } catch (err) {
      finished = true
      try {
        controller.error(err)
      } catch {
        /* ignore */
      }
    }
  }

  const req = buildGatewayProxyRequest(url, options)
  const hdrs = _authHeaders(options)
  /** @type {Record<string, string>} */
  const headerMap = {}
  if (hdrs instanceof Headers) {
    hdrs.forEach((v, k) => {
      headerMap[k] = v
    })
  } else if (hdrs && typeof hdrs === 'object') {
    Object.assign(headerMap, hdrs)
  }
  req.headers = headerMap

  void invoke('gateway_proxy_stream', { request: req, onChunk })
    .then(() => {
      // Zero-chunk 2xx (EOF already marked) or invoke completed without channel EOF.
      markConnectOk()
      if (finished || !controller) return
      finished = true
      try {
        controller.close()
      } catch {
        /* ignore */
      }
    })
    .catch((err) => {
      const error = toStreamError(err)
      if (!connectSettled) {
        connectSettled = true
        try {
          rejectConnect?.(error)
        } catch {
          /* ignore */
        }
        return
      }
      if (finished || !controller) return
      finished = true
      try {
        controller.error(error)
      } catch {
        /* ignore */
      }
    })

  const signal = options.signal
  if (signal?.aborted) {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    throw abortErr
  }
  try {
    await Promise.race([
      connectGate,
      new Promise((_, reject) => {
        if (!signal) return
        signal.addEventListener(
          'abort',
          () => {
            const abortErr = new Error('aborted')
            abortErr.name = 'AbortError'
            reject(abortErr)
          },
          { once: true },
        )
      }),
    ])
  } catch (err) {
    // Abort (or other race winner) before connect settled: mark settled so a late
    // invoke rejection does not rejectConnect → unhandledrejection.
    if (!connectSettled) {
      connectSettled = true
      try {
        resolveConnect?.()
      } catch {
        /* ignore */
      }
    }
    throw err
  }

  return {
    ok: true,
    status: 200,
    body: readable,
    structured: false,
  }
}

/**
 * Desktop stream transport:
 * - Chat ``/runs/stream`` (default): Rust ``gateway_proxy_stream`` — fast SSE bytes, no page port discovery.
 * - Opt-in stdio structured pipe: ``localStorage evoflow-desktop-pipe-chat=1`` (filtered; drops fat values).
 * - Other SSE: prefer warm app-server pipe; HTTP fallback.
 * - Web: same-origin ``fetch``.
 */
export async function evoflowFetchStream(url, options = {}) {
  if (!isEvoflowTauri() || !url.startsWith('/')) {
    return fetch(url, options)
  }
  const pathOnly = String(url).split('?')[0]
  const isRunsStream = String(url).includes('/runs/stream')

  let forcePipeChat = false
  let forceWebviewHttp = false
  try {
    const flag = localStorage.getItem('evoflow-desktop-pipe-chat')
    forcePipeChat = flag === '1' || flag === 'true'
    forceWebviewHttp = flag === '0' || flag === 'false'
  } catch {
    /* ignore */
  }

  // Default chat path: Rust owns Gateway URL (isolation OK) and streams raw SSE (fast).
  if (isRunsStream && !forcePipeChat && !forceWebviewHttp) {
    try {
      console.info('[evoflow] chat transport=gateway-proxy-stream', pathOnly)
      return await gatewayProxyFetchStream(url, options)
    } catch (err) {
      // Stale thread after LangGraph restart — let chatSend recreate; do not mask with pipe fallback.
      if (isLangGraphThreadOrAssistantMissing(err)) throw err
      if (err?.name === 'AbortError' || /aborted/i.test(String(err?.message || err || ''))) throw err
      console.warn('[evoflow] gateway_proxy_stream failed; trying pipe/HTTP', err)
    }
  }

  if (!forceWebviewHttp) {
    try {
      const mod = await import('./app-server-client.js')
      await mod.ensureAppServer().catch(() => null)
      if (forcePipeChat || mod.shouldUseAppServerChatPipe() || mod.isAppServerWarm()) {
        if (isRunsStream) {
          console.info('[evoflow] chat transport=app-server-pipe', pathOnly, {
            structured: typeof options.onStreamEvent === 'function',
          })
          return await mod.appServerFetchStream(url, options)
        }
        console.info('[evoflow] sse transport=app-server-pipe', pathOnly)
        return await mod.appServerFetchGatewayStream(url, options)
      }
      console.info('[evoflow] sse pipe not warm yet; fallback gateway-http', pathOnly)
    } catch (err) {
      console.warn('[evoflow] app-server stream pipe unavailable, fallback to Gateway fetch', err)
    }
  } else {
    console.info('[evoflow] chat forced webview HTTP (localStorage)', pathOnly)
  }

  console.info('[evoflow] chat transport=gateway-http', pathOnly)
  const base = await _getGatewayBaseUrl()
  const fullUrl = `${base}${url}`
  return _gatewayAuthFetch(fullUrl, options)
}

/**
 * ``GET /api/events/threads/{threadId}/panel-stream``（飞书「开始」→ ``panel:hosted_remote_command`` 等）。
 * **Tauri 桌面包**：浏览器 ``EventSource('/api/...')`` 只会打到内置静态资源，**不会**进网关；
 * 须与 LangGraph 流一致直接 fetch。
 *
 * 非关键后台通道：标题更新、``panel:run_ended`` 等；主聊天走 ``runs/stream``。
 * 网关重启/断连时会 ``Failed to fetch`` 并自动重连，不影响发消息。
 *
 * @param {string} threadId
 * @param {(dataJson: string) => void} onData - 单条 ``data:`` 行内容（通常为 JSON 字符串）
 * @returns {() => void} unsubscribe
 */
function _isBenignPanelStreamError(err) {
  if (!err) return true
  if (err?.name === 'AbortError') return true
  const msg = String(err?.message || err || '').trim().toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('load failed') ||
    msg.includes('aborted') ||
    msg.includes('abort') ||
    msg.includes('bodystreambuffer was aborted')
  )
}

function _silenceReaderCancel(reader) {
  if (!reader?.cancel) return
  void Promise.resolve(reader.cancel()).catch(() => {})
}

function _parsePanelSseBlocks(buf, onData) {
  let rest = String(buf || '').replace(/\r\n/g, '\n')
  let sep
  while ((sep = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, sep)
    rest = rest.slice(sep + 2)
    const lines = block.split('\n')
    const dataLines = []
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) continue
    const payload = dataLines.join('\n')
    if (payload && payload !== '{}') onData(payload)
  }
  if (rest.length > 512 * 1024) rest = rest.slice(-64 * 1024)
  return rest
}

export function subscribeThreadPanelSse(threadId, onData) {
  const tid = String(threadId || '').trim()
  if (!tid || typeof onData !== 'function') return () => {}

  const path = `/api/events/threads/${encodeURIComponent(tid)}/panel-stream`

  if (isEvoflowTauri() && path.startsWith('/')) {
    let cancelled = false
    const readerRef = { current: null }
    const abortRef = { current: null }
    let loggedNetworkWarn = false
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    ;(async () => {
      let backoffMs = 1000
      while (!cancelled) {
        let reader = null
        const ac = new AbortController()
        abortRef.current = ac
        try {
          const res = await evoflowFetchStream(path, { method: 'GET', signal: ac.signal })
          if (!res?.ok || !res.body) {
            if (!cancelled && !loggedNetworkWarn) {
              console.warn('[subscribeThreadPanelSse] bad response', tid, res?.status)
              loggedNetworkWarn = true
            }
            await sleep(backoffMs)
            backoffMs = Math.min(backoffMs * 2, 30000)
            continue
          }
          backoffMs = 1000
          loggedNetworkWarn = false
          reader = res.body.getReader()
          readerRef.current = reader
          const dec = new TextDecoder()
          let buf = ''
          while (!cancelled) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.length) buf += dec.decode(value, { stream: true })
            buf = _parsePanelSseBlocks(buf, onData)
          }
        } catch (e) {
          if (cancelled || ac.signal.aborted) break
          if (_isBenignPanelStreamError(e)) {
            if (!loggedNetworkWarn) {
              console.warn(
                '[subscribeThreadPanelSse] panel-stream disconnected (will retry)',
                tid,
                e?.message || e,
              )
              loggedNetworkWarn = true
            }
          } else if (!cancelled) {
            console.warn('[subscribeThreadPanelSse] stream error', tid, e)
          }
        } finally {
          readerRef.current = null
          abortRef.current = null
          _silenceReaderCancel(reader)
        }
        if (cancelled) break
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30000)
      }
    })().catch(() => {})
    return () => {
      cancelled = true
      try {
        abortRef.current?.abort?.()
      } catch {
        /* ignore */
      }
      _silenceReaderCancel(readerRef.current)
    }
  }

  let es = null
  let reconnectTimer = null
  let cancelled = false
  const connect = () => {
    if (cancelled) return
    try {
      es?.close?.()
    } catch {
      /* ignore */
    }
    try {
      es = new EventSource(path)
    } catch (e) {
      console.warn('[subscribeThreadPanelSse] EventSource failed', tid, e)
      reconnectTimer = setTimeout(connect, 3000)
      return
    }
    es.onmessage = (ev) => {
      try {
        if (ev.data && ev.data !== '{}') onData(ev.data)
      } catch (e) {
        console.warn('[subscribeThreadPanelSse] onmessage', e)
      }
    }
    es.onerror = () => {
      if (cancelled) return
      try {
        es?.close?.()
      } catch {
        /* ignore */
      }
      reconnectTimer = setTimeout(connect, 3000)
    }
  }
  connect()
  return () => {
    cancelled = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    try {
      es?.close()
    } catch {
      /* ignore */
    }
  }
}

export { subscribeCollabThreadWs, collabThreadWsUrl } from './collab-ws-client.js'

/**
 * Push collab/subtask custom payloads through the same chat event path as LangGraph stream.
 * Used by ``subscribeCollabThreadWs`` when agent events arrive over WebSocket.
 */
export function dispatchCollabCustomEvent(sessionKey, payload) {
  const key = String(sessionKey || MAIN_SESSION_KEY).trim() || MAIN_SESSION_KEY
  const runId =
    wsClient._latestRunBySession.get(key) ||
    wsClient._collabChatRunBySession.get(key) ||
    ''
  dispatchLangGraphCustomStreamChunk(wsClient, key, runId, payload)
}

/**
 * LangGraph stream_mode=custom 的 data 形态因版本而异：可能是 writer 原对象、或 [namespace, chunk]、或 { chunk }。
 * 仅解析含 type: task_* 的 payload，供子智能体进度条使用。
 */
function normalizeCustomTaskPayload(data) {
  if (!data) return null
  if (Array.isArray(data) && data.length >= 2 && data[1] != null && typeof data[1] === 'object' && !Array.isArray(data[1])) {
    return data[1]
  }
  if (typeof data === 'object' && !Array.isArray(data) && data.chunk != null && typeof data.chunk === 'object' && !Array.isArray(data.chunk)) {
    return data.chunk
  }
  if (typeof data === 'object' && !Array.isArray(data) && typeof data.type === 'string') {
    return data
  }
  return null
}

function clampProgress01(v) {
  const n = Number.parseInt(v, 10)
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(100, n))
}

/**
 * 旧版 Gateway 无 GET .../task-progress 时，用已有 collab + /api/tasks 拼出与后端快照同构的数据，避免对不存在路由发请求导致控制台 404。
 */
async function buildTaskProgressSnapshotFromLegacyApis(threadId) {
  const enc = encodeURIComponent(threadId)
  let collab
  try {
    const resp = await evoflowFetch(`/api/collab/threads/${enc}`)
    const text = await resp.text().catch(() => '')
    collab = text ? safeParseJSON(text, null) : null
    if (!resp.ok) collab = null
  } catch {
    collab = null
  }
  // collab 接口失败时仍可用 /api/tasks 按 thread_id 恢复（避免「任务列表有数据但整段返回 null」）
  if (!collab || typeof collab !== 'object') {
    collab = {
      collab_phase: 'idle',
      bound_task_id: null,
    }
  }

  const phaseStr =
    collab.collab_phase != null && collab.collab_phase !== ''
      ? String(collab.collab_phase)
      : 'idle'
  const boundTid = (collab.bound_task_id || '').toString().trim()

  let task = null
  const wantThread = (threadId || '').toString().trim()
  if (wantThread) {
    try {
      const qs = new URLSearchParams({ thread_id: wantThread })
      if (boundTid) qs.set('prefer_task_id', boundTid)
      const resp = await fetchJson(`/api/tasks?${qs.toString()}`)
      const rows = Array.isArray(resp?.data?.tasks)
        ? resp.data.tasks
        : Array.isArray(resp?.tasks)
          ? resp.tasks
          : Array.isArray(resp)
            ? resp
            : []
      task = rows[0] || null
    } catch {
      task = null
    }
  }

  if (!task || !task.id) return null

  const subs = Array.isArray(task.subtasks) ? task.subtasks : []
  const subtasks = subs
    .filter((st) => st && st.id)
    .map((st) => ({
      subtaskId: String(st.id),
      parentTaskId: String(task.id),
      name: st.name,
      description: st.description,
      status: st.status,
      progress: clampProgress01(st.progress),
      assignedAgent: st.assigned_to,
    }))

  const rawSupervisorSteps =
    (Array.isArray(collab?.sidebar_supervisor_steps) &&
    collab.sidebar_supervisor_steps.length > 0
      ? collab.sidebar_supervisor_steps
      : null) ??
    (Array.isArray(collab?.supervisor_steps) &&
    collab.supervisor_steps.length > 0
      ? collab.supervisor_steps
      : null)
  const supervisor_steps =
    rawSupervisorSteps != null
      ? rawSupervisorSteps
          .map((x) =>
            x && typeof x === 'object' ? { ...x } : x
          )
          .filter((x) => x != null)
      : []

  const planGoal = String(task.plan_goal || task.planGoal || '').trim()
  return {
    thread_id: threadId,
    collab_phase: phaseStr,
    bound_task_id: collab.bound_task_id ?? null,
    main_task: {
      taskId: String(task.id),
      name: task.name,
      status: task.status,
      progress: clampProgress01(task.progress),
      ...(planGoal ? { planGoal, boundPlanPreview: planGoal.slice(0, 480) } : {}),
      boundPlanReady: !!(planGoal && Array.isArray(task.plan_steps) && task.plan_steps.length),
      ...(task.execution_authorized != null
        ? { executionAuthorized: !!task.execution_authorized }
        : {}),
    },
    subtasks,
    supervisor_steps,
  }
}

/** Build collab sidebar snapshot from a task API row (no extra GET /tasks). */
export function collabSnapshotFromTaskRow(task) {
  return buildTaskProgressSnapshotFromTaskRow(task)
}

/** Build the same snapshot shape as {@link buildTaskProgressSnapshotFromLegacyApis} from a task row only. */
function buildTaskProgressSnapshotFromTaskRow(task) {
  if (!task || !task.id) return null
  const subs = Array.isArray(task.subtasks) ? task.subtasks : []
  const subtasks = subs
    .filter((st) => st && st.id)
    .map((st) => ({
      subtaskId: String(st.id),
      parentTaskId: String(task.id),
      name: st.name,
      description: st.description,
      status: st.status,
      progress: clampProgress01(st.progress),
      assignedAgent: st.assigned_to,
    }))
  const st = String(task.status || '').trim().toLowerCase()
  const terminal = new Set(['completed', 'done', 'failed', 'cancelled', 'canceled', 'timed_out'])
  const planGoal = String(task.plan_goal || task.planGoal || '').trim()
  const planSteps = Array.isArray(task.plan_steps) ? task.plan_steps : []
  let phase = 'idle'
  if (terminal.has(st)) {
    phase = 'idle'
  } else if (['executing', 'running', 'in_progress', 'waiting_dispatch'].includes(st)) {
    phase = 'executing'
  } else if (task.execution_authorized === true || task.execution_authorized === 1) {
    phase = 'awaiting_exec'
  } else if (planGoal && planSteps.length) {
    phase = 'plan_ready'
  }
  return {
    thread_id: (task.thread_id || task.threadId || '').toString().trim() || null,
    collab_phase: phase,
    bound_task_id: String(task.id),
    main_task: {
      taskId: String(task.id),
      name: task.name,
      status: task.status,
      progress: clampProgress01(task.progress),
      ...(planGoal ? { planGoal, boundPlanPreview: planGoal.slice(0, 480) } : {}),
      boundPlanReady: !!(planGoal && planSteps.length),
      ...(task.execution_authorized != null
        ? { executionAuthorized: !!task.execution_authorized }
        : {}),
    },
    subtasks,
    supervisor_steps: [],
  }
}

/**
 * Hydrate Task / Session sidebar (main_task + subtasks) when chat attaches without replaying
 * supervisor tool calls — e.g. task-detail「重新开始」直进实时对话且 run 已在跑。
 */
async function mergeCollabSidebarSnapshotFromApis(threadId, taskId, options = {}) {
  const tid = (threadId || '').toString().trim()
  const preferTaskId = (taskId || '').toString().trim()
  const prefetched = options.prefetchedRow && typeof options.prefetchedRow === 'object' ? options.prefetchedRow : null
  if (prefetched) {
    const snap = buildTaskProgressSnapshotFromTaskRow(prefetched)
    if (snap) return snap
  }
  if (tid) {
    try {
      const { fetchTaskRowByThread } = await import('./plan-from-api.js')
      const row = await fetchTaskRowByThread(tid, {
        ...(preferTaskId ? { preferTaskId } : {}),
        bypassCache: options.bypassCache === true,
      })
      if (!row) throw new Error('no task for thread')
      const snap = buildTaskProgressSnapshotFromTaskRow(row)
      if (snap) return snap
    } catch {
      /* fall through */
    }
  }
  const tk = (taskId || '').toString().trim()
  if (!tk || tk === tid) return null
  try {
    const task = await fetchJson(`/api/tasks/${encodeURIComponent(tk)}`)
    return buildTaskProgressSnapshotFromTaskRow(task)
  } catch {
    return null
  }
}

function mergeSessionContextFromApiRow(s, prevContext) {
  const prev = prevContext && typeof prevContext === 'object' ? prevContext : {}
  const ctx = {
    ...prev,
    ...(s?.context && typeof s.context === 'object' ? s.context : {}),
  }
  if (s?.localWorkspaceRoot) ctx.local_workspace_root = String(s.localWorkspaceRoot).trim()
  if (s?.useVirtualPaths != null) ctx.use_virtual_paths = !!s.useVirtualPaths
  if (s?.modelName) ctx.model_name = String(s.modelName).trim()
  if (s?.primaryModelName) ctx.primary_model_name = String(s.primaryModelName).trim()
  if (s?.sessionMode) ctx.session_mode = String(s.sessionMode).trim()
  if (s?.thinkingEnabled != null) ctx.thinking_enabled = !!s.thinkingEnabled
  if (s?.reasoningEffort) ctx.reasoning_effort = String(s.reasoningEffort).trim()
  if (s?.isPlanMode != null) ctx.is_plan_mode = !!s.isPlanMode
  if (s?.subagentEnabled != null) ctx.subagent_enabled = !!s.subagentEnabled
  if (s?.includeSearch != null) ctx.include_search = !!s.includeSearch
  if (s?.memoryEnabled != null) ctx.memory_enabled = !!s.memoryEnabled
  if (s?.useClaudeCodeChat != null) ctx.use_claude_code_chat = !!s.useClaudeCodeChat
  if (s?.collabPhase) ctx.collab_phase = String(s.collabPhase).trim()
  if (s?.collabTaskId) ctx.collab_task_id = String(s.collabTaskId).trim()
  if (s?.agentId) {
    const aid = String(s.agentId).trim()
    ctx.agent_id = aid
    // Flat agentId is authoritative after in-session role switch. Stale residual
    // agent_name often stays "main" while sessionKey is still agent:main:….
    const an = String(ctx.agent_name || '').trim().toLowerCase()
    if (!an || an === 'main' || an === aid.toLowerCase()) {
      ctx.agent_name = aid
    }
  }
  if (Array.isArray(s?.activatedScenarios) && s.activatedScenarios.length > 0) {
    ctx.activated_scenarios = s.activatedScenarios.map((x) => String(x || '').trim()).filter(Boolean)
  }
  // Approval / runtime preset: only overwrite when API actually returns the field.
  // Old SessionRowResponse stripped these → wipe caused UI to fall back to global grant_all.
  if (Object.prototype.hasOwnProperty.call(s || {}, 'effectiveToolApprovalPolicy')) {
    const effPolicy = String(s?.effectiveToolApprovalPolicy || '').trim()
    if (effPolicy) ctx.effective_tool_approval_policy = effPolicy
    else delete ctx.effective_tool_approval_policy
  }
  if (Object.prototype.hasOwnProperty.call(s || {}, 'toolApprovalPolicy')) {
    const rawPolicy = s?.toolApprovalPolicy
    if (rawPolicy != null && String(rawPolicy).trim()) {
      ctx.tool_approval_policy = String(rawPolicy).trim()
    } else {
      delete ctx.tool_approval_policy
    }
  }
  if (Object.prototype.hasOwnProperty.call(s || {}, 'permissionPreset')) {
    const presetRaw = s?.permissionPreset
    if (presetRaw != null && String(presetRaw).trim()) {
      ctx.permission_preset = String(presetRaw).trim()
    } else {
      delete ctx.permission_preset
    }
  }
  if (Object.prototype.hasOwnProperty.call(s || {}, 'effectivePermissionPreset')) {
    const effPreset = String(s?.effectivePermissionPreset || '').trim()
    if (effPreset) ctx.effective_permission_preset = effPreset
    else delete ctx.effective_permission_preset
  }
  return ctx
}

/**
 * Derive the active-scenario list from a session mode, mirroring the backend
 * ``_scenarios_from_session_mode``: plan→['plan'], agent→['agent'], else→[].
 * (After schema v75 dropped ``activated_scenarios_json`` the scenario list is
 * derived from ``session_mode``; the ``activatedScenarios`` API field is kept
 * as a back-compat echo of the same derivation.)
 */
function activatedScenariosFromSessionMode(mode) {
  const m = String(mode || '').trim().toLowerCase()
  if (m === 'plan') return ['plan']
  if (m === 'agent') return ['agent']
  return []
}

/**
 * Prefer the session-mode-derived list; fall back to the residual
 * ``activatedScenarios`` column (still emitted by the backend, derived from
 * session_mode) and finally ``context.activated_scenarios`` (legacy JSON).
 */
function activatedScenariosListFromApiRow(s, ctx) {
  const fromMode = activatedScenariosFromSessionMode(s?.sessionMode)
  if (fromMode.length) return fromMode
  const column = Array.isArray(s?.activatedScenarios)
    ? s.activatedScenarios.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  if (column.length) return column
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  const fromCtxMode = activatedScenariosFromSessionMode(c.session_mode)
  if (fromCtxMode.length) return fromCtxMode
  return Array.isArray(c.activated_scenarios)
    ? c.activated_scenarios.map((x) => String(x || '').trim()).filter(Boolean)
    : []
}

function activatedScenariosListFromMeta(meta) {
  const ctx = meta?.context && typeof meta.context === 'object' ? meta.context : {}
  const fromMetaMode = activatedScenariosFromSessionMode(meta?.sessionMode)
  if (fromMetaMode.length) return fromMetaMode
  const fromCtxMode = activatedScenariosFromSessionMode(ctx.session_mode)
  if (fromCtxMode.length) return fromCtxMode
  const fromMeta = Array.isArray(meta?.activatedScenarios) ? meta.activatedScenarios : null
  const fromCtx = Array.isArray(ctx.activated_scenarios) ? ctx.activated_scenarios : null
  const raw = fromMeta && fromMeta.length ? fromMeta : fromCtx || []
  return raw.map((x) => String(x || '').trim()).filter(Boolean)
}

function flatSessionFieldsFromContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  return {
    localWorkspaceRoot: (c.local_workspace_root || '').toString().trim() || null,
    useVirtualPaths: c.use_virtual_paths != null ? !!c.use_virtual_paths : null,
    modelName: (c.model_name || '').toString().trim() || null,
    primaryModelName: (c.primary_model_name || '').toString().trim() || null,
    sessionMode: (c.session_mode || '').toString().trim() || null,
    thinkingEnabled: c.thinking_enabled != null ? !!c.thinking_enabled : null,
    reasoningEffort: (c.reasoning_effort || '').toString().trim() || null,
    isPlanMode: c.is_plan_mode != null ? !!c.is_plan_mode : null,
    subagentEnabled: c.subagent_enabled != null ? !!c.subagent_enabled : null,
    includeSearch: c.include_search != null ? !!c.include_search : null,
    memoryEnabled: c.memory_enabled != null ? !!c.memory_enabled : null,
    useClaudeCodeChat: c.use_claude_code_chat != null ? !!c.use_claude_code_chat : null,
    collabPhase: (c.collab_phase || '').toString().trim() || null,
    collabTaskId: (c.collab_task_id || '').toString().trim() || null,
    agentId: (c.agent_id || '').toString().trim() || null,
  }
}

function applySessionsListToCache(sessions) {
  const prevMap = loadSessionMap()
  const map = { ...prevMap }
  for (const s of sessions) {
    const sk = String(s?.sessionKey || s?.key || '').trim()
    if (!sk) continue
    const prevCtx =
      prevMap[sk]?.context && typeof prevMap[sk].context === 'object' ? prevMap[sk].context : {}
    const context = mergeSessionContextFromApiRow(s, prevCtx)
    map[sk] = {
      threadId: s.threadId ? String(s.threadId).trim() : prevMap[sk]?.threadId || null,
      title: typeof s.title === 'string' ? s.title.trim() : prevMap[sk]?.title || '',
      createdAt: Number(s.createdAt) || prevMap[sk]?.createdAt || 0,
      updatedAt: Number(s.updatedAt) || prevMap[sk]?.updatedAt || 0,
      messageCount: Number(s.messageCount) || prevMap[sk]?.messageCount || 0,
      context,
      sessionMode: flatSessionFieldsFromContext(context).sessionMode,
      activatedScenarios: activatedScenariosListFromApiRow(s, context),
    }
  }
  _sessionMapCache = map
  _sessionMapHydrated = true
  return map
}

const PLACEHOLDER_SESSION_TITLES = new Set(['新对话', 'new conversation'])

/** 创建时的默认标题；勿用其覆盖 TitleMiddleware 已写入 DB 的 LLM 标题 */
export function isPlaceholderSessionTitle(title) {
  const t = String(title || '').trim()
  if (!t) return true
  for (const p of PLACEHOLDER_SESSION_TITLES) {
    if (t.toLowerCase() === p.toLowerCase()) return true
  }
  return false
}

/** 将侧栏/自动标题写入 DB（PATCH title；服务端为唯一写源，不走 PUT upsert） */
export async function persistSessionTitleToDb(sessionKey, title) {
  const sk = String(sessionKey || '').trim()
  const t = String(title || '').trim()
  if (!sk || !t || isPlaceholderSessionTitle(t)) return
  const map = loadSessionMap()
  const prev = map[sk] && typeof map[sk] === 'object' ? map[sk] : {}
  map[sk] = {
    ...prev,
    title: t,
    updatedAt: nowTs(),
    createdAt: Number(prev.createdAt) || nowTs(),
    messageCount: Number(prev.messageCount) || 0,
    context: prev.context && typeof prev.context === 'object' ? prev.context : {},
  }
  _sessionMapCache = map
  _sessionMapHydrated = true
  try {
    await fetchJson(`/api/chat/sessions/${encodeURIComponent(sk)}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t }),
    })
  } catch {
    /* 标题落库失败不阻断 UI */
  }
}

/** Load session index from ``GET /api/chat/sessions`` (``evoflow_chat_sessions`` only). */
async function refreshSessionMapFromDb(limit = 20) {
  const lim = Math.max(1, Number(limit) || 20)
  const data = await fetchJson(`/api/chat/sessions?limit=${lim}`)
  const sessions = Array.isArray(data?.sessions) ? data.sessions : []
  return applySessionsListToCache(sessions)
}

function loadSessionMap() {
  if (_sessionMapCache && typeof _sessionMapCache === 'object') return _sessionMapCache
  return {}
}

function notifySessionThreadRebound(sessionKey, oldThreadId, threadId) {
  const sk = String(sessionKey || '').trim()
  const tid = String(threadId || '').trim()
  const old = String(oldThreadId || '').trim()
  if (!sk || !tid || !old || old === tid) return
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent('evopanel:session-thread-rebound', {
        detail: { sessionKey: sk, oldThreadId: old, threadId: tid },
      }),
    )
  }
}

/** 仅更新内存 session 索引；SQLite 由服务端 API（ensure-thread / messages / title 等）写入。 */
function saveSessionMap(map, _opts = {}) {
  _sessionMapCache = map || {}
  _sessionMapHydrated = true
}

function loadDeleteSessionTombstones() {
  const raw = safeParseJSON(localStorage.getItem(SESSION_DELETE_TOMBSTONE_KEY) || '[]', [])
  return new Set(Array.isArray(raw) ? raw.map((x) => String(x || '').trim()).filter(Boolean) : [])
}

function addDeleteSessionTombstone(key) {
  const sk = String(key || '').trim()
  if (!sk || sk === MAIN_SESSION_KEY) return
  const prev = Array.from(loadDeleteSessionTombstones())
  const next = [sk, ...prev.filter((k) => k !== sk)].slice(0, SESSION_DELETE_TOMBSTONE_CAP)
  try {
    localStorage.setItem(SESSION_DELETE_TOMBSTONE_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/** 用户已删会话（含 thread:${id} 别名），供 ChatApp 合并列表时勿把草稿/占位粘回侧栏 */
export function isDeletedChatSessionKey(key) {
  const sk = String(key || '').trim()
  if (!sk) return false
  return loadDeleteSessionTombstones().has(sk)
}

function getUseVirtualPaths() {
  return getPanelUseVirtualPaths()
}

function loadWorkspaceHistoryMap() {
  return safeParseJSON(localStorage.getItem(WORKSPACE_HISTORY_BY_SESSION_KEY) || '{}', {})
}

function saveWorkspaceHistoryMap(obj) {
  try {
    localStorage.setItem(WORKSPACE_HISTORY_BY_SESSION_KEY, JSON.stringify(obj || {}))
  } catch {
    /* ignore */
  }
}

function loadGlobalWorkspaceHistory() {
  return safeParseJSON(localStorage.getItem(WORKSPACE_HISTORY_GLOBAL_KEY) || '[]', [])
}

function saveGlobalWorkspaceHistory(arr) {
  try {
    localStorage.setItem(WORKSPACE_HISTORY_GLOBAL_KEY, JSON.stringify(Array.isArray(arr) ? arr : []))
  } catch {
    /* ignore */
  }
}

function normalizeHistoryList(list) {
  if (!Array.isArray(list)) return []
  return list.map((x) => String(x || '').trim()).filter(Boolean)
}

function mergeHistory(a, b, limit = 60) {
  const out = []
  const push = (v) => {
    const s = String(v || '').trim()
    if (!s) return
    if (out.includes(s)) return
    out.push(s)
  }
  normalizeHistoryList(a).forEach(push)
  normalizeHistoryList(b).forEach(push)
  return out.slice(0, Math.max(1, limit))
}

/** 将旧版全局工作空间迁入全局历史，并供下一次新建会话落库（仅一次） */
function migrateLegacyGlobalWorkspaceOnce() {
  if (_legacyWorkspaceMigrated) return
  _legacyWorkspaceMigrated = true
  if (typeof localStorage === 'undefined') return
  try {
    const legacy = (localStorage.getItem(LEGACY_LOCAL_WORKSPACE_ROOT_KEY) || '').trim()
    const legacyHistRaw = localStorage.getItem(LEGACY_LOCAL_WORKSPACE_HISTORY_KEY)
    if (legacy) {
      _pendingLegacyWorkspace = legacy
      const g = loadGlobalWorkspaceHistory()
      saveGlobalWorkspaceHistory(mergeHistory([legacy], g, 60))
    }
    if (legacyHistRaw) {
      try {
        const arr = JSON.parse(legacyHistRaw)
        if (Array.isArray(arr) && arr.length) {
          const normalized = arr.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30)
          const g = loadGlobalWorkspaceHistory()
          saveGlobalWorkspaceHistory(mergeHistory(normalized, g, 60))
          if (legacy && !_pendingLegacyWorkspace) _pendingLegacyWorkspace = normalized[0] || legacy
        }
      } catch {
        /* ignore */
      }
    }
    if (legacy) localStorage.removeItem(LEGACY_LOCAL_WORKSPACE_ROOT_KEY)
    if (legacyHistRaw) localStorage.removeItem(LEGACY_LOCAL_WORKSPACE_HISTORY_KEY)
  } catch {
    /* ignore */
  }
}

/** 取出并清空待写入新会话的旧版工作空间路径 */
export function consumePendingLegacyWorkspace() {
  migrateLegacyGlobalWorkspaceOnce()
  const p = (_pendingLegacyWorkspace || '').trim()
  _pendingLegacyWorkspace = null
  return p || null
}

async function migrateLocalWorkspaceHistoryToDbOnce() {
  if (_localWsHistMigratedToDb) return
  _localWsHistMigratedToDb = true
  migrateLegacyGlobalWorkspaceOnce()
  if (typeof localStorage === 'undefined') return
  try {
    const perSession = loadWorkspaceHistoryMap()
    for (const [sk, arr] of Object.entries(perSession || {})) {
      const key = String(sk || '').trim()
      if (!key || !Array.isArray(arr) || !arr.length) continue
      if (isDeletedChatSessionKey(key)) continue
      try {
        await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/workspace-history`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: normalizeHistoryList(arr).slice(0, 30) }),
        })
      } catch {
        /* session row may not exist yet */
      }
    }
    const global = loadGlobalWorkspaceHistory()
    if (global.length) {
      await fetchJson('/api/workspaces/user-history', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: global }),
      })
    }
    try {
      localStorage.removeItem(WORKSPACE_HISTORY_BY_SESSION_KEY)
      localStorage.removeItem(WORKSPACE_HISTORY_GLOBAL_KEY)
    } catch {
      /* ignore */
    }
  } catch (e) {
     
    console.warn('[evoflow] migrate workspace history to db failed', e)
  }
}

async function loadSessionWorkspaceHistoryFromDb(sessionKey, options = {}) {
  const key = String(sessionKey || '').trim()
  if (!key) return []
  if (!options.force && _sessionWsHistHydratedKeys.has(key)) {
    return normalizeHistoryList(_sessionWsHistCache[key] || [])
  }
  const inflight = _sessionWorkspaceHistoryInflight.get(key)
  if (inflight) return inflight
  const promise = (async () => {
    await migrateLocalWorkspaceHistoryToDbOnce()
    const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/workspace-history`)
    const paths = normalizeHistoryList(data?.paths)
    _sessionWsHistCache[key] = paths
    if (data?.currentPath) {
      const map = loadSessionMap()
      if (!map[key]) {
        map[key] = { context: { ...buildDefaultSessionContext() } }
      }
      const prevCtx = map[key].context || {}
      if (!isWorkspaceUserPinned(prevCtx)) {
        map[key].context = { ...prevCtx, local_workspace_root: String(data.currentPath).trim() }
        _sessionMapCache = map
      }
    }
    _sessionWsHistHydratedKeys.add(key)
    return paths
  })()
  _sessionWorkspaceHistoryInflight.set(key, promise)
  try {
    return await promise
  } finally {
    if (_sessionWorkspaceHistoryInflight.get(key) === promise) {
      _sessionWorkspaceHistoryInflight.delete(key)
    }
  }
}

async function loadGlobalWorkspaceHistoryFromDb() {
  if (_globalWsHistLoaded) return normalizeHistoryList(_globalWsHistCache)
  if (_globalWorkspaceHistoryInflight) return _globalWorkspaceHistoryInflight
  const promise = (async () => {
    await migrateLocalWorkspaceHistoryToDbOnce()
    const data = await fetchJson('/api/workspaces/user-history')
    _globalWsHistCache = normalizeHistoryList(data?.paths)
    _globalWsHistLoaded = true
    return _globalWsHistCache
  })()
  _globalWorkspaceHistoryInflight = promise
  try {
    return await promise
  } finally {
    if (_globalWorkspaceHistoryInflight === promise) _globalWorkspaceHistoryInflight = null
  }
}

/** 设置 → 通用「默认启用记忆」（``panel.ui.memoryEnabledDefault``） */
function readGlobalMemoryDefaultContext() {
  const enabled = getPanelSetting('memoryEnabledDefault', true)
  if (enabled === false) return { memory_enabled: false }
  if (enabled === true) return { memory_enabled: true }
  return {}
}

function buildDefaultSessionContext() {
  return {
    session_mode: 'agent',
    thinking_type: 'auto',
    is_plan_mode: false,
    subagent_enabled: false,
    include_search: true,
    use_virtual_paths: getUseVirtualPaths(),
    ...readGlobalMemoryDefaultContext(),
  }
}

/** Per-session prefs: must not be overwritten by buildDefaultSessionContext on send. */
const SESSION_USER_PREF_KEYS = [
  'memory_enabled',
  'local_workspace_root',
  'workspace_user_pinned',
  'preferred_skills',
  'preferred_skill',
]

function isWorkspaceUserPinned(ctx) {
  if (!ctx || typeof ctx !== 'object') return false
  const v = ctx.workspace_user_pinned
  return v === true || v === 1 || String(v || '').toLowerCase() === 'true'
}

function applySessionUserPrefsToRunContext(runContext, sessionContext) {
  if (!sessionContext || typeof sessionContext !== 'object') return runContext
  for (const k of SESSION_USER_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sessionContext, k)) {
      runContext[k] = sessionContext[k]
    }
  }
  return runContext
}

function threadTs(u) {
  if (typeof u === 'number' && !Number.isNaN(u)) {
    if (u <= 0) return 0
    // 远端 threads/search 常为 Unix 秒；本地 session map 用 Date.now() 毫秒。混排会导致列表顺序乱跳。
    if (u < 1e11) return u * 1000
    return u
  }
  if (typeof u === 'string') {
    const p = Date.parse(u)
    if (!Number.isNaN(p)) return p
  }
  return 0
}

function threadSearchUpdatedTs(t) {
  if (!t || typeof t !== 'object') return 0
  return threadTs(t.updated_at ?? t.updatedAt)
}

function threadSearchCreatedTs(t) {
  if (!t || typeof t !== 'object') return 0
  return threadTs(t.created_at ?? t.createdAt)
}

/** 与 Web 端 useThreads 一致：metadata.session_key；无主键时用 thread:${id} 占位 */
function sessionKeyFromSearchThread(t) {
  if (!t || typeof t !== 'object') return ''
  const meta = t.metadata && typeof t.metadata === 'object' ? t.metadata : {}
  const sk = meta.session_key ?? meta.sessionKey
  if (typeof sk === 'string' && sk.trim()) return sk.trim()
  const id = t.thread_id || t.threadId
  if (id) return `thread:${id}`
  return ''
}

function normalizeThreadsSearchResponse(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.threads)) return data.threads
  if (data && Array.isArray(data.items)) return data.items
  return []
}

/**
 * 兼容不同网关/代理返回结构，尽量提取线程 ID。
 * 常见形态：
 * - { thread_id: "..." } / { threadId: "..." } / { id: "..." }
 * - { thread: { thread_id: "..." } } / { data: { thread_id: "..." } }
 * - 直接返回字符串 id
 */
function extractThreadId(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') {
    const s = payload.trim()
    if (!s) return ''
    // 兼容 "{"thread_id":"..."}" 这类字符串化 JSON 返回
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        const parsed = JSON.parse(s)
        const nested = extractThreadId(parsed)
        if (nested) return nested
      } catch {
        // keep raw string fallback
      }
    }
    return s
  }
  if (typeof payload === 'number') return String(payload)
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const id = extractThreadId(item)
      if (id) return id
    }
    return ''
  }
  if (typeof payload !== 'object') return ''
  const direct =
    payload.thread_id ||
    payload.threadId ||
    payload.id
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  if (typeof direct === 'number') return String(direct)
  // 某些返回把 id 放在字符串字段里
  for (const k of ['thread', 'thread_id', 'threadId', 'id']) {
    const v = payload[k]
    if (typeof v === 'string') {
      const nested = extractThreadId(v)
      if (nested) return nested
    }
  }
  const nested = payload.thread || payload.data || payload.result
  if (nested && typeof nested === 'object') {
    const nid = nested.thread_id || nested.threadId || nested.id
    if (typeof nid === 'string' && nid.trim()) return nid.trim()
    if (typeof nid === 'number') return String(nid)
  }
  return ''
}

function debugPayloadSnippet(payload, maxLen = 300) {
  try {
    if (payload == null) return 'null'
    if (typeof payload === 'string') return payload.slice(0, maxLen)
    return JSON.stringify(payload).slice(0, maxLen)
  } catch {
    return String(payload).slice(0, maxLen)
  }
}

async function createThreadViaApi(sessionKey) {
  const desiredThreadId = makeFormattedId('Thread')
  const metadata = {
    session_key: sessionKey,
    max_execution_time: LONG_RUN_WALL_SECONDS,
    timeout_ms: LONG_RUN_WALL_MS,
    execution_mode: 'normal',
  }
  if (isEvoflowTauri()) {
    try {
      const { shouldUseAppServerChatPipe, appServerThreadStart } = await import(
        './app-server-client.js'
      )
      if (shouldUseAppServerChatPipe()) {
        console.info('[evoflow] thread transport=app-server-pipe thread/start')
        let out = await appServerThreadStart({
          sessionKey,
          threadId: desiredThreadId,
          metadata,
        })
        let tid = out?.threadId || extractThreadId(out?.thread) || extractThreadId(out)
        if (!tid) {
          out = await appServerThreadStart({ sessionKey, metadata })
          tid = out?.threadId || extractThreadId(out?.thread) || extractThreadId(out)
        }
        if (tid) {
          return out?.thread && typeof out.thread === 'object'
            ? { ...out.thread, thread_id: tid }
            : { thread_id: tid, sessionKey, ...out }
        }
      }
    } catch (err) {
      console.warn('[evoflow] thread/start pipe failed, fallback gatewayProxy', err)
    }
  }
  try {
    return await fetchJson('/api/langgraph/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: desiredThreadId,
        metadata,
      }),
    })
  } catch {
    // backward compatibility: some servers reject explicit thread_id
    return fetchJson('/api/langgraph/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata }),
    })
  }
}

async function createThreadRobust(sessionKey) {
  const viaApi = await createThreadViaApi(sessionKey)
  if (extractThreadId(viaApi)) return viaApi
  // Retry once if body looked empty / wrong shape
  return createThreadViaApi(sessionKey)
}

async function fetchJson(url, options = {}) {
  // Desktop: never WebView-fetch Gateway directly — go gatewayProxy (pipe when warm).
  if (isEvoflowTauri() && url.startsWith('/')) {
    const { gatewayProxy } = await import('./tauri-api.js')
    const raw = String(url)
    const qIdx = raw.indexOf('?')
    const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw
    const search = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
    /** @type {Record<string, string> | null} */
    let query = null
    if (search) {
      query = {}
      new URLSearchParams(search).forEach((v, k) => {
        query[k] = v
      })
    }
    const method = String(options.method || 'GET').toUpperCase()
    let body = null
    if (options.body != null && options.body !== '') {
      if (typeof options.body === 'string') {
        try {
          body = JSON.parse(options.body)
        } catch {
          body = options.body
        }
      } else {
        body = options.body
      }
    }
    try {
      /** @type {Record<string, unknown>} */
      const proxyOpts = {}
      if (options.preferGatewayHttp) proxyOpts.preferGatewayHttp = true
      if (options.silent) proxyOpts.silent = true
      if (options.timeoutMs != null) proxyOpts.timeoutMs = options.timeoutMs
      return await gatewayProxy(
        method,
        pathPart,
        body,
        query,
        Object.keys(proxyOpts).length ? proxyOpts : null,
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e?.message || e))
      if (e?.status != null) err.status = e.status
      err.url = url
      err.body = e?.gatewayResult ?? e?.body
      throw err
    }
  }
  // Browser/Vite: must attach WebUI JWT too. Without it, localhost Gateway
  // treats the caller as local-admin and new sessions are stamped to admin
  // while /api/identity/me (via gatewayProxy) still shows user1.
  const resp = await fetch(url, { ...options, headers: _authHeaders(options) })
  const text = await resp.text().catch(() => '')
  const data = text ? safeParseJSON(text, null) : null
  if (!resp.ok) {
    const msg = data?.detail || data?.error || data?.message || `HTTP ${resp.status}`
    const err = new Error(msg)
    // Attach useful diagnostics for callers (e.g. clear stale threadId on 404).
    err.status = resp.status
    err.url = url
    err.body = data
    throw err
  }
  return data
}

function isLangGraphThreadOrAssistantMissing(err) {
  if (!err) return false
  if (err.status === 404) return true
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('thread or assistant not found') ||
    (msg.includes('not found') && (msg.includes('thread') || msg.includes('assistant')))
  )
}

/** Append one user transcript row (HTTP clients may only write role=user). */
export async function appendSessionTranscriptMessage(sessionKey, flatRow, { runId, threadId } = {}) {
  const key = String(sessionKey || '').trim()
  if (!key || !flatRow) return
  const role = String(flatRow.role || '').trim().toLowerCase()
  if (role && role !== 'user') {
    console.debug('[evoflow] skip non-user transcript append (TranscriptMiddleware owns assistant/tool)', role)
    return
  }
  const payload = {
    role: flatRow.role,
    contentJson: flatRow.contentJson || flatRow.content_json || undefined,
    messageId: flatRow.messageId,
    toolCallId: flatRow.toolCallId,
    toolName: flatRow.toolName,
    modelName: flatRow.modelName,
    inputTokens: flatRow.inputTokens,
    outputTokens: flatRow.outputTokens,
    totalTokens: flatRow.totalTokens,
    runId: flatRow.runId || runId || null,
    threadId: threadId || null,
  }
  let lastErr = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return
    } catch (e) {
      lastErr = e
      // 用统一分类区分根因：客户端网络错误 / 服务端不可达(502,503) / 服务端内部错误(500,database locked)
      const netCode = classifyNetworkError(e, { status: e?.status })
      const msg = String(e?.message || e || '').toLowerCase()
      const isServiceUnreachable = netCode === NetworkErrorCode.SERVICE_UNREACHABLE
      const isServiceInternal =
        netCode === NetworkErrorCode.SERVICE_INTERNAL ||
        msg.includes('database') ||
        msg.includes('locked') ||
        msg.includes('busy')
      const isClientNetwork = netCode === NetworkErrorCode.CLIENT_NETWORK
      // 502/503：服务未启动，限制最多 3 次重试，避免疯狂重试
      if (isServiceUnreachable && attempt >= 2) break
      // 客户端网络错误：可重试，但增加退避间隔（2 倍退避）
      // 服务端内部错误：保持现有重试逻辑（最多 8 次）
      const retryable = isServiceUnreachable || isServiceInternal || isClientNetwork
      if (!retryable || attempt >= 7) break
      // 客户端网络错误退避更长；服务端不可达/内部错误保持原退避
      const backoff = isClientNetwork ? 300 * (attempt + 1) * 2 : 120 * (attempt + 1)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
  throw lastErr
}

/**
 * Enqueue a user message into the pending-inject queue (↑ immediate steering).
 *
 * Unlike ``appendSessionTranscriptMessage`` which writes directly into
 * ``evoflow_chat_messages``, this puts the message into a side queue that
 * gets atomically drained and inserted with proper seq ordering at the next
 * ``before_model`` hydration pass. This avoids mid-stream timeline
 * interleaving where a user row would sit between partial assistant/tool rows.
 *
 * @param {string} sessionKey
 * @param {object} flatRow  — same shape as transcript flat row but only
 *   ``content`` / ``contentJson`` / ``messageId`` / ``toolName`` / ``runId`` /
 *   ``threadId`` are used (role is always ``user``).
 * @returns {Promise<{ ok: boolean, enqueued: boolean, messageId: string } | undefined>}
 */
export async function enqueuePendingInject(sessionKey, flatRow) {
  const key = String(sessionKey || '').trim()
  if (!key || !flatRow) return
  const payload = {
    content: flatRow.content,
    contentJson: flatRow.contentJson || flatRow.content_json || undefined,
    messageId: flatRow.messageId,
    toolName: flatRow.toolName,
    runId: flatRow.runId || null,
    threadId: flatRow.threadId || null,
  }
  let lastErr = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetchJson(
        `/api/chat/sessions/${encodeURIComponent(key)}/pending-inject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      return res
    } catch (e) {
      lastErr = e
      const netCode = classifyNetworkError(e, { status: e?.status })
      const msg = String(e?.message || e || '').toLowerCase()
      const isServiceUnreachable = netCode === NetworkErrorCode.SERVICE_UNREACHABLE
      const isServiceInternal =
        netCode === NetworkErrorCode.SERVICE_INTERNAL ||
        msg.includes('database') ||
        msg.includes('locked') ||
        msg.includes('busy')
      const isClientNetwork = netCode === NetworkErrorCode.CLIENT_NETWORK
      if (isServiceUnreachable && attempt >= 2) break
      const retryable = isServiceUnreachable || isServiceInternal || isClientNetwork
      if (!retryable || attempt >= 5) break
      const backoff = isClientNetwork ? 300 * (attempt + 1) * 2 : 100 * (attempt + 1)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
  console.warn('[evoflow] enqueue pending inject failed', lastErr)
  throw lastErr || new Error('enqueue pending inject failed')
}

/**
 * Query pending-inject status for a session (how many unconsumed, last consumed info).
 *
 * Used by the frontend to decide whether a ↑ message has already been seen
 * by the model — replaces the old heuristic of scanning UI rows for an
 * assistant after the injected user.
 *
 * @param {string} sessionKey
 * @returns {Promise<{ ok: boolean, pendingCount: number, lastConsumed: { messageId: string, consumedAt?: string, consumedByRunId?: string } | null } | undefined>}
 */
export async function getPendingInjectStatus(sessionKey) {
  const key = String(sessionKey || '').trim()
  if (!key) return
  try {
    const raw = await fetchJson(
      `/api/chat/sessions/${encodeURIComponent(key)}/pending-inject/status`,
    )
    if (!raw || typeof raw !== 'object') return raw
    const lc = raw.lastConsumed
    if (lc && typeof lc === 'object') {
      // 兼容旧后端 snake_case，统一成 camelCase 供 ChatApp drain 使用
      raw.lastConsumed = {
        messageId: lc.messageId || lc.message_id || null,
        consumedAt: lc.consumedAt || lc.consumed_at || null,
        consumedByRunId: lc.consumedByRunId || lc.consumed_by_run_id || null,
      }
    }
    if (Array.isArray(raw.items)) {
      raw.items = raw.items.map((it) => ({
        messageId: String(it?.messageId || it?.message_id || '').trim(),
        text: String(it?.text || '').trim(),
        createdAt: it?.createdAt || it?.created_at || null,
        runId: it?.runId || it?.run_id || null,
      }))
    }
    return raw
  } catch (e) {
    console.debug('[evoflow] get pending inject status failed', e)
    return undefined
  }
}

/**
 * Pop unconsumed steers for interrupt→composer restore (runtime-aligned).
 * Deletes SQLite pending rows so the next turn does not drain them again.
 *
 * @param {string} sessionKey
 * @returns {Promise<{ ok: boolean, restored: Array<{ messageId: string, text: string }>, count: number } | undefined>}
 */
export async function restorePendingInjects(sessionKey) {
  const key = String(sessionKey || '').trim()
  if (!key) return
  try {
    const raw = await fetchJson(
      `/api/chat/sessions/${encodeURIComponent(key)}/pending-inject/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    )
    if (!raw || typeof raw !== 'object') return raw
    const restored = Array.isArray(raw.restored)
      ? raw.restored
          .map((it) => ({
            messageId: String(it?.messageId || it?.message_id || '').trim(),
            text: String(it?.text || '').trim(),
          }))
          .filter((it) => it.text)
      : []
    return { ok: Boolean(raw.ok), restored, count: restored.length, sessionKey: key }
  } catch (e) {
    console.debug('[evoflow] restore pending injects failed', e)
    return undefined
  }
}



/** Gateway ``/api/trace/*`` 客户端埋点；暂关前端上报，后端接口保留。 */
const CLIENT_TRACE_REPORTS_ENABLED = false

async function reportClientFirstTokenTiming(_payload) {
  if (!CLIENT_TRACE_REPORTS_ENABLED) return
}

async function reportClientStreamEndTiming(_payload) {
  if (!CLIENT_TRACE_REPORTS_ENABLED) return
}

function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), Math.max(1, timeoutMs | 0))
  })
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer)
    }),
    timeout,
  ])
}

/** 仅 assistant 正文（不含 reasoning / thinking 块） */
function sanitizeAssistantBodyText(raw) {
  return stripLegacyEmbeddedReasoningPrefix(
    stripThinkingTags(unwrapAssistantContentJsonEnvelope(String(raw || ''))),
  )
}

/** 仅 assistant 正文（不含 reasoning_content；思考走 reasoning 通道 + ReasoningInlineBlock） */
function extractAssistantMainText(message) {
  if (!message) return ''
  const body = resolveHistoryMessageContent(message)
  if (typeof body === 'string') {
    return sanitizeAssistantBodyText(body)
  }
  if (Array.isArray(body)) {
    return sanitizeAssistantBodyText(
      body
        .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text)
        .join('\n'),
    )
  }
  if (typeof message.text === 'string') {
    return sanitizeAssistantBodyText(message.text)
  }
  return ''
}

/** @deprecated 请用 extractAssistantMainText；保留别名避免外部脚本依赖 */
function extractAssistantText(message) {
  return extractAssistantMainText(message)
}

/** LangGraph 流式：AIMessageChunk / ai / assistant */
function isLangGraphStreamAiPart(m) {
  if (!m || typeof m !== 'object') return false
  const t = m.type
  return t === 'ai' || t === 'AIMessageChunk' || t === 'AIMessage' || m.role === 'assistant'
}

/**
 * 从单条流式消息取增量文本（content 可为 string 或 block 数组；数组里也可能混 string 块）
 */
function textFromLangGraphStreamPart(obj) {
  if (!obj || typeof obj !== 'object') return ''
  // 流式片段不可 .trim()，否则单独的 \n\n 会被丢掉
  const clean = (s) =>
    stripLegacyEmbeddedReasoningPrefix(
      stripThinkingTagsPreserveNewlines(unwrapAssistantContentJsonEnvelope(String(s || ''))),
    )
  if (typeof obj.content === 'string') return clean(obj.content)
  if (!Array.isArray(obj.content)) return extractAssistantText(obj)
  return clean(
    obj.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && part.type === 'thinking') return ''
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text
        return ''
      })
      .join(''),
  )
}

function textFromStreamAiPayload(obj) {
  return textFromLangGraphStreamPart(obj)
}

/**
 * LangGraph /messages/stream 常见形态：
 * - 数组元组（旧）
 * - 单条 { type: 'ai'|'tool', content, ... }（与 embedded client / 新版 SDK 一致）
 * - ['namespace', { type: 'ai', ... }]
 */
function unwrapMessagesTupleStreamMeta(data) {
  if (Array.isArray(data) && data.length >= 2 && data[1] && typeof data[1] === 'object' && !Array.isArray(data[1])) {
    const meta = data[1]
    if (meta.type || meta.role) return null
    return meta
  }
  return null
}

/** LangGraph tools-node nested LLM (view_image vision) — not user-facing assistant reply. */
function isNestedToolNodeMessagesStream(dataOrMeta) {
  const meta =
    dataOrMeta && typeof dataOrMeta === 'object' && !Array.isArray(dataOrMeta) && dataOrMeta.langgraph_node != null
      ? dataOrMeta
      : unwrapMessagesTupleStreamMeta(dataOrMeta)
  if (!meta) return false
  return String(meta.langgraph_node || '').trim().toLowerCase() === 'tools'
}

function unwrapMessagesTupleRoot(data) {
  // Common shape from LangGraph SSE "messages":
  // [ {type:'AIMessageChunk'|'ai'|'tool', ...}, { ...metadata... } ]
  if (
    Array.isArray(data) &&
    data.length === 2 &&
    data[0] &&
    typeof data[0] === 'object' &&
    !Array.isArray(data[0]) &&
    data[1] &&
    typeof data[1] === 'object' &&
    !Array.isArray(data[1])
  ) {
    const first = data[0]
    if (first.type || first.role) return first
  }
  if (Array.isArray(data) && data.length === 2 && typeof data[0] === 'string' && typeof data[1] === 'object' && data[1] !== null && !Array.isArray(data[1])) {
    const inner = data[1]
    if (inner.type || inner.role) return inner
  }
  // Handle nested tuple: [['namespace', {type:'ai',...}], metadata]
  // LangGraph sometimes wraps the message in an extra array layer
  if (Array.isArray(data) && data.length === 2) {
    const first = data[0]
    if (Array.isArray(first) && first.length === 2) {
      const inner = first[1]
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && (inner.type || inner.role)) {
        return inner
      }
    }
  }
  return data
}

function isAssistantMessage(m) {
  if (!m || typeof m !== 'object') return false
  // LangGraph streams may emit various assistant message shapes:
  // - { type: 'ai', ... } (new)
  // - { type: 'AIMessageChunk'|'AIMessage', ... } (LangChain/LangGraph)
  // - { role: 'assistant', ... } (fallback)
  const t = String(m.type || '').trim()
  return m.role === 'assistant' || t === 'ai' || t === 'AIMessageChunk' || t === 'AIMessage'
}

/**
 * 单轮 LangGraph SSE：合并 `event: end` 与各帧 AI 的 usage_metadata，供 chat/final 展示 token。
 * 按 message id 保留同 id 最新一条，再对多 id 求和（多轮模型调用）。
 */
function createLangGraphRunUsageAccumulator() {
  let streamEndUsageOverride = null
  const streamUsageByAiId = new Map()
  const tripletFromUsageObj = (um) => usageTripletFromStreamPart({ usage_metadata: um }) || usageWirePayloadFromTriplet(normalizeUsage(um))
  return {
    recordAiPart(part) {
      if (!part || typeof part !== 'object') return
      const t = usageTripletFromStreamPart(part)
      if (!t) return
      const id = part.id != null && String(part.id) !== '' ? String(part.id) : '__noid__'
      streamUsageByAiId.set(id, t)
    },
    absorbMessagesAfterHuman(messages, humanIdx) {
      if (!Array.isArray(messages) || humanIdx < 0) return
      for (let i = humanIdx + 1; i < messages.length; i++) {
        const m = messages[i]
        if (isAssistantMessage(m)) this.recordAiPart(m)
      }
    },
    absorbEndEvent(data) {
      if (!data || typeof data !== 'object') return
      const t =
        tripletFromUsageObj(data.usage) ||
        tripletFromUsageObj(data.usage_metadata) ||
        tripletFromUsageObj(data)
      if (t) streamEndUsageOverride = t
    },
    tripletForFinal() {
      if (streamEndUsageOverride) return streamEndUsageOverride
      let input = 0
      let output = 0
      let total = 0
      let cacheRead = 0
      let cacheCreation = 0
      let cacheMiss = 0
      for (const t of streamUsageByAiId.values()) {
        input += t.input_tokens
        output += t.output_tokens
        total += t.total_tokens
        cacheRead += t.cache_read_tokens || 0
        cacheCreation += t.cache_creation_tokens || 0
        cacheMiss += t.cache_miss_tokens || 0
      }
      if (!input && !output && !total) return null
      const out = { input_tokens: input, output_tokens: output, total_tokens: total }
      if (cacheRead) out.cache_read_tokens = cacheRead
      if (cacheCreation) out.cache_creation_tokens = cacheCreation
      if (cacheMiss) out.cache_miss_tokens = cacheMiss
      return out
    },
  }
}

/** 从后往前最后一条 AI 消息（用于展示当前轮正文） */
function findLastAssistantMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessage(messages[i])) return messages[i]
  }
  return null
}

/** 与 chat-normalize ``isInjectedCheckpointHuman`` 对齐：压缩摘要 / 工具历史块等不算真实用户轮次 */
function isInjectedUiHumanMessage(m) {
  if (!isHumanMessage(m)) return false
  return isInjectedCheckpointHuman(m)
}

function isSystemLikeUiMessage(m) {
  if (!m || typeof m !== 'object') return false
  const t = m.type
  const r = m.role
  if (t === 'system' || r === 'system') return true
  const tl = typeof t === 'string' ? t.toLowerCase() : ''
  return tl === 'systemmessage'
}

/** 协作阶段提示等常紧跟在新 user 之后；从末尾剥掉这些段，避免 deriveActivity / tool 聚合误命中上一轮 assistant */
function lastSubstantiveIndexAfterHuman(messages, humanIdx) {
  if (!Array.isArray(messages) || humanIdx < 0) return humanIdx
  let end = messages.length - 1
  while (end > humanIdx) {
    const m = messages[end]
    if (isSystemLikeUiMessage(m) || (isHumanMessage(m) && isInjectedUiHumanMessage(m))) {
      end--
      continue
    }
    break
  }
  return end
}

/**
 * 最后一条真实 user 与「末尾实质消息」之间是否已有图推进（hint / tool 回包 / 中间 assistant 等）。
 * 新提问后 checkpoint 常见 [user_new, 上一轮带满 tool_calls 的 assistant] 紧挨着，此时应禁止从 values 下发工具，等 messages-tuple 或出现 hint 后再认。
 */
function hasGraphProgressBetweenUserAndLastSubstantive(messages, humanIdx) {
  if (!Array.isArray(messages) || humanIdx < 0) return false
  const lastSub = lastSubstantiveIndexAfterHuman(messages, humanIdx)
  if (lastSub <= humanIdx) return false
  // [user_new, 上一轮 assistant+tool_calls]：末尾 assistant 紧挨新 user，不算本轮图推进。
  if (lastSub === humanIdx + 1 && isAssistantMessage(messages[lastSub])) return false
  if (!isAssistantMessage(messages[lastSub])) return true
  for (let i = humanIdx + 1; i < lastSub; i++) {
    const m = messages[i]
    if (isInjectedUiHumanMessage(m)) return true
    if (isSystemLikeUiMessage(m)) continue
    if (isToolMessage(m)) return true
    if (isHumanMessage(m) && !isInjectedUiHumanMessage(m)) return true
    if (isAssistantMessage(m)) return true
  }
  return false
}

function wsDebugValuesEnabled() {
  return typeof localStorage !== 'undefined' && localStorage.getItem('EVOFLOW_WS_DEBUG_VALUES') === '1'
}

/**
 * 仅取 humanIdx 之后的最后一条 assistant。
 * values 快照在「新用户句尚未写入」时末尾仍是上一轮 AI；若用全文 last assistant 会把旧回答 merge 进本轮流式。
 */
function findLastAssistantAfterIndex(messages, humanIdx) {
  if (!Array.isArray(messages) || humanIdx < 0) return null
  const lastSub = lastSubstantiveIndexAfterHuman(messages, humanIdx)
  if (lastSub <= humanIdx) return null
  for (let i = lastSub; i > humanIdx; i--) {
    if (isAssistantMessage(messages[i])) return messages[i]
  }
  return null
}

/** 最后一条 human 之前、最近的 assistant（通常即「上一轮」助手回复），用于剥离误拼进本轮流的正文前缀 */
function findLastAssistantBeforeIndex(messages, beforeIdx) {
  if (!Array.isArray(messages) || beforeIdx <= 0) return null
  for (let i = beforeIdx - 1; i >= 0; i--) {
    if (isAssistantMessage(messages[i])) return messages[i]
  }
  return null
}

const MIN_PREV_ASSISTANT_STRIP_LEN = 1
const EMPTY_WS_PRIOR_STRIP = { body: '', reasoning: '', toolIds: [] }
/** 多题 ask_clarification 表单 JSON 常超过 2k；截断会导致侧栏无法解析 */
const CLARIFY_PREVIEW_MAX_LEN = 120000

function clarifyPreviewForEmit(preview) {
  const s = String(preview || '').trim()
  if (!s) return ''
  return s.length <= CLARIFY_PREVIEW_MAX_LEN ? s : s.slice(0, CLARIFY_PREVIEW_MAX_LEN)
}

function accumulatedToolCallForLane(lane, toolCallId) {
  const idKey = String(toolCallId || '').trim()
  if (!idKey || !lane?.toolCallAccumById) return null
  if (lane.toolCallAccumById.has(idKey)) return lane.toolCallAccumById.get(idKey)
  for (const v of lane.toolCallAccumById.values()) {
    if (String(v?.id || v?.tool_call_id || '').trim() === idKey) return v
  }
  return null
}

function resolveAskClarificationPreviewForLane(toolData, lane, toolCallId) {
  const acc = accumulatedToolCallForLane(lane, toolCallId)
  const input =
    readAskClarificationInput(toolData) || (acc ? readAskClarificationInput(acc) : null)
  return resolveClarificationPreview({
    tools: [
      {
        name: 'ask_clarification',
        input,
        output: toolData?.content ?? toolData?.output,
        content: toolData?.content,
        id: toolCallId,
      },
    ],
  })
}

function priorTurnStripBundleFromSendOpts(opts) {
  if (!opts || typeof opts !== 'object') return EMPTY_WS_PRIOR_STRIP
  if (opts.priorTurnStripBundle) return normalizePriorTurnStripBundle(opts.priorTurnStripBundle)
  const body = String(opts.priorAssistantPrefix || '').trim()
  const reasoning = String(opts.priorAssistantReasoning || '').trim()
  if (!body && !reasoning) return EMPTY_WS_PRIOR_STRIP
  return { body, reasoning, toolIds: [] }
}

function priorTurnStripBundleFromTranscriptAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return EMPTY_WS_PRIOR_STRIP
  const body = String(anchor.persistedTurnText || '').trim()
  const toolIds = Array.isArray(anchor.persistedToolCallIds)
    ? anchor.persistedToolCallIds.map((id) => String(id)).filter(Boolean)
    : []
  if (!body && !toolIds.length) return EMPTY_WS_PRIOR_STRIP
  return { body, reasoning: '', toolIds }
}

function applyTranscriptAnchorStripToLane(lane, anchor) {
  const bundle = priorTurnStripBundleFromTranscriptAnchor(anchor)
  if (!bundle.body && !bundle.toolIds.length) return
  lane.priorTurnStripBundle = bundle
  lane.priorTurnStripPrefix = pickRichestAssistantStripPrefix(bundle.body)
}

function stripWsPriorTurnPollutants(text, bundle) {
  const b = normalizePriorTurnStripBundle(bundle)
  if (!b.body && !b.reasoning) return String(text || '')
  return stripPriorTurnPollutants(String(text || ''), b)
}

function pickRichestAssistantStripPrefix(...candidates) {
  const list = candidates
    .map((c) => String(c || '').trim())
    .filter((c) => c.length >= MIN_PREV_ASSISTANT_STRIP_LEN)
  if (!list.length) return ''
  let best = list[0]
  for (let i = 1; i < list.length; i++) {
    const cur = list[i]
    if (!cur) continue
    if (cur.startsWith(best) || best.startsWith(cur)) {
      best = cur.length >= best.length ? cur : best
    } else if (cur.length > best.length) {
      best = cur
    }
  }
  return best
}

function stripLeadingPreviousAssistantText(streamText, prefix) {
  const p = typeof prefix === 'string' ? prefix : ''
  const s = typeof streamText === 'string' ? streamText : ''
  if (!p || p.trim().length < MIN_PREV_ASSISTANT_STRIP_LEN || !s) return s
  if (s.startsWith(p)) {
    return s.slice(p.length).replace(/^[\s\n\r]+/, '')
  }
  const np = normalizeLooseText(p)
  const ns = normalizeLooseText(s)
  if (np.length >= MIN_PREV_ASSISTANT_STRIP_LEN && ns.startsWith(np) && ns.length > np.length) {
    const probe = p.slice(0, Math.min(240, p.length)).trim()
    if (probe.length >= 20) {
      const idx = s.indexOf(probe)
      if (idx >= 0 && idx < 48) {
        return s.slice(idx + probe.length).replace(/^[\s\n\r]+/, '')
      }
    }
  }
  return s
}

/** 本轮 user 之后每条 assistant 的可见正文（与历史回放 merge 规则一致） */
function collectAssistantTextsAfterHuman(messages, humanIdx, stripPrefix) {
  if (!Array.isArray(messages) || humanIdx < 0) return []
  const texts = []
  for (let i = humanIdx + 1; i < messages.length; i++) {
    if (!isAssistantMessage(messages[i])) continue
    const row = messages[i]
    const t = stripLeadingPreviousAssistantText(extractAssistantText(row), stripPrefix).trim()
    if (!t) continue
    const r = extractReasoningPreview(row)
    if (r && t.replace(/\s+/g, ' ') === r.replace(/\s+/g, ' ')) continue
    texts.push(t)
  }
  return texts
}

/** 合并同轮多条 assistant 快照（覆盖递增 / 语义差异则换行拼接） */
function mergeTurnAssistantTextsForDisplay(texts) {
  if (!Array.isArray(texts) || !texts.length) return ''
  let acc = String(texts[0] || '').trim()
  for (let i = 1; i < texts.length; i++) {
    const next = String(texts[i] || '').trim()
    if (!next) continue
    if (!acc) {
      acc = next
      continue
    }
    if (next.startsWith(acc)) acc = next
    else if (acc.startsWith(next)) continue
    else if (acc.replace(/\s+/g, ' ').includes(next.replace(/\s+/g, ' '))) continue
    else if (next.replace(/\s+/g, ' ').includes(acc.replace(/\s+/g, ' '))) acc = next
    else acc = [acc, next].filter(Boolean).join('\n\n')
  }
  return acc.trim()
}

/** final 展示：取最完整的一份（流式累计 vs values 末条 vs 本轮合并） */
function pickRichestAssistantDisplayText(...candidates) {
  const list = candidates.map((c) => String(c || '').trim()).filter(Boolean)
  if (!list.length) return ''
  let best = list[0]
  for (let i = 1; i < list.length; i++) {
    const cur = list[i]
    if (!cur) continue
    if (cur.length > best.length) best = cur
    else if (cur.startsWith(best)) best = cur
    else if (best.startsWith(cur)) continue
    else if (cur.replace(/\s+/g, ' ').includes(best.replace(/\s+/g, ' '))) best = cur
    else if (best.replace(/\s+/g, ' ').includes(cur.replace(/\s+/g, ' '))) continue
    else if (cur !== best) best = [best, cur].filter(Boolean).join('\n\n')
  }
  return best.trim()
}

/**
 * 状态中「最后一条 human」是否就是本轮输入。
 * 禁用 includes：否则旧用户文中的子串会误判为新提问，从而把上一轮 assistant 灌进本轮。
 */
function lastHumanMatchesRunInput(messages, rawUserMessage) {
  const humanIdx = findLastNonCollabHumanIndex(messages)
  if (humanIdx < 0) return false
  const humanTextNorm = normalizeLooseText(messageTextForMatch(messages[humanIdx]))
  const expected = normalizeLooseText(rawUserMessage || '')
  if (expected) return humanTextNorm === expected
  return humanTextNorm === ''
}

/** 从后往前最后一条「真实用户」消息（排除 collab_phase_hint），用于界定当前轮 */
function findLastNonCollabHumanIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isHumanMessage(m)) continue
    if (isInjectedCheckpointHuman(m)) continue
    return i
  }
  return -1
}

/**
 * LangGraph values 多帧里同一 tool_call_id 常被后续「仅 id+name / args:{}」快照覆盖；
 * 合并时保留参数更丰富的那一帧，否则前端 upsert 永远只看到空入参。
 */
function mergeToolCallPreferRicher(prev, next) {
  if (!prev || typeof prev !== 'object') return next
  if (!next || typeof next !== 'object') return prev
  const objKeyCount = (o) =>
    o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).length : 0
  const directKeys = (t) =>
    Math.max(
      objKeyCount(t.args),
      objKeyCount(t.input),
      objKeyCount(t.parameters),
      objKeyCount(t.kwargs),
    )
  const faLen = (t) =>
    t.function && typeof t.function.arguments === 'string' ? t.function.arguments.length : 0
  const contentLen = (t) => {
    const a = normalizeStreamToolCallArgs(t)
    if (!a || typeof a !== 'object' || Array.isArray(a)) return 0
    const c = a.content ?? a.new_string ?? a.text
    return typeof c === 'string' ? c.length : 0
  }
  const richness = (t) =>
    directKeys(t) * 100000 + Math.min(faLen(t), 500000) + contentLen(t)
  const rp = richness(prev)
  const rn = richness(next)
  if (rn > rp) return next
  if (rp > rn) return prev
  const fp = faLen(prev)
  const fn = faLen(next)
  if (fn > fp) return next
  if (fp > fn) return prev
  return prev
}

function stripAnsiStreamWs(text) {
  if (!text) return ''
  const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g')
  return String(text).replace(ANSI_RE, '')
}

/**
 * messages / messages-tuple 流：同一 tool_call_id 常见「先下发 id+name，再在后续帧补 args / function.arguments」。
 * mergeToolCallPreferRicher 只做整帧择优，无法把分片 JSON 拼起来；emit 前在此累积。
 */
function mergeMessagesTupleToolCallAccum(prev, next) {
  if (!next || typeof next !== 'object') return prev
  if (!prev || typeof prev !== 'object') return { ...next }
  const mergeObjField = (p, n) => {
    if (n == null) return p
    if (typeof p === 'string' && typeof n === 'string') {
      return mergeStreamingToolCallArgStrings(p, n)
    }
    if (typeof n === 'object' && !Array.isArray(n) && Object.keys(n).length === 0) return p != null ? p : n
    if (typeof p === 'object' && p !== null && !Array.isArray(p) && typeof n === 'object' && n !== null && !Array.isArray(n)) {
      return mergeToolCallArgsObjects(p, n)
    }
    return n
  }
  const out = { ...prev }
  out.args = mergeObjField(prev.args, next.args)
  out.input = mergeObjField(prev.input, next.input)
  out.parameters = mergeObjField(prev.parameters, next.parameters)
  out.kwargs = mergeObjField(prev.kwargs, next.kwargs)
  const skip = new Set(['args', 'input', 'parameters', 'kwargs', 'function'])
  const keepPrevIfEmpty = new Set(['id', 'tool_call_id', 'name', 'type'])
  for (const k of Object.keys(next)) {
    if (skip.has(k)) continue
    if (next[k] === undefined) continue
    if (keepPrevIfEmpty.has(k) && (next[k] == null || String(next[k]).trim() === '')) continue
    out[k] = next[k]
  }
  const pfn = prev.function && typeof prev.function === 'object' ? prev.function : null
  const nfn = next.function && typeof next.function === 'object' ? next.function : null
  if (pfn || nfn) {
    const fn = { ...(pfn || {}), ...(nfn || {}) }
    const ps = pfn && typeof pfn.arguments === 'string' ? pfn.arguments : ''
    const ns = nfn && typeof nfn.arguments === 'string' ? nfn.arguments : ''
    if (ps || ns) {
      fn.arguments = mergeStreamingToolCallArgStrings(ps, ns)
    }
    if (!String(fn.name || '').trim() && pfn && String(pfn.name || '').trim()) {
      fn.name = pfn.name
    }
    out.function = fn
  }
  return out
}

/** LangGraph tool_call_chunk：首帧带 id/name，后续帧常只有 args 片段 + index。 */
function resolveToolCallAccumKey(lane, tc, chunkMeta) {
  const id = tc?.id || tc?.tool_call_id
  const idStr = id != null && String(id).trim() !== '' ? String(id).trim() : ''
  const idxRaw = chunkMeta && chunkMeta.index != null ? Number(chunkMeta.index) : NaN
  const idx = Number.isFinite(idxRaw) ? idxRaw : null
  if (!lane.toolCallIndexToKey) lane.toolCallIndexToKey = new Map()
  if (!lane.toolCallAccumById) lane.toolCallAccumById = new Map()
  if (idStr) {
    if (idx != null) {
      const prevKey = lane.toolCallIndexToKey.get(idx)
      if (prevKey && prevKey !== idStr && lane.toolCallAccumById.has(prevKey)) {
        const prevIsSynthetic = prevKey.startsWith('idx:') || prevKey.startsWith('anon:')
        if (prevIsSynthetic) {
          const orphan = lane.toolCallAccumById.get(prevKey)
          const existing = lane.toolCallAccumById.get(idStr)
          lane.toolCallAccumById.set(idStr, mergeMessagesTupleToolCallAccum(existing, orphan))
          lane.toolCallAccumById.delete(prevKey)
        }
      }
      lane.toolCallIndexToKey.set(idx, idStr)
    }
    return idStr
  }
  if (idx != null && lane.toolCallIndexToKey.has(idx)) {
    return lane.toolCallIndexToKey.get(idx)
  }
  const name = String(tc?.name || (tc?.function && tc.function.name) || '').trim()
  if (idx != null) return `idx:${idx}:${name || 'tool'}`
  return `anon:${name || 'tool'}`
}

/**
 * 聚合当前轮内所有 assistant 上的 tool_calls（按 id 去重，顺序为首次出现）。
 * 解决「多段 AI、每段一个 tool_call」时只取到最后一条 AI 的 tool_calls 的问题。
 */
function collectToolCallsForTurnAfterLastUser(messages) {
  const start = findLastNonCollabHumanIndex(messages)
  if (start < 0) return null
  const end = lastSubstantiveIndexAfterHuman(messages, start)
  if (end <= start) return null
  // [user_new, 上一轮 assistant+tool_calls]：勿把旧轮 tool_calls 算进本轮（values 快照常见，会导致每轮误显 scenario 等）
  if (end === start + 1 && isAssistantMessage(messages[end])) {
    const prevTurnAi = findLastAssistantBeforeIndex(messages, start)
    if (prevTurnAi && prevTurnAi === messages[end]) return null
  }
  const byId = new Map()
  const order = []
  for (let i = start + 1; i <= end; i++) {
    const m = messages[i]
    if (!isAssistantMessage(m)) continue
    const tc = m.tool_calls || m.toolCalls
    if (!Array.isArray(tc) || !tc.length) continue
    tc.forEach((c, j) => {
      if (!c || typeof c !== 'object') return
      const cid = c.id || c.tool_call_id
      const key = cid != null && cid !== '' ? String(cid) : `__anon__:${i}:${j}`
      if (!byId.has(key)) order.push(key)
      byId.set(key, mergeToolCallPreferRicher(byId.get(key), c))
    })
  }
  if (!order.length) return null
  return order.map((k) => byId.get(k))
}

/** 流式 values 上合并 ``messages`` 与 pickDisplayMessages 结果，补齐 tool_calls args。 */
function collectToolCallsMergedFromValuesRoot(raw) {
  if (!raw || typeof raw !== 'object') return null
  const seenArrays = new Set()
  const arrays = []
  const pushArr = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return
    if (seenArrays.has(arr)) return
    seenArrays.add(arr)
    arrays.push(arr)
  }
  pushArr(pickDisplayMessages(raw))
  pushArr(raw.messages)

  const byId = new Map()
  const order = []
  for (const messages of arrays) {
    const chunk = collectToolCallsForTurnAfterLastUser(messages)
    if (!Array.isArray(chunk)) continue
    for (const c of chunk) {
      if (!c || typeof c !== 'object') continue
      const cid = c.id || c.tool_call_id
      if (cid == null || cid === '') continue
      const key = String(cid)
      if (!byId.has(key)) order.push(key)
      byId.set(key, mergeToolCallPreferRicher(byId.get(key), c))
    }
  }
  if (!order.length) return null
  return order.map((k) => byId.get(k))
}

/**
 * 从 checkpoint/values messages 切片「当前轮」（last non-collab human 之后）。
 * 所有面向 ChatApp 的正文/思考/工具 emit 应基于此结果，避免整段 thread 累积灌入 UI。
 */
export function sliceMessagesForCurrentTurn(messages) {
  const humanIdx = findLastNonCollabHumanIndex(messages)
  if (humanIdx < 0) {
    return {
      humanIdx: -1,
      prevAssistantPrefix: '',
      assistantText: '',
      mergedTurnText: '',
      reasoningPreview: null,
      toolCalls: null,
    }
  }
  const prevAi = humanIdx > 0 ? findLastAssistantBeforeIndex(messages, humanIdx) : null
  const prevAssistantPrefix = prevAi ? extractAssistantText(prevAi) : ''
  const lastAi = findLastAssistantAfterIndex(messages, humanIdx)
  let assistantText = lastAi ? extractAssistantText(lastAi) : ''
  if (assistantText && prevAssistantPrefix) {
    assistantText = stripLeadingPreviousAssistantText(assistantText, prevAssistantPrefix)
  }
  const turnTexts = collectAssistantTextsAfterHuman(messages, humanIdx, prevAssistantPrefix)
  const mergedTurnText = mergeTurnAssistantTextsForDisplay(turnTexts)
  const reasoningPreview = lastAi ? extractReasoningPreview(lastAi) : null
  const toolCalls = collectToolCallsForTurnAfterLastUser(messages)
  const displayText = (assistantText || mergedTurnText || '').trim()
  return {
    humanIdx,
    prevAssistantPrefix,
    assistantText: displayText,
    mergedTurnText,
    reasoningPreview: reasoningPreview || null,
    toolCalls: Array.isArray(toolCalls) ? toolCalls : null,
  }
}

/** OpenAI/LC 流式 tool_call：args / input 或 function.arguments（args 常为占位 {}，须回退到 function.arguments） */
function normalizeStreamToolCallArgs(tc) {
  if (!tc || typeof tc !== 'object') return {}
  const direct = tc.args ?? tc.input ?? tc.parameters ?? tc.kwargs
  const directEmpty =
    direct == null ||
    (typeof direct === 'object' &&
      !Array.isArray(direct) &&
      Object.keys(direct).length === 0)
  if (!directEmpty && typeof direct === 'object' && !Array.isArray(direct)) return direct
  const fn = tc.function
  if (fn && typeof fn.arguments === 'string' && fn.arguments.trim()) {
    try {
      const p = JSON.parse(fn.arguments)
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
    } catch {
      return {}
    }
  }
  if (fn && fn.arguments != null && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
    return fn.arguments
  }
  if (direct != null && typeof direct === 'object' && !Array.isArray(direct)) return direct
  return {}
}

/**
 * messages-tuple 流式首帧常见仅有 id+name，args 尚为 {}；supervisor 需有 args 后再展示。
 * write_to_file 等：有工具名或 function.arguments 片段即可展示并随参数增长更新。
 */
/** Keep in sync with backend ``sse_ui_normalize._WRITE_STREAM_TOOL_NAMES``. */
const WRITE_STREAM_TOOL_NAMES = new Set([
  'write',
  'write_to_file',
  'write_file',
  'replace',
  'str_replace',
  'replace_in_file',
])

function writeStreamToolContentLen(tc) {
  const fn = tc?.function
  const fa =
    fn && typeof fn === 'object' && typeof fn.arguments === 'string' ? fn.arguments : ''
  if (fa.trim()) {
    const loose = extractContentLikeFromPartialJsonString(fa)
    if (loose?.content) return String(loose.content).length
  }
  const args = normalizeStreamToolCallArgs(tc)
  return String(args.content || args.new_string || args.contents || '').length
}

function streamToolCallReadyForUi(tc) {
  if (!tc || typeof tc !== 'object') return false
  const name = (tc.name || (tc.function && tc.function.name) || '').trim()
  const fnName =
    tc.function && typeof tc.function === 'object' && tc.function.name
      ? String(tc.function.name).trim()
      : ''
  const n = (name || fnName).toLowerCase()
  const fnArgs =
    tc.function && typeof tc.function === 'object' && tc.function.arguments != null
      ? String(tc.function.arguments)
      : ''
  const args = normalizeStreamToolCallArgs(tc)
  if (n === 'supervisor' && Object.keys(args).length === 0) return false
  if (WRITE_STREAM_TOOL_NAMES.has(n)) return !!(name || fnName || fnArgs.trim())
  return true
}

/** 流式 AI 块无可见正文但已有可展示 tool_calls 时，也要打开 tuple 工具门（否则首轮只有工具时永远不 emit） */
function tupleAiToolOnlyShouldKickAllow(aiPart, prevTurnAssistantStripPrefix) {
  if (!aiPart || typeof aiPart !== 'object') return false
  const rawPiece = textFromLangGraphStreamPart(aiPart)
  const pieceUse = stripLeadingPreviousAssistantText(rawPiece, prevTurnAssistantStripPrefix)
  const tcs = aiPart.tool_calls || aiPart.toolCalls
  return (
    (!pieceUse || !String(pieceUse).trim()) &&
    Array.isArray(tcs) &&
    tcs.some((tc) => streamToolCallReadyForUi(tc))
  )
}

function isHumanMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'user') return true
  const t = String(m.type || '').trim()
  // LangChain checkpoint dict 多为 HumanMessage，否则 values 聚合找不到锚点、tool_calls 永远拾不到
  return t === 'human' || t === 'HumanMessage' || t === 'HumanMessageChunk'
}

function normalizeLooseText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function messageTextForMatch(m) {
  return normalizeLooseText(extractAssistantText(m))
}

function isToolMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'tool') return true
  const t = String(m.type || '').trim()
  return t === 'tool' || t === 'ToolMessage' || t === 'ToolMessageChunk'
}

function extractReasoningPreview(msg, maxLen = 8000) {
  if (!msg) return null
  if (!isAssistantMessage(msg)) return null
  const cap = Math.max(200, Number(maxLen) || 8000)
  const ak = msg.additional_kwargs
  if (ak && typeof ak.reasoning_content === 'string' && ak.reasoning_content) {
    return ak.reasoning_content.slice(0, cap)
  }
  if (Array.isArray(msg.content)) {
    const think = msg.content.find(p => p && p.type === 'thinking' && typeof p.thinking === 'string')
    if (think?.thinking) return think.thinking.slice(0, cap)
  }
  return null
}

function deriveActivityFromMessages(messages) {
  const base = {
    kind: 'idle',
    detail: '',
    toolNames: [],
    reasoningPreview: null,
    clarification: null,
  }
  if (!Array.isArray(messages) || messages.length === 0) return base

  const humanIdx = findLastNonCollabHumanIndex(messages)
  if (humanIdx < 0) {
    const clarification = findAskClarification(messages)
    if (clarification) {
      return {
        ...base,
        kind: 'clarification',
        detail: '模型正在等待你的选择或回复',
        clarification,
      }
    }
    return base
  }

  const clarification = findAskClarificationAfterHuman(messages, humanIdx)
  if (clarification) {
    return {
      ...base,
      kind: 'clarification',
      detail: '模型正在等待你的选择或回复',
      clarification,
    }
  }

  const lastSub = lastSubstantiveIndexAfterHuman(messages, humanIdx)
  /* 去掉末尾注入段后，若没有任何实质消息在本轮 user 之后，则视为空闲（避免错显上一轮工具） */
  if (lastSub <= humanIdx) {
    return base
  }

  let reasoningPreview = null
  for (let i = lastSub; i > humanIdx; i--) {
    const m = messages[i]
    if (!isAssistantMessage(m)) continue
    const tc = m.tool_calls
    if (Array.isArray(tc) && tc.length > 0) {
      const latest = tc[tc.length - 1]
      const detail = formatActivityDetailFromToolCalls([latest])
      const toolNames = tc
        .map((x) => String(x?.name || x?.function?.name || '').trim())
        .filter((n) => n)
      return {
        ...base,
        kind: 'tools',
        detail,
        toolNames: toolNames.length ? [toolNames[toolNames.length - 1]] : [],
      }
    }
    if (!reasoningPreview) {
      const r = extractReasoningPreview(m)
      if (r) reasoningPreview = r
    }
  }

  if (reasoningPreview) {
    return {
      ...base,
      kind: 'thinking',
      detail: '推理中',
      reasoningPreview,
    }
  }
  return base
}

/** 摘要后 ``messages`` 含模型侧压缩块；展示层必须滤掉，避免 fallback 时把摘要当用户消息 */
function filterCompactionFromDisplayMessages(msgs) {
  if (!Array.isArray(msgs) || !msgs.length) return []
  return msgs.filter((m) => !isInjectedUiHumanMessage(m))
}

/** 流式 values 快照：仅用 checkpoint ``messages``（UI 历史由 ``evoflow_chat_messages`` 提供） */
function pickDisplayMessages(values) {
  if (!values || typeof values !== 'object') return []
  return filterCompactionFromDisplayMessages(Array.isArray(values.messages) ? values.messages : [])
}

/** 与 Web 版 values 事件对齐：扁平或 { values: {...} } */
function normalizeStreamValues(data) {
  if (!data || typeof data !== 'object') return { messages: [], todos: [], title: null, artifacts: [] }
  const raw = data.values && typeof data.values === 'object' ? data.values : data
  const messages = pickDisplayMessages(raw)
  const todos = Array.isArray(raw.todos) ? raw.todos : []
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : []
  return { messages, todos, title, artifacts }
}

/**
 * 完整状态（与 Web 版 values 快照一致）
 * @param {object} [opts]
 * @param {boolean} [opts.activityAnchorOk] 若为 false：仍下发 title/todos，但活动区强制 idle，避免新提问已发出而快照末尾仍是上一轮 assistant 时 thread_state 把旧工具名再推一遍。
 */
function emitThreadStateFull(self, key, runId, data, opts) {
  const { messages, todos, title, artifacts } = normalizeStreamValues(data)
  const o = opts && typeof opts === 'object' ? opts : null
  const anchored = !o || o.activityAnchorOk !== false
  const act = anchored
    ? deriveActivityFromMessages(messages)
    : {
        kind: 'idle',
        detail: '',
        toolNames: [],
        reasoningPreview: null,
        clarification: null,
      }
  self._emitEvent('thread_state', {
    sessionKey: key,
    runId,
    partial: false,
    title,
    todos,
    artifacts,
    activityKind: act.kind,
    activityDetail: act.detail,
    toolNames: act.toolNames || [],
    reasoningPreview: act.reasoningPreview,
    clarification: act.clarification,
  })
}

/** 流式 reasoning 分片可能在 CJK 字符间插入空格，合并为可读文本 */
function fixReasoningSpaces(text) {
  const s = String(text || '')
  if (!s) return ''
  return s.replace(
    /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+(?=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    '$1',
  )
}

/** 流式中途 ask_clarification 表单就绪后才推侧栏；仅有 toolCallId 时也推送，由 ChatApp 走 API 补全。 */
function emitThreadStateClarify(self, key, runId, clarification) {
  if (!clarification) return
  const toolCallId = String(clarification.toolCallId || clarification.tool_call_id || '').trim()
  const previewRaw = String(clarification.preview || clarification.content || '').trim()
  const preview =
    previewRaw && isClarificationPreviewRenderable(previewRaw)
      ? clarifyPreviewForEmit(previewRaw)
      : previewRaw
        ? clarifyPreviewForEmit(previewRaw)
        : ''
  if (!toolCallId && !preview) return
  if (preview && !isClarificationPreviewRenderable(preview) && !toolCallId) return
  self._emitEvent('thread_state', {
    sessionKey: key,
    runId,
    partial: true,
    activityKind: 'clarification',
    activityDetail: '模型正在等待你的选择或回复',
    clarification: {
      ...(toolCallId ? { toolCallId } : {}),
      ...(preview ? { preview } : {}),
    },
  })
}

/** 流式中途出现 reasoning_content 时，立即让 UI 展示「思考」面板（无需等 values 快照） */
function emitThreadStateReasoning(self, key, runId, reasoningPreview) {
  const r = typeof reasoningPreview === 'string' ? fixReasoningSpaces(reasoningPreview) : ''
  if (!r) return
  self._emitEvent('thread_state', {
    sessionKey: key,
    runId,
    partial: true,
    activityKind: 'thinking',
    activityDetail: '推理中',
    reasoningPreview: r.slice(0, 8000),
  })
}

function toolCallFromEvfChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  const name = chunk.name || (chunk.function && chunk.function.name) || ''
  const id = chunk.id || chunk.tool_call_id
  const argsPiece = typeof chunk.args === 'string' ? chunk.args : ''
  const fnArgs =
    chunk.function && typeof chunk.function.arguments === 'string'
      ? chunk.function.arguments
      : argsPiece
  const tc = {
    id,
    name,
    type: 'tool_call',
    function: {
      name: name || (chunk.function && chunk.function.name) || '',
      arguments: fnArgs,
    },
  }
  if (typeof chunk.args === 'object' && chunk.args != null && !Array.isArray(chunk.args)) {
    tc.args = chunk.args
  } else if (typeof chunk.args === 'string' && chunk.args.trim().startsWith('{')) {
    try {
      const p = JSON.parse(chunk.args)
      if (p && typeof p === 'object') tc.args = p
    } catch {
      /* partial JSON fragment */
    }
  }
  return tc
}

function slimWriteToolCallForWire(tc) {
  if (!tc || typeof tc !== 'object') return tc
  const toolName = String(tc.name || (tc.function && tc.function.name) || '')
    .trim()
    .toLowerCase()
  if (!WRITE_STREAM_TOOL_NAMES.has(toolName)) return tc
  const args = normalizeStreamToolCallArgs(tc)
  const path =
    (typeof args.path === 'string' && args.path.trim()) ||
    (typeof args.target_file === 'string' && args.target_file.trim()) ||
    ''
  const wireArgs = path ? { path } : {}
  const wireJson = JSON.stringify(wireArgs)
  const out = { ...tc }
  const fn = out.function && typeof out.function === 'object' ? { ...out.function } : {}
  fn.arguments = wireJson
  if (!fn.name) fn.name = tc.name || toolName
  out.function = fn
  if (path) {
    out.args = { path }
    out.input = { path }
  } else {
    delete out.args
    delete out.input
  }
  for (const key of ['content', 'new_string', 'old_string', 'contents', 'text']) {
    delete out[key]
  }
  return out
}

function blockWireFromEvf(data) {
  if (!data || typeof data !== 'object') return null
  const blockId = data.block_id != null ? String(data.block_id).trim() : ''
  const blockKind = data.block_kind != null ? String(data.block_kind).trim() : ''
  const seqRaw = data.seq
  const seq =
    typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : Number(seqRaw)
  if (!blockId || !blockKind || !Number.isFinite(seq)) return null
  return { blockId, blockKind, seq }
}

function blockWireFromOpts(opts) {
  if (!opts || typeof opts !== 'object') return null
  if (opts.blockWire && typeof opts.blockWire === 'object') return opts.blockWire
  const blockId = opts.blockId != null ? String(opts.blockId).trim() : ''
  const blockKind = opts.blockKind != null ? String(opts.blockKind).trim() : ''
  const seqRaw = opts.blockSeq ?? opts.seq
  const seq =
    typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : Number(seqRaw)
  if (!blockId || !blockKind || !Number.isFinite(seq)) return null
  return { blockId, blockKind, seq }
}

function dispatchEvfToolCallsMerged(self, key, runId, lane, calls, source, chunkMeta, blockWire) {
  if (!calls?.length) return
  const filteredCalls = calls.filter((tc) => {
    const id = tc?.id || tc?.tool_call_id
    return !laneShouldSkipPersistedTool(lane, id)
  })
  if (!filteredCalls.length) return
  if (!lane.toolCallAccumById) lane.toolCallAccumById = new Map()
  if (!lane.lastEvfToolEmitSig) lane.lastEvfToolEmitSig = new Map()
  if (!lane.lastEvfToolFnLen) lane.lastEvfToolFnLen = new Map()
  if (!lane.lastEvfToolContentLen) lane.lastEvfToolContentLen = new Map()
  const mergedBatch = []
  for (const tc of filteredCalls) {
    if (!tc || typeof tc !== 'object') continue
    const idKey = resolveToolCallAccumKey(lane, tc, chunkMeta)
    const prev = lane.toolCallAccumById.get(idKey)
    const merged = mergeMessagesTupleToolCallAccum(prev, tc)
    lane.toolCallAccumById.set(idKey, merged)
    const sig = (() => {
      try {
        return JSON.stringify(merged)
      } catch {
        return idKey
      }
    })()
    const fnArgs =
      merged.function && typeof merged.function === 'object' && merged.function.arguments != null
        ? String(merged.function.arguments)
        : ''
    const toolName = String(merged.name || (merged.function && merged.function.name) || '')
      .trim()
      .toLowerCase()
    const isWriteTool = WRITE_STREAM_TOOL_NAMES.has(toolName)
    const contentLen = isWriteTool ? writeStreamToolContentLen(merged) : 0
    const prevFnLen = lane.lastEvfToolFnLen.get(idKey) ?? 0
    const prevContentLen = lane.lastEvfToolContentLen.get(idKey) ?? 0
    const sameSig = lane.lastEvfToolEmitSig.get(idKey) === sig
    const noFnGrowth = fnArgs.length <= prevFnLen
    const noContentGrowth = !isWriteTool || contentLen <= prevContentLen
    if (sameSig && noFnGrowth && noContentGrowth) continue
    lane.lastEvfToolEmitSig.set(idKey, sig)
    lane.lastEvfToolFnLen.set(idKey, fnArgs.length)
    if (isWriteTool) lane.lastEvfToolContentLen.set(idKey, contentLen)
    mergedBatch.push(slimWriteToolCallForWire(merged))
  }
  if (!mergedBatch.length) return
  const block = blockWire || null
  self._emitEvent('chat', {
    sessionKey: key,
    runId,
    state: 'tool',
    data: { type: 'tool_call', tool_calls: mergedBatch },
    ...(block
      ? { blockId: block.blockId, blockKind: block.blockKind, blockSeq: block.seq }
      : {}),
  })
  for (const tc of mergedBatch) {
    const emitId = tc?.id || tc?.tool_call_id
    const emitName = tc?.name || (tc?.function && tc.function.name) || ''
    if (String(emitName).toLowerCase() === 'ask_clarification' && emitId) {
      const preview = resolveAskClarificationPreviewForLane(tc, lane, emitId)
      if (preview) {
        emitThreadStateClarify(self, key, runId, {
          toolCallId: emitId,
          preview: clarifyPreviewForEmit(preview),
        })
      }
    }
  }
  _logStreamEmit('tool', key, runId, { role: 'assistant', content: [{ type: 'text', text: '' }] }, {
    toolCalls: mergedBatch.length,
    source: source || 'evf',
  })
}

/**
 * 向 ChatApp 下发纯 delta 正文（message.content[0].text 仅为本帧增量，非累积全文）。
 */
function emitChatAssistantTextPieceNow(self, key, runId, piece, opts = {}) {
  const p = String(piece || '')
  if (!p) return
  if (resolveStreamWireFormat() === 'agui') return
  const contentPhase = opts.contentPhase
  const messageId = opts.messageId != null ? String(opts.messageId).trim() : ''
  const block = blockWireFromEvf(opts) || blockWireFromOpts(opts)
  self._emitEvent('chat', {
    sessionKey: key,
    runId,
    state: 'delta',
    streamTextMode: 'piece',
    streamContentPhase:
      contentPhase === 'post_tools' || contentPhase === 'pre_tools' ? contentPhase : null,
    ...(messageId ? { messageId } : {}),
    ...(block
      ? { blockId: block.blockId, blockKind: block.blockKind, blockSeq: block.seq }
      : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: p }] },
  })
  _logStreamEmit('delta', key, runId, {
    role: 'assistant',
    content: [{ type: 'text', text: p.slice(0, 240) }],
    streamTextMode: 'piece',
  })
}

function emitChatReasoningPieceNow(self, key, runId, reasoningPreview, reasoningBlock) {
  const preview = String(reasoningPreview || '').trim()
  if (!preview) return
  self._emitEvent('chat', {
    sessionKey: key,
    runId,
    state: 'reasoning',
    reasoningPreview: preview.slice(0, 8000),
    ...(reasoningBlock
      ? {
          blockId: reasoningBlock.blockId,
          blockKind: reasoningBlock.blockKind,
          blockSeq: reasoningBlock.seq,
        }
      : {}),
  })
}

function flushPendingChatPieces(self, sessionKey, runId) {
  flushChatPieceCoalesce(sessionKey, runId, (payload) => {
    const piece = String(payload.piece || '')
    if (piece) {
      emitChatAssistantTextPieceNow(self, payload.sessionKey, payload.runId, piece, payload.opts || {})
    }
    if (payload.reasoningPreview) {
      emitChatReasoningPieceNow(
        self,
        payload.sessionKey,
        payload.runId,
        payload.reasoningPreview,
        payload.reasoningBlock,
      )
    }
  })
}

function emitChatAssistantTextPiece(self, key, runId, piece, opts = {}) {
  if (resolveStreamWireFormat() === 'agui') return
  scheduleChatTextPieceCoalesce(key, runId, piece, opts, (payload) => {
    const p = String(payload.piece || '')
    if (p) {
      emitChatAssistantTextPieceNow(self, payload.sessionKey, payload.runId, p, payload.opts || {})
    }
    if (payload.reasoningPreview) {
      emitChatReasoningPieceNow(
        self,
        payload.sessionKey,
        payload.runId,
        payload.reasoningPreview,
        payload.reasoningBlock,
      )
    }
  })
}

/** 相对已下发 UI 的正文前缀，补发增量 piece（messages-tuple / values 共用） */
function emitStreamUiTextDelta(self, key, runId, finalText, streamUiEmittedText, opts = {}) {
  const target = String(finalText || '')
  const prev = String(streamUiEmittedText || '')
  if (!target || target === prev) return prev
  let piece = ''
  if (target.startsWith(prev)) {
    piece = target.slice(prev.length)
  } else if (!prev) {
    piece = target
  } else {
    // values 与 messages-tuple 前缀不一致时禁止整段重放（停后继续常见）
    const normT = normalizeLooseText(target)
    const normP = normalizeLooseText(prev)
    if (normT.startsWith(normP) && normT.length > normP.length) {
      const probe = prev.slice(0, Math.min(240, prev.length)).trim()
      const idx = probe.length >= 20 ? target.indexOf(probe) : -1
      if (idx >= 0) piece = target.slice(idx + probe.length)
    }
    if (!piece) return prev
  }
  if (!piece) return prev
  emitChatAssistantTextPiece(self, key, runId, piece, opts)
  return accumulateStreamAssistantText(prev, piece)
}

/** LangGraph ``event: error`` / evf ``type: error`` 可能是对象 ``{ error, message }`` */
function parseEvfStreamError(data) {
  const root = data && typeof data === 'object' ? data : {}
  const raw = root.error ?? root.detail ?? root.message
  if (raw && typeof raw === 'object') {
    const code = String(raw.error || raw.code || raw.type || '').trim()
    const message = String(raw.message || raw.detail || code || 'stream error').trim()
    return { code, message }
  }
  const message = String(raw || root.message || 'stream error').trim()
  return { code: '', message }
}

function isUserInterruptStreamError(code, message) {
  const c = String(code || '').toLowerCase()
  const m = String(message || '').toLowerCase()
  return c === 'userinterrupt' || c.includes('user_interrupt') || /\buser\s*interrupt\b/.test(m)
}

function emitStreamUserInterruptAbort(self, key, runId, lane, { finalText = '' } = {}) {
  lane.userInterrupt = true
  lane.lastError = ''
  if (_userStopSessionKeys.has(key)) _userStopSessionKeys.delete(key)
  void self._markSessionRunIdleBestEffort(key)
  self._emitEvent('chat', { sessionKey: key, runId, state: 'aborted' })
  _logStreamEmit('aborted', key, runId, { role: 'system', content: [{ type: 'text', text: 'user_interrupt' }] })
}

/** 单轮流式：每次模型返回 usage 后推送累计 token（供顶栏/气泡实时展示）。 */
function emitChatUsageIfChanged(self, key, runId, lane) {
  if (!lane?.runUsage) return
  const triplet = lane.runUsage.tripletForFinal()
  const usage = usageWirePayloadFromTriplet(triplet)
  if (!usage) return
  const sig = usageEmitSignature(triplet)
  if (lane.lastUsageEmitSig === sig) return
  lane.lastUsageEmitSig = sig
  self._emitEvent('chat', {
    sessionKey: key,
    runId,
    state: 'usage',
    usage,
  })
}

/** After run_end + final, keep reading briefly for collab inject tail, then close SSE. */
const RUN_END_TAIL_DRAIN_MS = 5000

/** AG-UI run_end emits RUN_FINISHED before MESSAGES_SNAPSHOT / display_segments tail frames. */
const AGUI_DEFERRED_FINAL_MS = 120

/** Derive display_segments from AG-UI MESSAGES_SNAPSHOT (incl. assistant toolCalls slots). */
function finalTextFromDisplaySegments(segs) {
  if (!Array.isArray(segs) || !segs.length) return ''
  const sorted = [...segs].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
  const parts = sorted
    .filter((s) => s?.kind === 'text')
    .map((s) => String(s.text || '').trim())
    .filter(Boolean)
  return mergeTurnAssistantTextsForDisplay(parts)
}

export function agUiDisplaySegmentsFromMessagesSnapshot(messages) {
  if (!Array.isArray(messages) || !messages.length) return []
  const segs = []
  let fallbackSeq = 0
  let seenTools = false
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const id = String(msg.id || '').trim()
    const role = String(msg.role || '').trim().toLowerCase()
    const content = String(msg.content || '').trim()
    const toolCalls = msg.toolCalls || msg.tool_calls
    if (!id) continue

    // role:tool rows are tool results — never assistant body text
    if (role === 'tool' || role === 'toolresult' || role === 'tool_result') continue

    const wireSeq =
      typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : null
    const blockKindRaw = String(msg.blockKind || msg.block_kind || '').trim()

    if (Array.isArray(toolCalls) && toolCalls.length) {
      seenTools = true
      const ids = toolCalls
        .map((tc) => String(tc?.id || tc?.tool_call_id || '').trim())
        .filter(Boolean)
      if (!ids.length) continue
      const seq = wireSeq ?? ++fallbackSeq
      fallbackSeq = Math.max(fallbackSeq, seq)
      const blockKind = blockKindRaw || 'tools'
      segs.push({ id, seq, kind: 'tools', ids, block_kind: blockKind, blockKind })
      continue
    }

    if (!content) continue
    const seq = wireSeq ?? ++fallbackSeq
    fallbackSeq = Math.max(fallbackSeq, seq)
    if (role === 'reasoning') {
      const blockKind = blockKindRaw || 'reasoning'
      segs.push({ id, seq, kind: 'reasoning', text: content, block_kind: blockKind, blockKind })
    } else if (role === 'assistant') {
      const blockKind = blockKindRaw || (seenTools ? 'body_text' : 'plan_text')
      segs.push({ id, seq, kind: 'text', text: content, block_kind: blockKind, blockKind })
    }
  }
  return segs.sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
}

function clearAgUiDeferredStreamFinalTimer(lane) {
  if (!lane?.aguiDeferredFinalTimer) return
  clearTimeout(lane.aguiDeferredFinalTimer)
  lane.aguiDeferredFinalTimer = null
}

/** RUN_FINISHED: wait for tail snapshot/segments before emitting ``state: final``. */
function scheduleAgUiDeferredStreamFinal(lane) {
  if (!lane || lane.finalEmitted) return
  clearAgUiDeferredStreamFinalTimer(lane)
  lane.aguiDeferredFinalTimer = setTimeout(() => {
    lane.aguiDeferredFinalTimer = null
    if (lane.finalEmitted || !lane.evfRunEndSeen) return
    try {
      lane.tryEmitChatStreamFinal?.()
    } catch (err) {
      console.warn('[evoflow] agui deferred final emit failed', err)
    }
  }, AGUI_DEFERRED_FINAL_MS)
}

function flushAgUiDeferredStreamFinal(lane) {
  if (!lane || lane.finalEmitted || !lane.evfRunEndSeen) return
  clearAgUiDeferredStreamFinalTimer(lane)
  try {
    lane.tryEmitChatStreamFinal?.()
  } catch (err) {
    console.warn('[evoflow] agui tail final emit failed', err)
  }
}

/**
 * Build + emit ``state: final`` as soon as Gateway sends ``run_end`` (do not wait for SSE close).
 * @param {WsClient} self
 * @param {object} ctx
 */
function tryEmitChatStreamFinal(self, ctx) {
  const lane = ctx?.evfLane
  if (!lane || lane.finalEmitted) return false
  if (!lane.evfRunEndSeen) return false
  if (lane.userInterrupt || _userStopSessionKeys.has(ctx.key)) return false

  const key = ctx.key
  const runId = String(lane.aguiChatRunId || ctx.runId || '').trim() || ctx.runId
  const started = ctx.started
  const uiStreamMode = ctx.uiStreamMode
  const prevTurnStripBundle = ctx.prevTurnStripBundle
  const prevTurnAssistantStripPrefix = ctx.prevTurnAssistantStripPrefix
  const lastStreamDisplayMessages = ctx.lastStreamDisplayMessages || []
  const lastAssistantTextFromValues = ctx.lastAssistantTextFromValues || ''
  let finalText = String(lane.finalText || ctx.finalText || '')

  const turnHumanIdx = findLastNonCollabHumanIndex(lastStreamDisplayMessages)
  const turnMerged =
    turnHumanIdx >= 0
      ? mergeTurnAssistantTextsForDisplay(
          collectAssistantTextsAfterHuman(
            lastStreamDisplayMessages,
            turnHumanIdx,
            prevTurnAssistantStripPrefix,
          ),
        )
      : ''
  let finalTextOut
  if (uiStreamMode) {
    finalTextOut = stripWsPriorTurnPollutants(String(finalText || '').trim(), prevTurnStripBundle)
    if (!finalTextOut) {
      finalTextOut = stripWsPriorTurnPollutants(
        pickRichestAssistantDisplayText(lastAssistantTextFromValues, turnMerged),
        prevTurnStripBundle,
      )
    }
  } else {
    finalTextOut = stripWsPriorTurnPollutants(
      pickRichestAssistantDisplayText(finalText, lastAssistantTextFromValues, turnMerged),
      prevTurnStripBundle,
    )
  }
  const segPlain = finalTextFromDisplaySegments(lane.authoritativeDisplaySegments)
  if (segPlain) {
    finalTextOut = stripWsPriorTurnPollutants(segPlain, prevTurnStripBundle)
  }
  const usageTriplet = ctx.runUsage?.tripletForFinal?.()
  const finalPayload = {
    sessionKey: key,
    runId,
    state: 'final',
    durationMs: nowTs() - started,
    streamTimelineAuthoritative: !!uiStreamMode,
    message: { role: 'assistant', content: [{ type: 'text', text: finalTextOut }] },
  }
  if (Array.isArray(lane.authoritativeDisplaySegments) && lane.authoritativeDisplaySegments.length) {
    finalPayload.displaySegments = lane.authoritativeDisplaySegments
  }
  if (Array.isArray(lane.authoritativeReasoningSegments) && lane.authoritativeReasoningSegments.length) {
    finalPayload.reasoningSegments = lane.authoritativeReasoningSegments
  }
  if (typeof lane.authoritativeReasoningPreview === 'string' && lane.authoritativeReasoningPreview.trim()) {
    finalPayload.reasoningPreview = lane.authoritativeReasoningPreview.trim()
  }
  if (usageTriplet) {
    finalPayload.usage = usageWirePayloadFromTriplet(usageTriplet) || undefined
  }
  lane.finalEmitted = true
  clearAgUiDeferredStreamFinalTimer(lane)
  sfLog('ws emit final', {
    sessionKey: key,
    runId,
    finalTextOutLen: String(finalTextOut || '').length,
    finalTextPreview: String(finalTextOut || '').slice(0, 120),
    laneFinalTextLen: String(lane.finalText || '').length,
    displaySegCount: Array.isArray(lane.authoritativeDisplaySegments)
      ? lane.authoritativeDisplaySegments.length
      : 0,
    displaySegHasSeq:
      Array.isArray(lane.authoritativeDisplaySegments) &&
      lane.authoritativeDisplaySegments.length > 0
        ? lane.authoritativeDisplaySegments.every((s) => s && typeof s.seq === 'number')
        : null,
    uiStreamMode: !!uiStreamMode,
    evfRunEndSeen: !!lane.evfRunEndSeen,
  })
  self._emitEvent('chat', finalPayload)
  if (!finalTextOut.trim()) {
    srLog('流式结束但正文为空（run_end 提前触发）', {
      sessionKey: key,
      runId,
      uiStreamMode: !!uiStreamMode,
      laneFinalTextLen: String(lane.finalText || '').length,
      lastAssistantTextFromValuesLen: String(lastAssistantTextFromValues || '').length,
      turnMergedLen: String(turnMerged || '').length,
      usage: usageTriplet || undefined,
    })
  }
  _logStreamEmit(
    'final',
    key,
    runId,
    { role: 'assistant', content: [{ type: 'text', text: finalTextOut }] },
    { durationMs: nowTs() - started, usage: usageTriplet || undefined, earlyOnRunEnd: true },
  )
  void reportClientStreamEndTiming({
    trace_id: ctx.traceId,
    thread_id: ctx.threadId,
    user_input_ts_ms: ctx.userInputTsMs,
    page_stream_end_ms: nowTs(),
    duration_ms: nowTs() - ctx.userInputTsMs,
  })
  return true
}

/**
 * Gateway ``event: evf`` UI stream（服务端做轮次锚定；正文/工具片段透传，由前端 merge）。
 * @param {object} lane 可变状态：finalText、firstPageTokenReported、evfRunEndSeen、runUsage、traceId、threadId、userInputTsMs
 */
function emitAgentActivityChat(self, key, runId, { kind, detail, toolName, toolCalls } = {}) {
  const actDetailRaw = String(detail || '').trim()
  const actKindRaw = String(kind || 'system').trim()
  const tool = String(toolName || '').trim()
  const actDetailOut = normalizeStreamActivityDetail(
    actDetailRaw || (tool ? `执行工具 ${tool}…` : ''),
    { toolName: tool, toolCalls },
  )
  if (!actDetailOut) return
  const preservedKinds = new Set([
    'tools',
    'thinking',
    'retrying',
    'compacting',
    'pre_model',
    'tool_approval',
    'model_fallback',
    'system',
  ])
  let actKind = 'thinking'
  if (actKindRaw === 'tools' || tool) actKind = 'tools'
  else if (preservedKinds.has(actKindRaw)) actKind = actKindRaw
  self._emitEvent('thread_state', {
    sessionKey: key,
    runId,
    partial: true,
    activityKind: actKind,
    activityDetail: actDetailOut,
  })
  self._emitEvent('chat', {
    sessionKey: key,
    runId,
    state: 'activity',
    activityKind: actKind,
    activityDetail: actDetailOut,
    toolName: tool || undefined,
  })
}

function emitContextUsageEvent(self, key, runId, chunk) {
  if (!chunk || typeof chunk !== 'object') return
  self._emitEvent('context_usage', {
    sessionKey: key,
    runId,
    usedTokens: Number(chunk.used_tokens) || 0,
    windowTokens: Number(chunk.window_tokens) || 0,
    messageCount: Number(chunk.message_count) || 0,
    pct: Number(chunk.pct) || 0,
    beforeTokens: chunk.before_tokens != null ? Number(chunk.before_tokens) || 0 : null,
    compacted: Boolean(chunk.compacted),
    note: String(chunk.note || ''),
    systemTokens: chunk.system_tokens != null ? Number(chunk.system_tokens) || 0 : null,
    toolsTokens: chunk.tools_tokens != null ? Number(chunk.tools_tokens) || 0 : null,
    messageTokens:
      chunk.message_tokens != null
        ? Number(chunk.message_tokens) || 0
        : chunk.history_tokens != null
          ? Number(chunk.history_tokens) || 0
          : null,
    toolCount: chunk.tool_count != null ? Number(chunk.tool_count) || 0 : null,
  })
}

/** 下发 StreamTurnEvent（OpenAI 路径，不经 EVF 翻译） */
function emitStreamTurnEvents(self, key, runId, events, lane) {
  if (!Array.isArray(events) || !events.length) return
  for (const streamTurnEvent of events) {
    if (streamTurnEvent?.type === 'text_piece' && streamTurnEvent.piece && !lane.firstPageTokenReported) {
      lane.firstPageTokenReported = true
      void reportClientFirstTokenTiming({
        trace_id: lane.traceId,
        thread_id: lane.threadId,
        path: lane.streamPath,
        user_input_ts_ms: lane.userInputTsMs,
        page_first_token_ts_ms: nowTs(),
      })
    }
    if (streamTurnEvent?.type === 'text_piece' && streamTurnEvent.piece) {
      lane.finalText = accumulateStreamAssistantText(lane.finalText || '', streamTurnEvent.piece)
    }
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'stream_turn',
      streamTurnEvent,
      streamFormat: 'openai',
    })
  }
}

function handleOpenAiMetaSideEffect(self, key, runId, effect, lane, hooks = {}) {
  if (!effect) return
  switch (effect.kind) {
    case 'thread_state':
    case 'usage':
    case 'run_end':
    case 'error':
    case 'aborted':
      try {
        dispatchEvfUiStreamEvent(
          self,
          key,
          runId,
          effect.kind === 'thread_state'
            ? effect.payload
            : effect.kind === 'usage'
              ? { type: 'usage', usage: effect.usage }
              : effect.kind === 'run_end'
                ? effect.payload
                : effect.kind === 'aborted'
                  ? { type: 'aborted', reason: effect.reason }
                  : { type: 'error', error: effect.error },
          lane,
        )
      } catch (err) {
        console.warn('[evoflow] openai meta side effect failed', effect.kind, err)
      }
      if (effect.kind === 'run_end') hooks.onRunEnd?.(effect.payload)
      break
    case 'custom':
      lane.dispatchCustomViaLegacy?.(effect.chunk)
      break
    default:
      break
  }
}

/** @deprecated OpenAI 路径请用 emitStreamTurnEvents */
function dispatchOpenAiStreamChunk(self, key, runId, data, lane) {
  if (!lane.openAiLane) lane.openAiLane = createOpenAiStreamLane()
  const events = openAiChunkToStreamTurnEvents(data, lane.openAiLane)
  if (events.some((e) => e.type === 'text_piece')) lane.deltaCount = (lane.deltaCount || 0) + 1
  emitStreamTurnEvents(self, key, runId, events, lane)
}

function dispatchOpenAiWireSseFrame(self, key, runId, eventName, dataRaw, data, lane, hooks = {}) {
  logStreamCompareSseRecv({
    sessionKey: key,
    runId,
    eventName,
    dataRaw,
    data: data && typeof data === 'object' ? data : null,
    wire: 'openai',
  })
  if (dataRaw === '[DONE]') {
    lane.evfRunEndSeen = true
    hooks.onDone?.()
    lane.tryEmitChatStreamFinal?.()
    return true
  }
  if (eventName === 'meta' && data && typeof data === 'object') {
    if (data.type === 'run_end') {
      lane.evfRunEndSeen = true
      hooks.onRunEnd?.(data)
    }
    emitStreamTurnEvents(self, key, runId, openAiMetaToStreamTurnEvents(data), lane)
    handleOpenAiMetaSideEffect(self, key, runId, openAiMetaSideEffect(data), lane, hooks)
    hooks.onMetaAfter?.(data)
    return true
  }
  if ((!eventName || eventName === 'message') && data?.object === 'chat.completion.chunk') {
    dispatchOpenAiStreamChunk(self, key, runId, data, lane)
    hooks.onChunkAfter?.(data)
    return true
  }
  return false
}

function dispatchEvfUiStreamEvent(self, key, runId, data, lane) {
  if (!data || typeof data !== 'object') return
  const t = String(data.type || '').trim()
  if (!t) return

  if (lane?.suppressHeaderReplay && (t === 'activity' || t === 'thread_state' || t === 'reasoning')) {
    return
  }

  if (t === 'delta') {
    const text = typeof data.text === 'string' ? data.text : ''
    if (!text) return
    lane.deltaCount = (lane.deltaCount || 0) + 1
    const kind = data.delta_kind === 'replace' ? 'replace' : 'append'
    const prev = lane.finalText || ''
    let piece
    if (kind === 'replace') {
      if (!prev) {
        lane.finalText = text
        piece = text
      } else if (text.startsWith(prev)) {
        piece = text.slice(prev.length)
        lane.finalText = text
      } else if (prev.startsWith(text)) {
        return
      } else if (isStreamAssistantLineRewrite(prev, text)) {
        lane.finalText = text
        piece = text
      } else {
        lane.finalText = text
        piece = text
      }
    } else {
      lane.finalText = accumulateStreamAssistantText(prev, text)
      piece = text
    }
    if (!piece) return
    piece = stripWsPriorTurnPollutants(piece, lane.priorTurnStripBundle || EMPTY_WS_PRIOR_STRIP)
    if (!piece) return
    if (!lane.firstPageTokenReported) {
      lane.firstPageTokenReported = true
      void reportClientFirstTokenTiming({
        trace_id: lane.traceId,
        thread_id: lane.threadId,
        path: lane.streamPath,
        user_input_ts_ms: lane.userInputTsMs,
        page_first_token_ts_ms: nowTs(),
      })
    }
    const messageId =
      data.message_id != null && String(data.message_id).trim()
        ? String(data.message_id).trim()
        : undefined
    emitChatAssistantTextPiece(self, key, runId, piece, {
      contentPhase: data.content_phase,
      messageId,
      blockWire: blockWireFromEvf(data),
    })
    if (lane?.suppressHeaderReplay && piece) {
      lane.suppressHeaderReplay = false
      markSessionResumeCatchupReplay(key, false)
    }
    return
  }

  if (t === 'write_file_progress') {
    const toolCallId = String(data.tool_call_id || '').trim()
    if (!toolCallId) return
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'write_progress',
      toolCallId,
      writeProgress: {
        path: typeof data.path === 'string' ? data.path : '',
        tool_name: typeof data.tool_name === 'string' ? data.tool_name : '',
        phase: typeof data.phase === 'string' ? data.phase : 'args',
        lines_added: Number(data.lines_added) || 0,
        lines_removed: Number(data.lines_removed) || 0,
        bytes_total:
          typeof data.bytes_total === 'number' && Number.isFinite(data.bytes_total)
            ? data.bytes_total
            : undefined,
        bytes_written:
          typeof data.bytes_written === 'number' && Number.isFinite(data.bytes_written)
            ? data.bytes_written
            : undefined,
        message: typeof data.message === 'string' ? data.message : undefined,
        content_delta: typeof data.content_delta === 'string' ? data.content_delta : undefined,
        old_string_delta:
          typeof data.old_string_delta === 'string' ? data.old_string_delta : undefined,
        new_string_delta:
          typeof data.new_string_delta === 'string' ? data.new_string_delta : undefined,
        content_len:
          typeof data.content_len === 'number' && Number.isFinite(data.content_len)
            ? data.content_len
            : undefined,
      },
    })
    return
  }

  if (t === 'tool_call_chunk') {
    const chunk = data.chunk
    const tc = toolCallFromEvfChunk(chunk)
    if (!tc) return
    dispatchEvfToolCallsMerged(self, key, runId, lane, [tc], data.source || 'evf-chunk', chunk, blockWireFromEvf(data))
    return
  }

  if (t === 'tool_call') {
    const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
    dispatchEvfToolCallsMerged(self, key, runId, lane, calls, data.source || 'evf', null, blockWireFromEvf(data))
    return
  }

  if (t === 'tool_result') {
    const toolCallId = data.tool_call_id ?? data.tool?.tool_call_id
    if (laneShouldSkipPersistedTool(lane, toolCallId)) return
    const toolData =
      data.tool && typeof data.tool === 'object'
        ? {
            ...data.tool,
            type: data.tool.type || 'tool',
            role: data.tool.role || 'tool',
            status: data.tool.status || data.status || 'ok',
            truncated: data.tool.truncated ?? data.truncated,
            content_bytes: data.tool.content_bytes ?? data.content_bytes,
            output_bytes: data.tool.output_bytes ?? data.output_bytes,
          }
        : {
            type: 'tool',
            name: data.name || 'tool',
            tool_call_id: data.tool_call_id,
            content: data.content,
            status: data.status || 'ok',
            truncated: data.truncated,
            content_bytes: data.content_bytes,
            output_bytes: data.output_bytes,
          }
    const toolName = toolData.name || data.name || 'tool'
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'tool',
      data: toolData,
      toolCallId,
      name: toolName,
    })
    if (String(toolName).toLowerCase() === 'ask_clarification' && toolCallId) {
      const preview = resolveAskClarificationPreviewForLane(toolData, lane, toolCallId)
      if (preview) {
        emitThreadStateClarify(self, key, runId, {
          toolCallId,
          preview: clarifyPreviewForEmit(preview),
        })
      }
    }
    _logStreamEmit('tool', key, runId, { role: 'tool', content: [{ type: 'text', text: '' }] }, {
      toolCallId,
      toolResult: true,
    })
    return
  }

  if (t === 'activity') {
    emitAgentActivityChat(self, key, runId, {
      kind: data.kind,
      detail: data.detail,
      toolName: data.tool_name,
      toolCalls: Array.isArray(data.tool_calls) ? data.tool_calls : undefined,
    })
    return
  }

  if (t === 'model_fallback_switch') {
    const modelName = String(data.model_name || '').trim()
    const text = String(data.text || '').trim()
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'model_fallback_switch',
      modelName,
      fromModel: String(data.from_model || '').trim(),
      text,
    })
    if (text) {
      emitAgentActivityChat(self, key, runId, {
        kind: 'model_fallback',
        detail: text,
      })
    }
    return
  }

  if (t === 'thread_state') {
    const anchored = data.anchored !== false
    const rawDetail = anchored ? String(data.activityDetail || '') : ''
    const toolCalls = anchored && Array.isArray(data.toolCalls) ? data.toolCalls : undefined
    const activityDetail = anchored
      ? normalizeStreamActivityDetail(rawDetail, {
          toolName: Array.isArray(data.toolNames) ? data.toolNames[data.toolNames.length - 1] : '',
          toolCalls,
        })
      : ''
    self._emitEvent('thread_state', {
      sessionKey: key,
      runId,
      partial: false,
      title: typeof data.title === 'string' ? data.title : null,
      todos: Array.isArray(data.todos) ? data.todos : [],
      artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
      activityKind: anchored ? String(data.activityKind || 'idle') : 'idle',
      activityDetail,
      toolNames: anchored && Array.isArray(data.toolNames) ? data.toolNames : [],
      toolCalls: toolCalls || [],
      reasoningPreview: null,
      clarification: null,
    })
    return
  }

  if (t === 'block_close') {
    const block = blockWireFromEvf(data)
    if (!block) return
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'block_close',
      blockId: block.blockId,
      blockKind: block.blockKind,
      blockSeq: block.seq,
    })
    return
  }

  if (t === 'reasoning') {
    // 分片 preview 常带前导空格（如 " user"）；trim 会拼成 Theuser
    const previewRaw = typeof data.preview === 'string' ? fixReasoningSpaces(data.preview) : ''
    if (!previewRaw) return
    const bundle = lane.priorTurnStripBundle || EMPTY_WS_PRIOR_STRIP
    const preview = stripPriorTurnReasoningFromStream(previewRaw, bundle)
    if (!String(preview || '').trim()) return
    emitThreadStateReasoning(self, key, runId, preview)
    const block = blockWireFromEvf(data)
    if (resolveStreamWireFormat() === 'agui') {
      self._emitEvent('chat', {
        sessionKey: key,
        runId,
        state: 'reasoning',
        reasoningPreview: preview.slice(0, 8000),
        ...(block
          ? { blockId: block.blockId, blockKind: block.blockKind, blockSeq: block.seq }
          : {}),
      })
      return
    }
    scheduleChatReasoningCoalesce(key, runId, preview, block, (payload) => {
      if (payload.reasoningPreview) {
        emitChatReasoningPieceNow(
          self,
          payload.sessionKey,
          payload.runId,
          payload.reasoningPreview,
          payload.reasoningBlock,
        )
      }
    })
    return
  }

  if (t === 'context_usage') {
    emitContextUsageEvent(self, key, runId, data)
    return
  }

  if (t === 'pending_inject_consumed') {
    emitPendingInjectConsumedEvent(self, key, runId, data)
    return
  }

  if (t === 'custom') {
    const chunk = data.chunk
    if (!chunk || typeof chunk !== 'object') return
    if (String(chunk.type || '').trim() === 'context_usage') {
      emitContextUsageEvent(self, key, runId, chunk)
      return
    }
    if (String(chunk.type || '').trim() === 'pending_inject_consumed') {
      emitPendingInjectConsumedEvent(self, key, runId, chunk)
      return
    }
    lane.dispatchCustomViaLegacy?.(chunk)
    return
  }

  if (t === 'usage') {
    const um = data.usage
    if (um && typeof um === 'object' && lane.runUsage) {
      lane.runUsage.absorbEndEvent({ usage_metadata: um })
      emitChatUsageIfChanged(self, key, runId, lane)
    }
    return
  }

  if (t === 'run_end') {
    lane.evfRunEndSeen = true
    if (Array.isArray(data.display_segments) && data.display_segments.length) {
      lane.authoritativeDisplaySegments = data.display_segments
    }
    if (Array.isArray(data.reasoning_segments) && data.reasoning_segments.length) {
      lane.authoritativeReasoningSegments = data.reasoning_segments
    }
    if (typeof data.reasoning_preview === 'string' && data.reasoning_preview.trim()) {
      lane.authoritativeReasoningPreview = data.reasoning_preview.trim()
    }
    // 正文只信 delta 增量；run_end.text 常为 values 合并全文，会覆盖/重复流式时间线
    const um = data.usage
    if (um && typeof um === 'object') lane.runUsage.absorbEndEvent({ usage_metadata: um })
    emitChatUsageIfChanged(self, key, runId, lane)
    lane.tryEmitChatStreamFinal?.()
    return
  }

  if (t === 'aborted') {
    emitStreamUserInterruptAbort(self, key, runId, lane)
    return
  }

  if (t === 'error') {
    const { code, message } = parseEvfStreamError(data)
    if (isUserInterruptStreamError(code, message) || _userStopSessionKeys.has(key)) {
      emitStreamUserInterruptAbort(self, key, runId, lane)
      return
    }
    lane.lastError = message
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'error',
      errorMessage: message,
    })
  }
}

function parseWireSseFrame(frameText) {
  const lines = String(frameText || '').split('\n')
  let dataRaw = ''
  let eventName = ''
  for (const line of lines) {
    const l = line.replace(/\r$/, '')
    if (l.startsWith('event:')) eventName = l.slice(6).trim()
    if (l.startsWith('data:')) dataRaw = appendSseDataLine(dataRaw, l)
  }
  const data = dataRaw ? safeParseJSON(dataRaw, null) : null
  return { eventName, data }
}

/** LangGraph ``event: custom`` / evf ``type: custom`` — 原始流、attach、mirror 续流共用。 */
/** runtime-aligned ack: mid-turn steers entered transcript (UI clears pendingSteers). */
function emitPendingInjectConsumedEvent(self, key, runId, chunk) {
  if (!self || !chunk || typeof chunk !== 'object') return
  const ids = Array.isArray(chunk.message_ids)
    ? chunk.message_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : Array.isArray(chunk.messageIds)
      ? chunk.messageIds.map((x) => String(x || '').trim()).filter(Boolean)
      : []
  if (!ids.length) return
  self._emitEvent('pending_inject_consumed', {
    sessionKey: String(key || '').trim(),
    runId: String(runId || '').trim() || null,
    messageIds: ids,
    consumedByRunId:
      chunk.consumed_by_run_id || chunk.consumedByRunId || runId || null,
  })
}

function dispatchLangGraphCustomStreamChunk(self, key, runId, chunk) {
  if (!chunk || typeof chunk !== 'object') return
  const t = String(chunk.type || '').trim()
  if (t === 'pending_inject_consumed') {
    emitPendingInjectConsumedEvent(self, key, runId, chunk)
    return
  }
  if (t === 'trae_stream_error') {
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(runId),
      state: 'error',
      errorMessage: String(chunk.error || 'External CLI stream error'),
    })
    return
  }
  if (t === 'prefetch_tool_calls_batch') {
    const calls = Array.isArray(chunk.calls)
      ? chunk.calls.filter((c) => c && c.tool_call_id && c.tool_name)
      : []
    if (calls.length) {
      self._emitEvent('chat', {
        sessionKey: key,
        runId: String(runId),
        state: 'tool',
        data: {
          type: 'tool_call',
          tool_calls: calls.map((c) => ({
            id: c.tool_call_id,
            tool_call_id: c.tool_call_id,
            name: c.tool_name,
            type: 'tool_call',
            args: c.args || {},
          })),
        },
      })
    }
    return
  }
  if (t === 'prefetch_tool_call') {
    const tcId = String(chunk.tool_call_id || '').trim()
    const toolName = String(chunk.tool_name || 'read_file').trim() || 'read_file'
    if (tcId) {
      self._emitEvent('chat', {
        sessionKey: key,
        runId: String(runId),
        state: 'tool',
        data: {
          type: 'tool_call',
          tool_calls: [{ id: tcId, tool_call_id: tcId, name: toolName, type: 'tool_call', args: chunk.args || {} }],
        },
        toolCallId: tcId,
        name: toolName,
      })
    }
    return
  }
  if (t === 'prefetch_tool_result') {
    const mapped = prefetchToolResultChatPayload(chunk)
    if (!mapped) return
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(runId),
      state: 'tool',
      data: mapped.data,
      toolCallId: mapped.tcId,
      name: mapped.toolName,
    })
    return
  }
  if (t === 'worker_file_completed') {
    emitWorkerFileCompletedChat(self, key, runId, chunk)
    return
  }
  if (t === 'evoflow_session_workspace') {
    const resolved = String(chunk.local_workspace_root || '').trim()
    if (resolved) {
      try {
        void self.bindSessionWorkspace(key, resolved, { userPinned: false }).catch(() => {})
      } catch (_) {}
    }
    return
  }
  if (
    t === 'terminal_start' ||
    t === 'terminal_stdout' ||
    t === 'terminal_stderr' ||
    t === 'terminal_exit'
  ) {
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(runId),
      state: 'terminal',
      terminalEvent: chunk,
    })
    return
  }
  if (
    t === 'task_started' ||
    t === 'task_running' ||
    t === 'task_completed' ||
    t === 'task_failed' ||
    t === 'task_timed_out'
  ) {
    const subtaskEvent = normalizeSubagentStreamEvent(chunk)
    self._collabChatRunBySession.set(key, String(runId))
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(runId),
      state: 'subtask',
      subtaskEvent,
    })
    return
  }
  const subtaskEvent = normalizeSubagentStreamEvent(chunk)
  if (subtaskEvent && typeof subtaskEvent === 'object' && !isTerminalStreamEvent(chunk)) {
    self._emitEvent('chat', {
      sessionKey: key,
      runId: String(runId),
      state: 'subtask',
      subtaskEvent,
    })
  }
}

function bindEvfLaneCustomDispatch(self, key, runId, lane) {
  if (!lane) return
  lane.dispatchCustomViaLegacy = (chunk) => dispatchLangGraphCustomStreamChunk(self, key, runId, chunk)
}

/**
 * values 快照 → chat delta/tool（attach 与 stream-resume mirror 共用）。
 * baseline 来自 DB anchor，与刷新后只追加未落库增量一致。
 */
function dispatchStreamValuesFrame(self, key, runId, data, lane, hooks = {}) {
  if (!data || typeof data !== 'object' || !lane) return
  const { messages } = normalizeStreamValues(data)
  hooks.onMessages?.(messages)
  const slice = sliceMessagesForCurrentTurn(messages)
  const humanIdx = slice.humanIdx
  if (humanIdx >= 0) hooks.onAfterHuman?.(messages, humanIdx)

  try {
    const callsRaw = slice.toolCalls
    const calls = Array.isArray(callsRaw)
      ? callsRaw
          .filter(streamToolCallReadyForUi)
          .filter((c) => !laneShouldSkipPersistedTool(lane, c?.id || c?.tool_call_id))
      : []
    if (!lane.lastValuesToolCallsSig) lane.lastValuesToolCallsSig = ''
    const sig = calls.length ? JSON.stringify(calls) : ''
    if (sig && sig !== lane.lastValuesToolCallsSig) {
      lane.lastValuesToolCallsSig = sig
      evfWsToolStreamDebug('values-tool', { n: calls.length, t: evfBriefEmittedToolCallsForDebug(calls) })
      self._emitEvent('chat', {
        sessionKey: key,
        runId: String(runId),
        state: 'tool',
        data: { type: 'tool_call', tool_calls: calls },
      })
    }
  } catch {
    /* ignore tool extraction */
  }

  const text = slice.assistantText
  if (text) hooks.onValuesText?.(text)
  if (!text) {
    emitThreadStateFull(self, key, String(runId), data)
    return
  }
  if (lane?.aguiStreamMode) {
    emitThreadStateFull(self, key, String(runId), data)
    return
  }

  // 优先用 finalText（最新累积值，含 delta 路径增量）做 baseline，
  // 避免用过时的 valuesBaselineText 切出包含已发送内容的 delta。
  const baseline = String(lane.finalText || lane.transcriptAnchorText || lane.valuesBaselineText || '').trim()
  if (!lane.valuesBaselineLocked && !lane.transcriptAnchorText) {
    lane.valuesBaselineLocked = true
    lane.valuesBaselineText = text
    lane.finalText = text
    hooks.setOuterFinalText?.(text)
    emitThreadStateFull(self, key, String(runId), data)
    return
  }

  let delta = text
  if (baseline && delta.startsWith(baseline)) {
    delta = delta.slice(baseline.length)
  }
  if (!delta) {
    emitThreadStateFull(self, key, String(runId), data)
    return
  }
  const prevFinal = String(lane.finalText || '')
  const next = accumulateStreamAssistantText(prevFinal, delta)
  if (next !== prevFinal) {
    lane.finalText = next
    hooks.setOuterFinalText?.(next)
    emitChatAssistantTextPiece(self, key, String(runId), delta)
    if (lane.suppressHeaderReplay) {
      lane.suppressHeaderReplay = false
      markSessionResumeCatchupReplay(key, false)
    }
  }
  emitThreadStateFull(self, key, String(runId), data)
}

function isAgUiWireEvent(data) {
  if (!data || typeof data !== 'object') return false
  const t = String(data.type || '').trim()
  return /^[A-Z][A-Z0-9_]*$/.test(t) && t.includes('_')
}

/** 解析 mirror / LangGraph attach 的 wire SSE，与 chatSend agui/evf 路径对齐。 */
function dispatchChatWireSseFrame(self, opts) {
  const key = opts.sessionKey || MAIN_SESSION_KEY
  const runId = String(opts.runId || '')
  const { eventName, data } = parseWireSseFrame(opts.frameText)
  if (!data && eventName !== 'done') return false
  const evfLane = opts.evfLane

  if (opts.aguiStreamMode) {
    if ((eventName === 'ag-ui' || isAgUiWireEvent(data)) && data && typeof data === 'object') {
      dispatchAgUiWireFrame(self, key, runId, data, evfLane)
      opts.onEvfAfter?.(data)
      return true
    }
  }

  if (opts.openAiStreamMode) {
    const dataRaw =
      typeof opts.frameText === 'string'
        ? (() => {
            for (const line of opts.frameText.split('\n')) {
              const l = line.replace(/\r$/, '')
              if (l.startsWith('data:')) return l.slice(5).trim()
            }
            return ''
          })()
        : ''
    if (
      dispatchOpenAiWireSseFrame(self, key, runId, eventName, dataRaw, data, evfLane, {
        onRunEnd: (payload) => opts.onEvfAfter?.(payload),
        onMetaAfter: (payload) => opts.onEvfAfter?.(payload),
        onChunkAfter: () => {},
        onDone: () => opts.onEvfAfter?.({ type: 'run_end' }),
      })
    ) {
      return true
    }
  }

  if (eventName === 'evf' && evfLane) {
    if (data?.type === 'delta') {
      evfLane.deltaCount = (evfLane.deltaCount || 0) + 1
      if (evfLane.deltaCount === 1) {
        srLog('evf delta (first)', {
          sessionKey: key,
          runId,
          deltaCount: evfLane.deltaCount,
          textPreview: String(data.text || '').slice(0, 40),
        })
      }
    }
    if (data?.type === 'run_end') {
      evfLane.evfRunEndSeen = true
      srLog('evf run_end', { sessionKey: key, runId, deltaCount: evfLane.deltaCount })
    }
    try {
      dispatchEvfUiStreamEvent(self, key, runId, data, evfLane)
    } catch (evfErr) {
      console.warn('[evoflow] wire evf event failed', data?.type, evfErr)
    }
    opts.onEvfAfter?.(data)
    return true
  }

  if (eventName === 'values' && opts.onValues) {
    opts.onValues(data)
    return true
  }

  if (eventName === 'custom') {
    dispatchLangGraphCustomStreamChunk(self, key, runId, normalizeCustomTaskPayload(data))
    return true
  }

  if (eventName === 'error') {
    const { code, message } = parseEvfStreamError(
      typeof data === 'object' && data ? data : { message: String(data || 'stream error') },
    )
    if (isUserInterruptStreamError(code, message) || _userStopSessionKeys.has(key)) {
      if (evfLane) emitStreamUserInterruptAbort(self, key, runId, evfLane)
      return true
    }
    if (evfLane) evfLane.lastError = message
    self._emitEvent('chat', {
      sessionKey: key,
      runId,
      state: 'error',
      errorMessage: message,
    })
    return true
  }

  if (eventName === 'end' && opts.onEnd) {
    opts.onEnd(data)
    return true
  }

  return false
}

export class WsClient {
  constructor() {
    this._eventListeners = []
    this._statusListeners = []
    this._readyCallbacks = []
    this._connected = false
    this._gatewayReady = false
    this._connecting = false
    this._sessionKey = MAIN_SESSION_KEY
    this._hello = {
      serverVersion: 'evoflow-http-sse',
      snapshot: { sessionDefaults: { mainSessionKey: MAIN_SESSION_KEY, defaultAgentId: 'main' } },
    }
    this._snapshot = this._hello.snapshot
    this._serverVersion = this._hello.serverVersion
    this._abortByRunId = new Map()
    this._latestRunBySession = new Map()
    /** Main chat runId while collab subtasks stream (reuse for subtask custom events). */
    this._collabChatRunBySession = new Map()
  }

  get connected() { return this._connected }
  get connecting() { return this._connecting }
  get gatewayReady() { return this._gatewayReady }
  get snapshot() { return this._snapshot }
  get hello() { return this._hello }

  /** Active main-chat run id used for collab subtask custom events. */
  getCollabChatRunId(sessionKey) {
    const key = sessionKey || MAIN_SESSION_KEY
    return this._collabChatRunBySession.get(key) || null
  }
  get sessionKey() { return this._sessionKey }
  get serverVersion() { return this._serverVersion }

  onStatusChange(fn) {
    this._statusListeners.push(fn)
    return () => { this._statusListeners = this._statusListeners.filter(cb => cb !== fn) }
  }

  onReady(fn) {
    this._readyCallbacks.push(fn)
    return () => { this._readyCallbacks = this._readyCallbacks.filter(cb => cb !== fn) }
  }

  connect() {
    if (this._connected || this._connecting) return
    this._connecting = true
    this._setConnected(true, 'connected')
    this._gatewayReady = true
    this._connecting = false
    this._setConnected(true, 'ready')
    refreshSessionMapFromDb().catch(() => {})
    this._readyCallbacks.forEach(fn => {
      try { fn(this._hello, this._sessionKey) } catch {}
    })
  }

  disconnect() {
    for (const controller of this._abortByRunId.values()) {
      try { controller.abort() } catch {}
    }
    this._abortByRunId.clear()
    this._latestRunBySession.clear()
    this._collabChatRunBySession.clear()
    this._gatewayReady = false
    this._setConnected(false)
  }

  reconnect() {
    this.disconnect()
    this.connect()
  }

  _setConnected(val, status, errorMsg) {
    this._connected = val
    const s = status || (val ? 'connected' : 'disconnected')
    this._statusListeners.forEach(fn => {
      try { fn(s, errorMsg) } catch (e) { console.error('[ws] status listener error:', e) }
    })
  }

  _emitEvent(event, payload) {
    if (event === 'chat' && payload && typeof payload === 'object') {
      const st = String(payload.state || '').trim()
      if (st && st !== 'delta' && st !== 'reasoning') {
        flushPendingChatPieces(this, payload.sessionKey, payload.runId)
      }
    }
    const msg = { type: 'event', event, payload }
    this._eventListeners.forEach(fn => {
      try { fn(msg) } catch {}
    })
  }

  /** 仅读本地映射中的 thread id，不创建线程 */
  getSessionThreadId(sessionKey) {
    const key = sessionKey || MAIN_SESSION_KEY
    const tid = loadSessionMap()[key]?.threadId
    const raw = typeof tid === 'string' && tid.trim() ? tid.trim() : null
    return resolveLanggraphLeadThreadId(raw) || raw
  }

  /**
   * 本地 session map 中已绑定 LangGraph thread 的会话（飞书面板指令等多路 panel SSE 订阅用）。
   * @returns {Array<{ sessionKey: string, threadId: string }>}
   */
  listSessionsWithPanelThreadIds(opts = {}) {
    const map = loadSessionMap()
    const max = Math.max(1, Math.min(5, Number(opts.max) || 3))
    const wantKeys = Array.isArray(opts.sessionKeys)
      ? opts.sessionKeys.map((k) => String(k || '').trim()).filter(Boolean)
      : []
    const out = []
    const pushKey = (sessionKey) => {
      if (!sessionKey || out.length >= max) return
      const row = map[sessionKey]
      const tid = row && typeof row.threadId === 'string' ? row.threadId.trim() : ''
      if (tid) out.push({ sessionKey, threadId: tid })
    }
    if (wantKeys.length) {
      for (const sessionKey of wantKeys) pushKey(sessionKey)
    } else {
      for (const sessionKey of Object.keys(map || {})) pushKey(sessionKey)
    }
    return out
  }

  /** 确保 LangGraph 线程存在并写回 session map（任务协作开关等需先落盘 collab 时用） */
  async ensureChatThread(sessionKey) {
    return this._ensureThread(sessionKey)
  }

  /**
   * 解析 session → thread_id：先同步侧栏/内存 hint，再 POST ensure-thread 校验（LangGraph 重启后会重建 stale thread）。
   */
  async resolveSessionThreadId(sessionKey, options = {}) {
    const key = String(sessionKey || '').trim()
    if (!key) return ''
    const hint = resolveLanggraphLeadThreadId(String(options.hintThreadId || '').trim())
    if (hint) {
      const map = loadSessionMap()
      const prev = map[key] && typeof map[key] === 'object' ? map[key] : {}
      if (!prev.threadId || String(prev.threadId).trim() !== hint) {
        map[key] = { ...prev, threadId: hint, updatedAt: nowTs() }
        _sessionMapCache = map
        _sessionMapHydrated = true
      }
    } else {
      const cached = this.getSessionThreadId(key)
      if (cached && isLanggraphLeadThreadId(cached)) {
        const raw = String(loadSessionMap()[key]?.threadId || '').trim()
        if (raw && raw !== cached) {
          const map = loadSessionMap()
          const prev = map[key] && typeof map[key] === 'object' ? map[key] : {}
          map[key] = { ...prev, threadId: cached, updatedAt: nowTs() }
          _sessionMapCache = map
          _sessionMapHydrated = true
          saveSessionMap(map, { keys: [key] })
        }
      }
    }
    // Always verify via Gateway — local cache survives LangGraph restarts; backend recreates stale threads.
    try {
      return await this._ensureThread(key)
    } catch (e) {
       
      console.warn('[evoflow] resolveSessionThreadId failed', key, e)
      return ''
    }
  }

  async getThreadCollabState(threadId) {
    if (!threadId) return null
    try {
      return await fetchJson(`/api/collab/threads/${encodeURIComponent(threadId)}`)
    } catch {
      return null
    }
  }

  // NOTE: 已移除 getTaskProgressSnapshot（task-progress 快照恢复/拉取功能下线）

  async putThreadCollabState(threadId, body) {
    if (!threadId || !body || typeof body !== 'object') return
    await fetchJson(`/api/collab/threads/${encodeURIComponent(threadId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async getPendingToolApprovals(threadId) {
    const tid = String(threadId || '').trim()
    if (!tid) return { pending_approvals: [], count: 0 }
    try {
      const data = await fetchJson(
        `/api/collab/threads/${encodeURIComponent(tid)}/tool-approval/pending`,
      )
      return {
        pending_approvals: Array.isArray(data?.pending_approvals) ? data.pending_approvals : [],
        count: Number(data?.count) || 0,
        effective_tool_approval_policy: String(data?.effective_tool_approval_policy || 'grant_all'),
      }
    } catch {
      return { pending_approvals: [], count: 0, effective_tool_approval_policy: 'grant_all' }
    }
  }

  async postToolApproval(
    threadId,
    {
      action,
      tool_call_id: toolCallId,
      local_workspace_root: wsRoot,
      tool_name: toolName,
      args,
      summary,
      remember,
    } = {},
  ) {
    const tid = String(threadId || '').trim()
    if (!tid) throw new Error('thread_id required')
    const body = { action: String(action || '').trim() }
    if (toolCallId) body.tool_call_id = String(toolCallId).trim()
    if (wsRoot) body.local_workspace_root = String(wsRoot).trim()
    if (toolName) body.tool_name = String(toolName).trim()
    if (args && typeof args === 'object' && !Array.isArray(args)) body.args = args
    if (summary) body.summary = String(summary).trim()
    if (remember) body.remember = true
    return fetchJson(`/api/collab/threads/${encodeURIComponent(tid)}/tool-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async cancelPendingToolApprovals(threadId) {
    const tid = String(threadId || '').trim()
    if (!tid) return { cancelled_count: 0 }
    try {
      return await fetchJson(
        `/api/collab/threads/${encodeURIComponent(tid)}/tool-approval/cancel`,
        { method: 'POST' },
      )
    } catch {
      return { cancelled_count: 0 }
    }
  }

  async bindSessionThread(sessionKey, threadId, options = {}) {
    const key = String(sessionKey || '').trim()
    const tid = resolveLanggraphLeadThreadId(threadId)
    if (!key || !tid) return null
    const body = { threadId: tid }
    if (options.context && typeof options.context === 'object') {
      body.context = options.context
    }
    const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/bind-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const map = loadSessionMap()
    const prev = map[key] && typeof map[key] === 'object' ? map[key] : {}
    map[key] = {
      ...prev,
      threadId: tid,
      updatedAt: Number(data?.updatedAt) || nowTs(),
      messageCount: Number(data?.messageCount ?? prev.messageCount) || 0,
      context: mergeSessionContextFromApiRow(data, prev.context) || prev.context || {},
    }
    saveSessionMap(map, { keys: [key] })
    return data
  }

  async _ensureThread(sessionKey) {
    const key = sessionKey || MAIN_SESSION_KEY
    const ensureStarted = nowTs()

    // 短 TTL 缓存：成功结果复用，避免每次 chatSend 都 POST
    const cached = _ensureThreadCachedAt.get(key)
    if (cached && Date.now() - cached.ts < _ENSURE_THREAD_TTL_MS) {
      this._lastEnsureThreadMeta = {
        sessionKey: key,
        cacheHit: true,
        durationMs: Math.max(0, nowTs() - ensureStarted),
      }
      return cached.threadId
    }

    // 本地已有合法 lead thread：直接用（LangGraph 重启后的 stale 由 stream 404 重建）。
    // 不再为「确认还在」阻塞发送——后端 GET /threads/.../runs 曾稳定吃掉 0.5–3s+。
    const localTid = resolveLanggraphLeadThreadId(String(this.getSessionThreadId(key) || '').trim())
    if (localTid && isLanggraphLeadThreadId(localTid)) {
      _ensureThreadCachedAt.set(key, { threadId: localTid, ts: Date.now() })
      this._lastEnsureThreadMeta = {
        sessionKey: key,
        cacheHit: true,
        localMap: true,
        durationMs: Math.max(0, nowTs() - ensureStarted),
      }
      return localTid
    }

    const failedAt = _ensureThreadFailedAt.get(key)
    if (failedAt && Date.now() - failedAt < ENSURE_THREAD_FAIL_BACKOFF_MS) {
      throw new Error('ensure-thread skipped (recent failure)')
    }

    let inflight = _ensureThreadInflight.get(key)
    if (inflight) {
      const tid = await inflight
      this._lastEnsureThreadMeta = {
        sessionKey: key,
        cacheHit: false,
        coalesced: true,
        durationMs: Math.max(0, nowTs() - ensureStarted),
      }
      return tid
    }

    inflight = this._ensureThreadOnce(key, { forceRecreate: false })
      .then((threadId) => {
        _ensureThreadFailedAt.delete(key)
        _ensureThreadCachedAt.set(key, { threadId, ts: Date.now() })
        return threadId
      })
      .catch((err) => {
        _ensureThreadFailedAt.set(key, Date.now())
        throw err
      })
      .finally(() => {
        if (_ensureThreadInflight.get(key) === inflight) {
          _ensureThreadInflight.delete(key)
        }
      })
    _ensureThreadInflight.set(key, inflight)
    try {
      const tid = await inflight
      this._lastEnsureThreadMeta = {
        sessionKey: key,
        cacheHit: false,
        coalesced: false,
        durationMs: Math.max(0, nowTs() - ensureStarted),
      }
      return tid
    } catch (err) {
      this._lastEnsureThreadMeta = {
        sessionKey: key,
        cacheHit: false,
        failed: true,
        durationMs: Math.max(0, nowTs() - ensureStarted),
      }
      throw err
    }
  }

  /** After LangGraph 404: bypass inflight/backoff and force ensure-thread round-trip. */
  async _ensureThreadAfterLangGraphMissing(sessionKey) {
    const key = sessionKey || MAIN_SESSION_KEY
    _ensureThreadFailedAt.delete(key)
    _ensureThreadInflight.delete(key)
    _ensureThreadCachedAt.delete(key)
    return this._ensureThreadOnce(key, { forceRecreate: true })
  }

  async _ensureThreadOnce(sessionKey, opts = {}) {
    const key = sessionKey || MAIN_SESSION_KEY
    try {
      const qs = opts && opts.forceRecreate ? '?force_recreate=1' : ''
      const data = await fetchJson(
        `/api/chat/sessions/${encodeURIComponent(key)}/ensure-thread${qs}`,
        {
          method: 'POST',
          preferGatewayHttp: true,
        },
      )
      const threadId = extractThreadId(data) || String(data?.threadId || '').trim()
      if (!threadId) throw new Error('ensure-thread 未返回 thread_id')
      const map = loadSessionMap()
      const prev = map[key] && typeof map[key] === 'object' ? map[key] : {}
      const prevThreadId = String(prev.threadId || '').trim()
      map[key] = {
        ...prev,
        threadId,
        createdAt: Number(prev.createdAt) || nowTs(),
        // ensure-thread after restart is not chat activity — keep prior stamp
        updatedAt: Number(prev.updatedAt) || Number(data?.updatedAt) || nowTs(),
        messageCount: Number(data?.messageCount ?? prev.messageCount) || 0,
        context: prev.context && typeof prev.context === 'object' ? prev.context : { ...buildDefaultSessionContext() },
      }
      saveSessionMap(map, { keys: [key] })
      notifySessionThreadRebound(key, prevThreadId, threadId)
      return threadId
    } catch (primaryErr) {
      const map = loadSessionMap()
      const prevThreadId = String(map[key]?.threadId || '').trim()
      const created = await createThreadRobust(key)
      const threadId = extractThreadId(created)
      if (!threadId) {
        const snippet = debugPayloadSnippet(created)
        const err = new Error(`创建会话失败：未返回 thread_id（返回=${snippet}）`)
        err.cause = created
        throw err
      }
      try {
        await this.bindSessionThread(key, threadId)
      } catch {
        map[key] = {
          ...(map[key] || {}),
          threadId,
          createdAt: map[key]?.createdAt || nowTs(),
          updatedAt: nowTs(),
          messageCount: map[key]?.messageCount || 0,
          context: map[key]?.context || { ...buildDefaultSessionContext() },
        }
        saveSessionMap(map, { keys: [key] })
      }
      notifySessionThreadRebound(key, prevThreadId, threadId)
      if (primaryErr) void primaryErr
      return threadId
    }
  }

  async _stopSessionRunsBestEffort(sessionKey, { userInitiated = false, signal = undefined } = {}) {
    const sk = String(sessionKey || '').trim()
    if (!sk) return { cancelled: [] }
    try {
      const qs = userInitiated ? '' : '?userInitiated=false'
      await evoflowFetch(`/api/chat/sessions/${encodeURIComponent(sk)}/execution/stop${qs}`, {
        method: 'POST',
        signal,
        preferGatewayHttp: true,
      })
    } catch {
      /* best-effort (incl. abort after send-prep timeout) */
    }
    return { cancelled: [] }
  }

  async getSessionRunStatus(sessionKey) {
    const key = sessionKey || MAIN_SESSION_KEY
    const threadId = this.getSessionThreadId(key)
    try {
      const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/execution/state`)
      if (data && data.ok === false) {
        return { threadId, run: null, runId: null, status: 'idle', executing: false, recently_completed: false, recently_completed_run_id: null, recently_completed_status: null }
      }
      const runId = String(data?.runId || '').trim() || null
      const status = String(data?.runStatus || data?.phase || 'done').trim().toLowerCase()
      return {
        threadId: threadId || String(data?.threadId || '').trim() || null,
        run: null,
        runId,
        status,
        executing: !!data?.executing,
        recently_completed: !!data?.recently_completed,
        recently_completed_run_id: data?.recently_completed_run_id || null,
        recently_completed_status: data?.recently_completed_status || null,
      }
    } catch {
      return { threadId, run: null, runId: null, status: 'idle', executing: false, recently_completed: false, recently_completed_run_id: null, recently_completed_status: null }
    }
  }
  async _markSessionRunIdleBestEffort(sessionKey) {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    try {
      await evoflowFetch(`/api/chat/sessions/${encodeURIComponent(sk)}/run-idle`, {
        method: 'POST',
      })
    } catch {
      /* attach stream cleanup or backend may have marked idle already */
    }
  }

  _markSessionRunActiveBestEffort(sessionKey, runId, threadId) {
    const sk = String(sessionKey || '').trim()
    const rid = String(runId || '').trim()
    if (!sk || !rid) return
    void fetchJson(`/api/chat/sessions/${encodeURIComponent(sk)}/run-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: rid,
        threadId: String(threadId || '').trim() || null,
      }),
    }).catch(() => {})
  }

  async cancelSessionActiveRuns(sessionKey) {
    const key = sessionKey || MAIN_SESSION_KEY
    return this._stopSessionRunsBestEffort(key, { userInitiated: true })
  }

  /**
   * Merge thread collab snapshot with GET /api/tasks/:id so subtasks show after restart→chat
   * without supervisor create_subtasks tool messages on the stream.
   */
  async hydrateCollabSidebarSnapshot(threadId, taskId, options = {}) {
    const tid = (threadId || '').toString().trim()
    const tk = (taskId || '').toString().trim()
    if (tid) {
      return mergeCollabSidebarSnapshotFromApis(tid, tk, options)
    }
    if (!tk) return null
    return mergeCollabSidebarSnapshotFromApis('', tk, options)
  }

  _dispatchResumeSseFrame(sessionKey, runId, frameText, evfLane) {
    const key = sessionKey || MAIN_SESSION_KEY
    const wireFormat = resolveStreamWireFormat()
    dispatchChatWireSseFrame(this, {
      sessionKey: key,
      runId: String(runId),
      frameText,
      evfLane,
      aguiStreamMode: wireFormat === 'agui',
      openAiStreamMode: wireFormat === 'openai',
      onValues: (data) => dispatchStreamValuesFrame(this, key, String(runId), data, evfLane, {}),
    })
  }

  /** Resume chat via Gateway history-poll stream-resume (DB snapshots until run ends). */
  async resumeChatStream(sessionKey, { runId, threadId, controller, transcriptAnchor, resumeReason, onHistorySnapshot } = {}) {
    const key = sessionKey || MAIN_SESSION_KEY
    const rid = String(runId || '').trim()
    if (!rid) {
      srWarn('resumeChatStream missing runId', { sessionKey: key })
      return { ok: false, resumeUnavailable: { reason: 'mirrorUnavailable' } }
    }

    srLog('resumeChatStream start', {
      sessionKey: key,
      runId: rid,
      threadId: threadId || this.getSessionThreadId(key) || null,
      resumeReason: resumeReason || null,
    })

    const ctrl = controller || new AbortController()
    for (const [existingRunId, existingCtrl] of [...this._abortByRunId.entries()]) {
      if (existingRunId === rid) continue
      try {
        existingCtrl.abort()
      } catch {
        /* ignore */
      }
      this._abortByRunId.delete(existingRunId)
    }
    this._abortByRunId.set(rid, ctrl)
    this._latestRunBySession.set(key, rid)
    markSessionStreamWireSource(key, 'stream-resume')
    markStreamCompareSession(key)
    markStreamCompareRun(key, rid)
    // Do not POST run-active here — it clears the stream mirror before catchup replay.
    this._emitEvent('chat', { sessionKey: key, runId: rid, state: 'run_started' })

    const resumeWireFormat = resolveStreamWireFormat()
    const evfLane = {
      finalText: '',
      firstPageTokenReported: false,
      evfRunEndSeen: false,
      aguiDeferredFinalTimer: null,
      deltaCount: 0,
      lastError: '',
      userInterrupt: false,
      aguiStreamMode: resumeWireFormat === 'agui',
      openAiStreamMode: resumeWireFormat === 'openai',
      openAiLane: resumeWireFormat === 'openai' ? createOpenAiStreamLane() : null,
      priorTurnStripPrefix: '',
      priorTurnStripBundle: EMPTY_WS_PRIOR_STRIP,
      runUsage: createLangGraphRunUsageAccumulator(),
      traceId: '',
      threadId: String(threadId || ''),
      userInputTsMs: 0,
      streamPath: `/api/chat/sessions/${key}/stream-resume`,
      dispatchCustomViaLegacy: null,
      toolCallAccumById: new Map(),
      toolCallIndexToKey: new Map(),
      lastEvfToolEmitSig: new Map(),
      lastEvfToolFnLen: new Map(),
      lastEvfToolContentLen: new Map(),
      lastUsageEmitSig: '',
    }
    applyTranscriptResumeAnchorToLane(evfLane, transcriptAnchor)
    applyTranscriptAnchorStripToLane(evfLane, transcriptAnchor)
    bindEvfLaneCustomDispatch(this, key, rid, evfLane)
    evfLane.suppressHeaderReplay = true
    markSessionResumeCatchupReplay(key, true)

    const effectiveThreadId = String(threadId || this.getSessionThreadId(key) || '').trim()
    let runEndedRemotely = false
    let unsubPanelStream = null
    if (effectiveThreadId) {
      unsubPanelStream = subscribeThreadPanelSse(effectiveThreadId, (dataJson) => {
        try {
          const ev = JSON.parse(String(dataJson || '{}'))
          if (String(ev?.type || '').trim() !== 'panel:run_ended') return
          const evData = ev?.data && typeof ev.data === 'object' ? ev.data : {}
          if (String(evData.thread_id || '').trim() !== effectiveThreadId) return
          srLog('resumeChatStream panel:run_ended', { sessionKey: key, runId: rid })
          runEndedRemotely = true
          try { ctrl.abort() } catch { /* ignore */ }
        } catch {
          /* ignore malformed panel SSE */
        }
      })
    }

    try {
      const { streamResumeFetch } = await import('../react/lib/stream-resume-fetch.ts')
      const resumeSseQueue = createSseFrameQueue((frame) =>
        this._dispatchResumeSseFrame(key, rid, frame, evfLane),
      )
      let resumeQueueDrained = false
      try {
        const result = await streamResumeFetch({
          sessionKey: key,
          runId: rid,
          threadId: threadId || this.getSessionThreadId(key),
          signal: ctrl.signal,
          resumeReason: resumeReason || 'unknown',
          onResumePhase: (phase) => {
            if (phase === 'live') {
              evfLane.suppressHeaderReplay = false
              markSessionResumeCatchupReplay(key, false)
            }
          },
          onHistorySnapshot: (snapshot) => {
            try {
              onHistorySnapshot?.(snapshot)
            } catch {
              /* best-effort UI refresh */
            }
          },
          onWireFrame: (frame) => resumeSseQueue.push(frame),
        })
        resumeSseQueue.flush()
        resumeQueueDrained = true
        srLog('resumeChatStream done', {
          sessionKey: key,
          runId: rid,
          deltaCount: evfLane.deltaCount,
          finalTextLen: evfLane.finalText.length,
          completed: Boolean(result.completed),
          resumeUnavailable: result.resumeUnavailable ?? null,
          evfRunEndSeen: evfLane.evfRunEndSeen,
        })
        if (result.completed) {
          evfLane.evfRunEndSeen = true
          if (!evfLane.finalEmitted) {
            evfLane.finalEmitted = true
            const completedText = String(evfLane.finalText || '').trim()
            this._emitEvent('chat', {
              sessionKey: key,
              runId: rid,
              state: 'final',
              streamTimelineAuthoritative: true,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: completedText }],
              },
            })
          }
          return { ok: true, completed: result.completed, runId: rid }
        }
        if (result.resumeUnavailable) {
          return { ok: false, resumeUnavailable: result.resumeUnavailable, runId: rid }
        }
        return { ok: true, runId: rid }
      } finally {
        if (!resumeQueueDrained) {
          try {
            resumeSseQueue.flush()
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      if (ctrl.signal?.aborted) {
        if (runEndedRemotely) {
          srLog('resumeChatStream aborted by panel:run_ended', { sessionKey: key, runId: rid })
          // 后台 run 已结束（panel:run_ended），emit final 让 UI 清除"运行中"状态。
          // abort 时 streamResumeFetch 抛 AbortError，正常 completed 路径的 emit 被跳过，
          // 不补这一帧的话 ChatApp 气泡会一直停在"流式中"。
          evfLane.evfRunEndSeen = true
          if (!evfLane.finalEmitted) {
            evfLane.finalEmitted = true
            this._emitEvent('chat', {
              sessionKey: key,
              runId: rid,
              state: 'final',
              streamTimelineAuthoritative: true,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: String(evfLane.finalText || '').trim() }],
              },
            })
          }
          return { ok: true, completed: true, runId: rid, remoteEnded: true }
        }
        srLog('resumeChatStream aborted', { sessionKey: key, runId: rid })
        return { ok: true, aborted: true, runId: rid }
      }
      srWarn('resumeChatStream error', {
        sessionKey: key,
        runId: rid,
        error: String(err?.message || err),
      })
      throw err
    } finally {
      if (unsubPanelStream) {
        try { unsubPanelStream() } catch { /* ignore */ }
      }
      evfLane.suppressHeaderReplay = false
      markSessionResumeCatchupReplay(key, false)
      this._abortByRunId.delete(rid)
    }
  }

  /**
   * LangGraph 使用全局 worker 池（N_JOBS_PER_WORKER）。仅取消「当前 thread」上的 run 无法释放
   * 其它会话里卡住的 running/pending，会导致新会话的 /runs/stream 一直排队无首包。
   * 官方 POST /runs/cancel + { status: "all" } 会取消所有线程上的 pending+running。
   * 本地调试可在 localStorage 设 evoflow-disable-global-run-cancel=1 关闭该行为。
   */
  async cancelAllGlobalRunsBestEffort() {
    if (typeof localStorage !== 'undefined') {
      if (localStorage.getItem('evoflow-disable-global-run-cancel') === '1') {
        return { skipped: true }
      }
    }
    if (_globalRunCancelIsUnsupported()) {
      return { ok: true, cancelled: false, skipped: true }
    }
    try {
      const resp = await evoflowFetch('/api/langgraph/runs/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'all' }),
      })
      if (resp.status === 404) {
        // Legacy gateways: mount swallowed the route — remember and stop noisy retries.
        _markGlobalRunCancelUnsupported()
        return { ok: true, cancelled: false, skipped: true }
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(text || `HTTP ${resp.status}`)
      }
      return { ok: true, cancelled: true }
    } catch (e) {
      // swallow
      return { ok: false, error: String(e?.message || e) }
    }
  }

  async chatSend(sessionKey, message, attachments, contextFiles, opts = {}) {
    const isStreamReadTimeoutError = (err) => {
      const msg = String(err?.message || err || '')
      return err?.code === 'STREAM_READ_TIMEOUT' || /前端流超时|stream read timeout/i.test(msg)
    }
    const key = sessionKey || MAIN_SESSION_KEY
    // 用户主动再发：清掉上一轮 stop 残留标记，避免新流被当成 user_interrupt / 空 final
    if (_userStopSessionKeys.has(key)) _userStopSessionKeys.delete(key)
    if (_userStopSkipRunIdleKeys.has(key)) _userStopSkipRunIdleKeys.delete(key)
    if (_langGraphDead) {
      console.warn('[evoflow] chatSend blocked: LangGraph previously marked dead')
      throw new Error(
        'LangGraph 服务不可用（/api/langgraph/* 全部返回 404），请确认 Gateway 启动日志中包含 "[gateway] LangGraph mounted at /api/langgraph" 后重试',
      )
    }
    const userInputTsMs = nowTs()
    const traceId = uuid()
    /** Thread 创建/解析超时保护：避免 LangGraph 不可达时整个发送链路卡死 */
    const THREAD_ENSURE_TIMEOUT_MS = 15000
    let threadId = await withTimeout(
      this._ensureThread(key),
      THREAD_ENSURE_TIMEOUT_MS,
      null,
    ).catch(() => null)
    const ensureMeta =
      this._lastEnsureThreadMeta && this._lastEnsureThreadMeta.sessionKey === key
        ? this._lastEnsureThreadMeta
        : { cacheHit: false, durationMs: Math.max(0, nowTs() - userInputTsMs) }
    if (!threadId || !isLanggraphLeadThreadId(threadId)) {
      throw new Error('创建会话失败：后端无响应，请确认 LangGraph 服务已启动且 Gateway 连接正常')
    }

    const isImageAtt = (att) => {
      const mime = String(att?.mimeType || '').toLowerCase()
      if (mime.startsWith('image/')) return true
      const name = String(att?.filename || att?.file?.name || '')
      return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(name)
    }
    const imageAtts = []
    const docAtts = []
    if (Array.isArray(attachments) && attachments.length) {
      for (const att of attachments) {
        if (!att) continue
        if (isImageAtt(att) && att.content) imageAtts.push(att)
        else if (!isImageAtt(att) && (att.file || att.content)) docAtts.push(att)
      }
    }

    /** Document attach → thread uploads/ + markitdown before run starts. */
    let uploadedFilesMeta = []
    if (docAtts.length) {
      const toUpload = []
      for (const att of docAtts) {
        const name = String(att.filename || att.file?.name || 'file').trim() || 'file'
        if (att.file instanceof Blob) {
          toUpload.push(
            att.file instanceof File
              ? att.file
              : new File([att.file], name, { type: att.mimeType || 'application/octet-stream' }),
          )
          continue
        }
        if (!att.content) continue
        try {
          const bin = atob(att.content)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          toUpload.push(new File([bytes], name, { type: att.mimeType || 'application/octet-stream' }))
        } catch (e) {
          console.warn('[evoflow] rebuild upload blob failed', name, e)
        }
      }
      if (toUpload.length) {
        const { api } = await import('./tauri-api.js')
        const result = await api.uploadThreadFiles(threadId, toUpload)
        for (const info of result?.files || []) {
          const filename = String(info?.filename || '').trim()
          if (!filename) continue
          uploadedFilesMeta.push({
            filename,
            size: Number(info.size) || 0,
            path: info.virtual_path || `/mnt/user-data/uploads/${filename}`,
            status: 'uploaded',
          })
          const mdName = String(info?.markdown_file || '').trim()
          if (mdName) {
            uploadedFilesMeta.push({
              filename: mdName,
              size: 0,
              path: info.markdown_virtual_path || `/mnt/user-data/uploads/${mdName}`,
              status: 'uploaded',
            })
          }
        }
      }
    }

    // New input should not be hard-blocked by cleanups.
    // Runtime: turn/start does not cancel-then-restart — engine interrupt/steer owns takeover.
    // Same thread uses multitask_strategy=interrupt on POST; skip send-prep execution/stop
    // so we do not stack HTTP cancel latency onto every message.
    const runId = uuid()
    const controller = new AbortController()
    this._abortByRunId.set(runId, controller)
    this._latestRunBySession.set(key, runId)
    markSessionStreamWireSource(key, 'run')
    markStreamCompareSession(key)
    // 须在 POST /runs/stream 之前发出，供 ChatApp 绑定 expectedChatRunId（空 final 在 await chatSend 返回前就会到达）。
    this._emitEvent('chat', { sessionKey: key, runId, state: 'run_started' })
    // 优化：移除 POST run-active，后端在处理 POST /runs/stream 时可自行推断会话活跃状态

    const text = String(message || '')
    const blocks = []
    if (text.trim()) {
      blocks.push({ type: 'text', text })
    }
    for (const att of imageAtts) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mimeType || 'image/png',
          data: att.content,
        },
      })
    }
    // Never send a lone empty text part — it becomes a blank HumanMessage in checkpoint.
    if (!blocks.length) {
      throw new Error('empty message')
    }

    const map = loadSessionMap()
    const sessionContext = { ...(map[key]?.context || {}) }
    // model_name 由 ChatApp 按会话写入 context（发送前也会硬同步）；不在此用全局 localStorage 覆盖，避免 UI 与后端不一致
    // Prefer context agent_id/agent_name (in-session role switch) over sessionKey embedding.
    const keyStr = String(key || '')
    const keyParts = keyStr.split(':')
    const proactiveFromKey =
      keyStr.toLowerCase().startsWith('proactive:') && keyParts.length >= 2
        ? String(keyParts[1] || '').trim()
        : ''
    const parsedFromKey = proactiveFromKey
      ? proactiveFromKey
      : keyStr.toLowerCase().startsWith('agent:') && keyParts.length >= 2
        ? keyParts[1]
        : 'main'
    const ctxAgentId = String(sessionContext.agent_id || '').trim()
    const ctxAgentName = String(sessionContext.agent_name || '').trim()
    const ctxProactiveCode = String(sessionContext.proactive_agent_code || '').trim()
    const parsedAgent = ctxAgentId || ctxAgentName || ctxProactiveCode || parsedFromKey
    /** Preset「Claude Code」：会话 context.use_claude_code_chat 或 sessionKey agent:claude-code:* 时直连 claude_session 图。 */
    const rawClaudeFlag = sessionContext.use_claude_code_chat
    const ctxClaudeCodeChat =
      rawClaudeFlag === true ||
      rawClaudeFlag === 1 ||
      String(rawClaudeFlag || '').toLowerCase() === 'true'
    const useClaudeCodeChat =
      ctxClaudeCodeChat || String(parsedAgent || '').toLowerCase() === 'claude-code'
    const proactiveAgentCode = proactiveFromKey || ctxProactiveCode || ''
    const defaultContext = {
      ...buildDefaultSessionContext(),
      agent_name: parsedAgent, // Pass agent name so backend loads correct config
      ...(ctxAgentId || proactiveAgentCode
        ? { agent_id: ctxAgentId || proactiveAgentCode }
        : {}),
      ...(proactiveAgentCode
        ? {
            proactive_agent_code: proactiveAgentCode,
            source: String(sessionContext.source || 'proactive').trim() || 'proactive',
          }
        : {}),
    }

    const clientTaskIdEarly = (sessionContext.collab_task_id ?? '').toString().trim()
    const phaseEarly = (sessionContext.collab_phase ?? '').toString().trim().toLowerCase()
    const needsCollabPreflight =
      Boolean(clientTaskIdEarly) ||
      (phaseEarly && phaseEarly !== 'idle' && phaseEarly !== 'done')
    // 优化：用本地 context 替代 GET /api/collab/threads/{tid}，省掉一次网络往返。
    // 阶段一的 PATCH context 已同步最新 collab_phase/collab_task_id，本地值即为权威值。
    const serverCollab = needsCollabPreflight
      ? { collab_phase: phaseEarly, bound_task_id: clientTaskIdEarly }
      : null

    const userQuestionText = String(message || '').trim()
    const sendPriorStripBundle = priorTurnStripBundleFromSendOpts(opts)
    const priorAssistantPrefix =
      sendPriorStripBundle.body ||
      (opts && typeof opts === 'object' ? String(opts.priorAssistantPrefix || '').trim() : '')
    const priorAssistantMessageId =
      opts && typeof opts === 'object' ? String(opts.priorAssistantMessageId || '').trim() : ''
    const preferredSkillRaw =
      opts && typeof opts === 'object'
        ? (opts.preferredSkills || opts.preferred_skills || opts.preferredSkill || opts.preferred_skill)
        : ''
    // 支持多选：数组直接用；单字符串/逗号分隔降级为单元素数组
    let preferredSkillsArr = Array.isArray(preferredSkillRaw)
      ? preferredSkillRaw
        .map((s) => String(s || '').trim())
        .filter(Boolean)
      : String(preferredSkillRaw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    // Sticky session selection (survives follow-up turns when composer opts omit skills).
    if (!preferredSkillsArr.length) {
      const sticky = sessionContext.preferred_skills ?? sessionContext.preferred_skill
      if (Array.isArray(sticky)) {
        preferredSkillsArr = sticky.map((s) => String(s || '').trim()).filter(Boolean)
      } else {
        const one = String(sticky || '').trim()
        if (one) preferredSkillsArr = [one]
      }
    }
    const runContext = applySessionUserPrefsToRunContext(
      {
        ...defaultContext,
        ...sessionContext,
        thread_id: threadId,
        session_key: key,
        // 主聊天进入 proactive:{code} 时强制岗位身份，避免解析成 main
        ...(proactiveAgentCode
          ? {
              proactive_agent_code: proactiveAgentCode,
              agent_id: proactiveAgentCode,
              agent_name:
                String(sessionContext.agent_name || '').trim() &&
                String(sessionContext.agent_name || '').trim().toLowerCase() !== 'main'
                  ? String(sessionContext.agent_name).trim()
                  : proactiveAgentCode,
              source: String(sessionContext.source || 'proactive').trim() || 'proactive',
            }
          : {}),
        evf_trace_id: traceId,
        evf_user_input_ts_ms: userInputTsMs,
        evf_client_ensure_thread_ms: Number(ensureMeta.durationMs) || 0,
        evf_client_ensure_cache_hit: !!ensureMeta.cacheHit,
        evf_client_prep_ms: 0,
        evf_client_fetch_start_ms: 0,
        // Interactive chat: Gateway preempts proactive wait runs so this stream
        // is not starved on the shared Windows asyncio loop.
        evf_interactive: !proactiveAgentCode,
        ...(userQuestionText
          ? { evf_user_question: userQuestionText, user_message: userQuestionText }
          : {}),
        ...(priorAssistantPrefix
          ? { evf_prior_assistant_prefix: priorAssistantPrefix.slice(0, 8000) }
          : {}),
        ...(priorAssistantMessageId
          ? { evf_prior_assistant_message_id: priorAssistantMessageId }
          : {}),
        ...(preferredSkillsArr.length ? { preferred_skills: preferredSkillsArr } : {}),
        ...(opts &&
        typeof opts === 'object' &&
        (opts.voiceInitiated || opts.voiceReply)
          ? {
              is_voice_channel: true,
              channel: 'voice',
              thinking_enabled: false,
              thinking_type: 'disabled',
              reasoning_effort: 'minimum',
            }
          : {}),
      },
      sessionContext,
    )
    // Inject current human identity for runtime attribution (transcript / usage / tools).
    // Do not fall back to sessionContext.created_by — that can be the previous user's
    // restored local session after switch-user.
    // TTFT: never await ensureMeReady on the hot path — cache miss warms in background.
    try {
      let me = getCachedMe()
      if (!String(me?.principalId || '').trim()) {
        void ensureMeReady().catch(() => {})
      }
      const pid = String(me?.principalId || '').trim()
      if (pid) {
        runContext.principal_id = pid
        runContext.created_by = pid
        runContext.owner_scope_id = `personal:${pid}`
      }
    } catch {
      /* ignore */
    }
    // Hard guard: flash mode must not enable reasoning/thinking,
    // even if stale context/collab state exists.
    const mode = String(sessionContext.session_mode || '').trim().toLowerCase()
    const thinkingType = String(sessionContext.thinking_type || runContext.thinking_type || '').trim().toLowerCase()
    const voiceTurn = !!(
      opts &&
      typeof opts === 'object' &&
      (opts.voiceInitiated || opts.voiceReply)
    )
    if (mode === 'flash' || voiceTurn) {
      runContext.thinking_enabled = false
      runContext.reasoning_effort = 'minimum'
      if (voiceTurn) {
        runContext.thinking_type = 'disabled'
        runContext.is_voice_channel = true
        runContext.channel = 'voice'
        // Voice fast path: no plan middleware unless session already mid-collab.
        const phase = String(runContext.collab_phase || sessionContext.collab_phase || '')
          .trim()
          .toLowerCase()
        if (!phase || phase === 'idle' || phase === 'done') {
          runContext.is_plan_mode = false
        }
      }
      if (mode === 'flash') {
        runContext.is_plan_mode = false
        runContext.subagent_enabled = false
      }
    } else if (mode === 'auto' || thinkingType === 'auto') {
      runContext.thinking_type = 'auto'
      delete runContext.thinking_enabled
      delete runContext.reasoning_effort
      if (mode === 'auto') {
        runContext.is_plan_mode = false
        runContext.subagent_enabled = false
      }
    } else if (thinkingType === 'manual') {
      // 用户手动选择思考等级：thinking_enabled + reasoning_effort 已由 sessionContextToRunContext 从 sessionContext 读入
      // 不删 runContext.thinking_enabled / reasoning_effort，让后端直接使用用户选的等级
      runContext.thinking_type = 'manual'
    } else if (mode === 'ultra') {
      runContext.thinking_enabled = true
      runContext.reasoning_effort = runContext.reasoning_effort || 'high'
      runContext.is_plan_mode = false
      runContext.subagent_enabled = true
      const phaseForUltra = (runContext.collab_phase ?? '').toString().trim()
      if (!phaseForUltra || phaseForUltra === 'idle') {
        runContext.collab_phase = 'idle'
      }
    }
    // 会话已绑定 local_workspace_root 时必须走本地目录，不能被全局虚拟路径开关覆盖。
    const sessionWsRoot = String(sessionContext.local_workspace_root || runContext.local_workspace_root || '').trim()
    if (sessionWsRoot) {
      runContext.local_workspace_root = sessionWsRoot
      runContext.use_virtual_paths = false
    } else if (isWorkspaceUserPinned(sessionContext) || sessionContext.use_virtual_paths === false) {
      runContext.use_virtual_paths = false
    } else {
      runContext.use_virtual_paths = getUseVirtualPaths()
    }

    const clientTaskId = (sessionContext.collab_task_id ?? '').toString().trim()

    if (serverCollab && typeof serverCollab === 'object') {
      const phase = serverCollab.collab_phase
      const phaseStr = (phase ?? '').toString().trim()
      const phaseLc = phaseStr.toLowerCase()
      // 仅「仍在协作流水线中」的阶段才把服务端 bound_task_id 带给本次 run；done/idle 等残留绑定会导致新提问重放旧任务工具态
      const PHASES_THAT_KEEP_BOUND_TASK = new Set([
        'executing',
        'awaiting_exec',
        'plan_ready',
        'planning',
        'req_confirm',
      ])
      const keepBoundOnServer = PHASES_THAT_KEEP_BOUND_TASK.has(phaseLc)
      if (phase != null && phase !== '') {
        if (!keepBoundOnServer && !clientTaskId) {
          runContext.collab_phase = 'idle'
        } else {
          runContext.collab_phase = phase
        }
      }
      // Collab phase 不是 idle 时，强制启用 plan + subagent（避免前端写入 context 发生 race）
      const phaseForPlan = (runContext.collab_phase ?? '').toString().trim()
      const collabActive = !!phaseForPlan && phaseForPlan !== 'idle'
      if (collabActive) {
        runContext.is_plan_mode = true
        runContext.subagent_enabled = true
      }
      const boundTid = (serverCollab.bound_task_id ?? '').toString().trim()
      if (clientTaskId) {
        runContext.collab_task_id = clientTaskId
      } else if (boundTid && keepBoundOnServer) {
        runContext.collab_task_id = boundTid
      } else {
        delete runContext.collab_task_id
      }
    } else {
      if (clientTaskId) runContext.collab_task_id = clientTaskId
      else delete runContext.collab_task_id
    }

    if (useClaudeCodeChat) {
      runContext.agent_name = 'claude-code'
      runContext.thinking_enabled = false
      runContext.reasoning_effort = 'minimum'
      runContext.is_plan_mode = false
      runContext.subagent_enabled = false
      runContext.collab_phase = 'idle'
      delete runContext.collab_task_id
    }

    if (opts && typeof opts === 'object' && (opts.goalInitiated || opts.hostedInitiated)) {
      runContext.goal_automated = true
      runContext.goal_mode = true
      runContext.prompt_source = 'user'
    }

    const sessionModelName =
      (sessionContext.model_name || sessionContext.primary_model_name || '').toString().trim() || null
    // Mid-turn ↑ inject already wrote the user row; skip to avoid duplicate transcript.
    // Non-blocking: do not await before POST runs/stream (TTFT). Hydration may merge the
    // single in-flight HumanMessage if the row is not in DB yet — history always comes
    // from evoflow_chat_messages, never from replaying the LangGraph checkpoint.
    // Stable id shared by transcript append + LangGraph input (avoids LG-auto id mismatch).
    const userMsgId =
      String(opts?.messageId || '').trim() ||
      `user-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`
    if (!opts?.skipTranscriptAppend) {
      void appendSessionTranscriptMessage(
        key,
        userBlocksToFlatTranscriptRow(blocks, userMsgId, {
          runId,
          modelName: sessionModelName,
          contextFiles: Array.isArray(contextFiles)
            ? contextFiles
                .map((f) => ({
                  path: String(f.path || '').trim(),
                  name: String(f.name || '').trim() || String(f.path || '').trim(),
                }))
                .filter((f) => f.path)
            : undefined,
        }),
        {
          runId,
          threadId,
        },
      ).catch((e) => {
        // Gateway 冷启动 / DB 短暂锁：已重试；流式仍会继续，hydration merge / TranscriptMiddleware 会兜底
        console.debug('[evoflow] append user transcript deferred', e)
      })
    }
    const userMessage = {
      role: 'user',
      content: blocks,
      id: userMsgId,
    }
    const kwargs = {}
    if (Array.isArray(contextFiles) && contextFiles.length) {
      kwargs.context_files = contextFiles.map((f) => ({
        path: String(f.path || '').trim(),
        name: String(f.name || '').trim() || String(f.path || '').trim(),
      }))
      console.info('[evoflow] chatSend context_files', kwargs.context_files)
    }
    if (uploadedFilesMeta.length) {
      kwargs.files = uploadedFilesMeta
    }
    if (Object.keys(kwargs).length) {
      userMessage.additional_kwargs = kwargs
    }
    /**
     * 模型上下文以 ``evoflow_chat_messages`` 为准（TranscriptMiddleware 写入；UI 亦读此表）。
     * LangGraph ``input.messages`` 仅本轮 user，只进**运行时内存**（DB 异步落库竞态兜底）；
     * durable checkpoint 由后端 OmitTranscriptCheckpointer 剥离，不落对话全文。
     */
    const inputMessages = [userMessage]

    // LangGraph Agent Server 禁止同一 run 同时携带 config.configurable 与 context；
    // 目标模式字段须写入 context（与 Gateway hosted_service merge_configurable_into_context 一致）。
    const body = {
      assistant_id: useClaudeCodeChat ? 'claude_code_chat' : 'lead_agent',
      input: { messages: inputMessages },
      // Keep ``values``: dropping it caused chat SSE to finish with 0 assistant deltas
      // (AG-UI/tool anchoring still relies on state snapshots in several paths).
      stream_mode: ['values', 'messages-tuple', 'custom'],
      streamSubgraphs: true,
      streamResumable: true,
      // Transcript SSOT is evoflow_chat_messages; mid-step checkpoint of fat messages
      // was burning 1–3s on the next turn's load. exit = persist on graph exit /
      // interrupt only (HITL resume still checkpoints).
      durability: 'exit',
      // interrupt prior run on this thread — enqueue behind zombies leaves UI on「准备中…」
      multitask_strategy: 'interrupt',
      config: {
        recursion_limit: LONG_RUN_RECURSION_LIMIT,
      },
      context: runContext,
    }
    const started = nowTs()
    let finalText = ''
    let streamUiEmittedText = ''
    let lastAssistantTextFromValues = ''
    let firstPageTokenReported = false
    /** messages-tuple 已输出正文后，不再用 values 快照合并正文（双通道会重复/版本不一致） */
    let streamTextFromMessages = false
    /**
     * messages/messages-tuple 常先于「本轮 user 已写入」到达，会把上一轮 AI/工具块再推一遍（刷新后进会话再发消息尤其明显）。
     * values 通道已用 lastHumanMatchesRunInput 规避；此处必须等 values 确认锚定后再消费 messages 通道。
     */
    let messagesStreamAnchored = false
    /** values 已确认「最后一条 human === 本轮输入」后才允许下发工具（防上轮 tool 重放） */
    let streamAnchorOk = false
    let unanchoredMessagesEventCount = 0
    /** Cache early messages chunks until we are anchored, to avoid dropping the first token. */
    const bufferedUnanchoredMessagesRoots = []
    /**
     * messages-tuple 在锚定后仍可能重放整条线程里的历史 AI/tool 块；新 run 会清空 lastTupleToolCallEmitSig，
     * 若不拦截会把上一轮 tool_call 再 emit 一遍。解锁条件：① messages 已推过本轮可见正文增量；或 ② 带 LangGraph 元数据的 2-tuple 里「仅工具、无正文」的首包。
     */
    let allowMessagesTupleToolCalls = false
    /**
     * 默认从 values 下发工具（supervisor / 任务调度等依赖快照，否则仅靠 tuple 时常见「不显示工具请求」）。
     * 与正文一致：须等 messages-tuple 先推过本轮可见正文后才合并 values 快照，避免 [user_new, hint…, 旧 assistant] 误放行。
     * 完全关闭 values 工具：localStorage evoflow-suppress-values-tools=1。恢复旧版「有 hint 即信 values」：evoflow-values-before-tuple=1。
     */
    const EMIT_TOOL_EVENTS_FROM_VALUES_SNAPSHOT = !(
      typeof localStorage !== 'undefined' && localStorage.getItem('evoflow-suppress-values-tools') === '1'
    )
    /** 避免 values 快照每帧重复 emit 相同 tool_calls */
    let lastValuesToolCallsSig = ''
    /** 最后一次 values 快照中的展示消息（用于轮次结束批量落库） */
    let lastStreamDisplayMessages = []
    /** values 快照里 ToolMessage 结果：每轮 tool_call_id 只 emit 一次（补 messages-tuple 未下发的 plan 等结果） */
    const emittedToolResultById = new Set()
    const runUsage = createLangGraphRunUsageAccumulator()
    let evfLane = null

    try {
      // multitask_strategy=interrupt on the stream body cancels prior runs on this thread
      // (Runtime: start_or_steer / interrupt inside the engine — no pre-flight HTTP stop).
      const STREAM_SILENT_WARN_MS = 180 * 1000
      const streamWallStartedAt = Date.now()
      let streamLastEventTs = Date.now()
      let streamSilentWarned = false
      let streamReadTimedOut = false

      const readWithDeadline = (rdr) => {
        const wallRemaining = Math.max(0, LONG_RUN_WALL_MS - (Date.now() - streamWallStartedAt))
        const idleRemaining = Math.max(0, FRONTEND_STREAM_IDLE_TIMEOUT_MS - (Date.now() - streamLastEventTs))
        const remaining = Math.min(wallRemaining, idleRemaining)
        if (remaining <= 0) {
          const err = new Error(
            wallRemaining <= 0
              ? '前端流超时：分析耗时超过上限，任务仍在后台运行，正在尝试续接…'
              : '前端流超时：长时间无新输出，任务仍在后台运行，正在尝试续接…',
          )
          err.code = 'STREAM_READ_TIMEOUT'
          return Promise.reject(err)
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const timeoutErr = new Error(
              idleRemaining <= wallRemaining
                ? '前端流超时：长时间无新输出，任务仍在后台运行，正在尝试续接…'
                : '前端流超时：分析耗时超过上限，任务仍在后台运行，正在尝试续接…',
            )
            timeoutErr.code = 'STREAM_READ_TIMEOUT'
            reject(timeoutErr)
          }, remaining)
          rdr.read().then((r) => { clearTimeout(timer); resolve(r) }, (e) => { clearTimeout(timer); reject(e) })
        })
      }

      /** Stream POST 连接阶段超时：避免 LangGraph 无响应时首包永远等不到 */
      const STREAM_CONNECT_TIMEOUT_MS = 30000

      let activeThreadId = threadId
      let resp = null
      /** Structured pipe events may arrive before dispatchParsedStreamEvent exists — buffer them. */
      const structuredEventBuf = []
      let structuredDispatch = null
      const onStreamEvent = (eventName, data) => {
        if (structuredDispatch) structuredDispatch(eventName, data)
        else structuredEventBuf.push([eventName, data])
      }
      for (let streamAttempt = 0; streamAttempt < 2; streamAttempt++) {
        try {
          const connectTimer = setTimeout(() => {
            controller.abort()
          }, STREAM_CONNECT_TIMEOUT_MS)
          const fetchStartMs = nowTs()
          runContext.evf_client_fetch_start_ms = fetchStartMs
          runContext.evf_client_prep_ms = Math.max(0, fetchStartMs - userInputTsMs)
          resp = await evoflowFetchStream(
            `/api/langgraph/threads/${encodeURIComponent(activeThreadId)}/runs/stream?${langGraphRunStreamQueryParam(resolveStreamWireFormat())}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-evoflow-stream-resume': '1',
              },
              body: JSON.stringify(body),
              signal: controller.signal,
              onStreamEvent,
            },
          ).finally(() => { clearTimeout(connectTimer) })
          if (!resp.ok) {
            const text = await resp.text?.().catch(() => '') ?? ''
            const httpErr = new Error(text || `HTTP ${resp.status}`)
            httpErr.status = resp.status
            throw httpErr
          }
          threadId = activeThreadId
          break
        } catch (streamStartErr) {
          if (
            streamAttempt === 0 &&
            !controller.signal.aborted &&
            isLangGraphThreadOrAssistantMissing(streamStartErr)
          ) {
            activeThreadId = await withTimeout(
              this._ensureThreadAfterLangGraphMissing(key),
              THREAD_ENSURE_TIMEOUT_MS,
              null,
            ).catch(() => null)
            if (activeThreadId) {
              threadId = activeThreadId
              runContext.thread_id = activeThreadId
              if (body.context && typeof body.context === 'object') {
                body.context.thread_id = activeThreadId
              }
              console.info('[evoflow] recreated stale LangGraph thread after restart', {
                sessionKey: key,
                threadId: activeThreadId,
              })
              continue
            }
            throw new Error('重试创建会话失败：后端无响应', { cause: streamStartErr })
          }
          // 重试后仍 404 → LangGraph 未就绪（in-process mount 可能失败了），不再重试
          if (isLangGraphThreadOrAssistantMissing(streamStartErr)) {
            _langGraphDead = true
            console.warn('[evoflow] _langGraphDead=true (POST /runs/stream 404 after retry)')
            throw new Error(
              'LangGraph 服务未就绪，请检查 Gateway 启动日志中是否包含 "[gateway] LangGraph mounted at /api/langgraph" 确认 mount 成功',
              { cause: streamStartErr },
            )
          }
          throw streamStartErr
        }
      }
      if (!resp?.ok) {
        const text = await resp?.text?.().catch(() => '') ?? ''
        throw new Error(text || `HTTP ${resp?.status ?? 'unknown'}`)
      }
      const useStructuredPipe = !!resp.structured
      if (!useStructuredPipe && !resp.body) throw new Error('响应流为空')

      /** Gateway AG-UI event stream（``?ui_sse=1&stream_format=agui``） */
      const uiStreamMode = true
      const sendWireFormat = resolveStreamWireFormat()
      const openAiStreamMode = sendWireFormat === 'openai'
      const aguiStreamMode = sendWireFormat === 'agui'
      const streamPath = `/api/langgraph/threads/${threadId}/runs/stream?${langGraphRunStreamQueryParam(sendWireFormat)}`

      const reader = useStructuredPipe ? null : resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sseBytesReceived = 0
      let sseFrameCount = 0
      evfLane = {
        finalText: '',
        firstPageTokenReported: false,
        evfRunEndSeen: false,
        aguiDeferredFinalTimer: null,
        finalEmitted: false,
        deltaCount: 0,
        lastError: '',
        userInterrupt: false,
        openAiStreamMode,
        aguiStreamMode,
        openAiLane: openAiStreamMode ? createOpenAiStreamLane() : null,
        priorTurnStripPrefix: pickRichestAssistantStripPrefix(sendPriorStripBundle.body),
        priorTurnStripBundle: sendPriorStripBundle,
        runUsage,
        traceId,
        threadId,
        userInputTsMs,
        streamPath,
        dispatchCustomViaLegacy: null,
        toolCallAccumById: new Map(),
        toolCallIndexToKey: new Map(),
        lastEvfToolEmitSig: new Map(),
        lastEvfToolFnLen: new Map(),
        lastEvfToolContentLen: new Map(),
        lastUsageEmitSig: '',
      }
      const streamFinalCtx = {
        key,
        runId,
        threadId,
        traceId,
        userInputTsMs,
        started,
        get uiStreamMode() {
          return uiStreamMode
        },
        get finalText() {
          return evfLane?.finalText || finalText
        },
        get lastStreamDisplayMessages() {
          return lastStreamDisplayMessages
        },
        get lastAssistantTextFromValues() {
          return lastAssistantTextFromValues
        },
        get prevTurnAssistantStripPrefix() {
          return prevTurnAssistantStripPrefix
        },
        get prevTurnStripBundle() {
          return prevTurnStripBundle
        },
        get evfLane() {
          return evfLane
        },
        runUsage,
      }
      evfLane.tryEmitChatStreamFinal = () => tryEmitChatStreamFinal(this, streamFinalCtx)
      /** messages 通道里同一 tool_call 会在多帧重复携带，避免重复 emit 导致列表闪动/重复合并 */
      const lastTupleToolCallEmitSig = new Map()
      /** 同一 tool_call_id 跨帧累积（首帧常无参数，后续帧补 args / function.arguments） */
      const tupleToolCallAccumById = new Map()
      /** 由 values 快照 + UI 封存行维护：上一轮 assistant 全文；messages-tuple 常把该段误拼进当前块 */
      let prevTurnStripBundle = { ...sendPriorStripBundle }
      let prevTurnAssistantStripPrefix = pickRichestAssistantStripPrefix(sendPriorStripBundle.body)
      /**
       * Consume one "messages" root (AI chunk or tool message).
       * This is shared by normal messages flow and by the buffered pre-anchor replay.
       */
      const consumeMessagesRoot = (rootObj, tupleMeta = null) => {
        if (!rootObj) return

        /** AI 片段里带 tool_calls 时尽早展示「正在调用 xxx」（否则只有 tool 节点到达时才有 UI） */
        const emitAiToolCallsIfAny = (aiPart) => {
          if (!streamAnchorOk || !allowMessagesTupleToolCalls) return
          if (!aiPart || typeof aiPart !== 'object') return
          const calls = aiPart.tool_calls || aiPart.toolCalls
          if (!Array.isArray(calls) || !calls.length) return
          for (const tc of calls) {
            if (!streamToolCallReadyForUi(tc)) continue
            const id = tc.id || tc.tool_call_id
            if (!id && !tc.name && !(tc.function && tc.function.name)) continue
            const idKey = id != null && id !== '' ? String(id) : `anon:${tc.name || ''}`
            const prevAcc = tupleToolCallAccumById.get(idKey)
            const merged = mergeMessagesTupleToolCallAccum(prevAcc, tc)
            tupleToolCallAccumById.set(idKey, merged)
            const emitTc = merged
            const emitId = emitTc.id || emitTc.tool_call_id || id
            const sig = (() => {
              try {
                return JSON.stringify(emitTc)
              } catch {
                return String(idKey)
              }
            })()
            if (lastTupleToolCallEmitSig.get(idKey) === sig) continue
            lastTupleToolCallEmitSig.set(idKey, sig)
            evfWsToolStreamDebug('messages-tuple-ai-tool', { t: evfBriefEmittedToolCallsForDebug([emitTc]) })
            this._emitEvent('chat', {
              sessionKey: key,
              runId,
              state: 'tool',
              data: { type: 'tool_call', tool_calls: [emitTc] },
              toolCallId: emitId,
              name: emitTc.name || (emitTc.function && emitTc.function.name) || '工具',
            })
            const emitTcName = emitTc.name || (emitTc.function && emitTc.function.name)
            if (emitTcName === 'ask_clarification') {
              const preview = resolveClarificationPreview({
                tools: [{ name: 'ask_clarification', input: readAskClarificationInput(emitTc), id: emitId }],
              })
              if (preview) {
                emitThreadStateClarify(this, key, runId, {
                  toolCallId: emitId,
                  preview: clarifyPreviewForEmit(preview),
                })
              }
            }
            _logStreamEmit(
              'tool',
              key,
              runId,
              { role: 'assistant', content: [{ type: 'text', text: '' }] },
              { toolCallId: emitId, toolName: emitTc.name || (emitTc.function && emitTc.function.name) || '工具' },
            )
          }
        }

        const emitAiReasoningIfAny = (aiPart) => {
          if (!aiPart || typeof aiPart !== 'object') return
          const r = extractReasoningPreview(aiPart)
          if (r) emitThreadStateReasoning(this, key, runId, r)
        }

        const emitToolFromObj = (t, tupleToolId) => {
          if (!allowMessagesTupleToolCalls) return
          if (!t || typeof t !== 'object') return
          this._emitEvent('chat', {
            sessionKey: key,
            runId,
            state: 'tool',
            data: t,
            toolCallId: t.tool_call_id ?? tupleToolId,
            name: t.name || t.tool_name || 'tool',
          })
          const tn = t.name || t.tool_name
          if (tn === 'ask_clarification') {
            const idKey =
              t.tool_call_id != null && t.tool_call_id !== '' ? String(t.tool_call_id) : ''
            const acc = idKey ? tupleToolCallAccumById.get(idKey) : null
            const input = acc ? readAskClarificationInput(acc) : null
            const preview = resolveClarificationPreview({
              tools: [
                {
                  name: 'ask_clarification',
                  input,
                  output: t.content,
                  content: t.content,
                  id: t.tool_call_id,
                },
              ],
            })
            if (preview) {
              emitThreadStateClarify(this, key, runId, {
                toolCallId: t.tool_call_id,
                preview: clarifyPreviewForEmit(preview),
              })
            }
          }
        }

        const emitAssistantChunkIfNew = (piece) => {
          if (piece == null || piece === '') return
          const pieceUse = stripWsPriorTurnPollutants(piece, prevTurnStripBundle)
          if (pieceUse === '') return
          streamTextFromMessages = true
          const next = accumulateStreamAssistantText(finalText, pieceUse)
          if (next === finalText) return
          finalText = next
          allowMessagesTupleToolCalls = true
          if (!firstPageTokenReported) {
            firstPageTokenReported = true
            void reportClientFirstTokenTiming({
              trace_id: traceId,
              thread_id: threadId,
              path: `/api/langgraph/threads/${threadId}/runs/stream`,
              user_input_ts_ms: userInputTsMs,
              page_first_token_ts_ms: nowTs(),
            })
          }
          emitChatAssistantTextPiece(this, key, runId, pieceUse)
          streamUiEmittedText = accumulateStreamAssistantText(streamUiEmittedText, pieceUse)
        }

        const t = rootObj && typeof rootObj === 'object' ? rootObj.type : null
        if (isLangGraphStreamAiPart(rootObj)) {
          runUsage.recordAiPart(rootObj)
          emitChatUsageIfChanged(this, key, runId, evfLane)
          // 外部 CLI / Claude Code 直连：正文只走 custom ``trae_stream_delta``；messages-tuple 里的整段 AIMessage 会与外部流叠成两段相同正文。
          if (useClaudeCodeChat) {
            emitAiToolCallsIfAny(rootObj)
            return
          }
          if (isNestedToolNodeMessagesStream(tupleMeta)) {
            emitAiToolCallsIfAny(rootObj)
            return
          }
          const piece = textFromLangGraphStreamPart(rootObj)
          emitAiReasoningIfAny(rootObj)
          if (streamAnchorOk && tupleAiToolOnlyShouldKickAllow(rootObj, prevTurnAssistantStripPrefix)) {
            allowMessagesTupleToolCalls = true
          }
          if (streamAnchorOk && piece) emitAssistantChunkIfNew(piece)
          emitAiToolCallsIfAny(rootObj)
          return
        }
        if (t === 'tool' || t === 'ToolMessage' || rootObj.role === 'tool') {
          if (!streamAnchorOk) return
          emitToolFromObj(rootObj, rootObj.tool_call_id)
          allowMessagesTupleToolCalls = true
        }
      }

      const dispatchParsedStreamEvent = (eventName, data, dataRaw = '') => {
          if (dataRaw === '[DONE]' || data === '[DONE]') {
            if (evfLane.openAiStreamMode) {
              dispatchOpenAiWireSseFrame(this, key, runId, eventName, '[DONE]', null, evfLane)
              finalText = evfLane.finalText
              firstPageTokenReported = evfLane.firstPageTokenReported
            }
            return
          }

          if (data == null) return
          if (eventName) _logStreamRecv(eventName, key, runId, data)

          if (evfLane.openAiStreamMode) {
            if (
              dispatchOpenAiWireSseFrame(this, key, runId, eventName, dataRaw || '', data, evfLane, {
                onRunEnd: () => {},
              })
            ) {
              finalText = evfLane.finalText
              firstPageTokenReported = evfLane.firstPageTokenReported
              return
            }
            /* dispatchOpenAiWireSseFrame 入口已记 sse-recv，勿再记 openai-unhandled 重复行 */
          }

          if (evfLane.aguiStreamMode) {
            if (eventName === 'ag-ui' || isAgUiWireEvent(data)) {
              dispatchAgUiWireFrame(this, key, runId, data, evfLane)
              finalText = evfLane.finalText
              firstPageTokenReported = evfLane.firstPageTokenReported
              return
            }
          }

          if (eventName === 'evf') {
            logStreamCompareSseRecv({
              sessionKey: key,
              runId,
              eventName: 'evf',
              data: data && typeof data === 'object' ? data : null,
              wire: 'evf',
            })
            try {
              dispatchEvfUiStreamEvent(this, key, runId, data, evfLane)
            } catch (evfErr) {
               
              console.warn('[evoflow] evf ui stream event failed', data?.type, evfErr)
            }
            if (data?.type === '_debug_upstream' && data?.upstream_event_counts) {
              evfLane.upstreamEventCounts = data.upstream_event_counts
            }
            finalText = evfLane.finalText
            firstPageTokenReported = evfLane.firstPageTokenReported
            return
          }

          if (eventName === 'error') {
            const { code, message } = parseEvfStreamError(
              typeof data === 'object' && data ? data : { message: String(data || 'stream error') },
            )
            if (isUserInterruptStreamError(code, message) || _userStopSessionKeys.has(key)) {
              emitStreamUserInterruptAbort(this, key, runId, evfLane)
              return
            }
            evfLane.lastError = message
            this._emitEvent('chat', {
              sessionKey: key,
              runId,
              state: 'error',
              errorMessage: message,
            })
            _logStreamEmit('error', key, runId, {
              role: 'system',
              content: [{ type: 'text', text: message.slice(0, 500) }],
            })
            return
          }

          if (eventName === 'values') {
            if (uiStreamMode) return
            if (!data || typeof data !== 'object') return
            const rawRoot = data.values && typeof data.values === 'object' ? data.values : data
            const { messages } = normalizeStreamValues(data)
            if (Array.isArray(messages) && messages.length) {
              lastStreamDisplayMessages = messages
            }
            const lastMsg = messages.length ? messages[messages.length - 1] : null
            const turnSlice = sliceMessagesForCurrentTurn(messages)
            const humanIdx = turnSlice.humanIdx
            const anchorOk = lastHumanMatchesRunInput(messages, message || '')
            if (anchorOk) {
              streamAnchorOk = true
              messagesStreamAnchored = true
              prevTurnAssistantStripPrefix = pickRichestAssistantStripPrefix(
                prevTurnAssistantStripPrefix,
                turnSlice.prevAssistantPrefix,
              )
              prevTurnStripBundle = {
                ...prevTurnStripBundle,
                body: pickRichestAssistantStripPrefix(
                  prevTurnStripBundle.body,
                  prevTurnAssistantStripPrefix,
                ),
              }
              // If we already received messages chunks before anchoring, replay them now.
              if (bufferedUnanchoredMessagesRoots.length > 0) {
                for (const r of bufferedUnanchoredMessagesRoots.splice(0, bufferedUnanchoredMessagesRoots.length)) {
                  try {
                    // Re-enter the same messages processing path by simulating root consumption.
                    // (No need to emit stream-recv here; only UI output matters.)
                    const replayRoot = r && typeof r === 'object' && 'root' in r ? r.root : r
                    const replayMeta = r && typeof r === 'object' && 'meta' in r ? r.meta : null
                    consumeMessagesRoot(replayRoot, replayMeta)
                  } catch {}
                }
              }
            }
            if (anchorOk) {
              runUsage.absorbMessagesAfterHuman(messages, humanIdx)
              emitChatUsageIfChanged(this, key, runId, evfLane)
              allowMessagesTupleToolCalls = true
              if (humanIdx >= 0 && Array.isArray(messages)) {
                for (let i = humanIdx + 1; i < messages.length; i++) {
                  const m = messages[i]
                  if (!isToolMessage(m)) continue
                  const tcId = String(m.tool_call_id ?? m.toolCallId ?? '').trim()
                  if (!tcId || emittedToolResultById.has(tcId)) continue
                  emittedToolResultById.add(tcId)
                  const tn = m.name || m.tool_name || 'tool'
                  evfWsToolStreamDebug('values-tool-result', {
                    id: tcId.slice(-10),
                    name: tn,
                    hasContent: m.content != null && String(m.content).length > 0,
                  })
                  this._emitEvent('chat', {
                    sessionKey: key,
                    runId,
                    state: 'tool',
                    data: m,
                    toolCallId: tcId,
                    name: tn,
                  })
                }
              }
            }
            /* 只在「末尾是 assistant」时从 values 抽正文（与原先一致：末尾是 tool 时改走 messages-tuple）。
               且必须：最后一条 human 文本与本轮输入严格一致，且只取该 human 之后的 assistant，
               避免新用户句尚未入队时把上一轮 AI 全文 merge 进本轮。 */
            /**
             * 仅用 hasGraphProgress 仍会放行 [user_new, hint…, 上一轮 assistant+tools]：hint 被当成「已推进」，整段旧正文与旧工具灌进本轮。
             * 与工具一致：必须等 messages-tuple 已推过本轮可见正文后，才信任 values 里的 assistant 快照（正文+tool_calls）。
             * 逃逸：localStorage evoflow-values-before-tuple=1（仅调试）。
             */
            const valuesBeforeTupleEscape =
              typeof localStorage !== 'undefined' &&
              localStorage.getItem('evoflow-values-before-tuple') === '1'
            // 外部 CLI / Claude Code 直连：正文只应来自 custom ``trae_stream_delta``；values 里整段 AIMessage 与 messages-tuple 会重复灌入 finalText/UI。
            const canMergeValuesAssistantSnapshot =
              !useClaudeCodeChat &&
              anchorOk &&
              lastMsg &&
              isAssistantMessage(lastMsg) &&
              (streamTextFromMessages ||
                (valuesBeforeTupleEscape &&
                  hasGraphProgressBetweenUserAndLastSubstantive(messages, humanIdx)))

            let lastAi = null
            if (canMergeValuesAssistantSnapshot) {
              lastAi = findLastAssistantAfterIndex(messages, humanIdx)
            }
            // 仅在本轮 user 已锚定到 checkpoint 后再更新，否则 humanIdx 仍指上一轮 user，
            // anyLastAi 会变成上一轮 assistant，最终 final 会误用 lastAssistantTextFromValues 复读旧正文。
            if (anchorOk && !useClaudeCodeChat && turnSlice.mergedTurnText) {
              lastAssistantTextFromValues = turnSlice.mergedTurnText
            }
            let text = lastAi ? extractAssistantText(lastAi) : ''
            if (!text && turnSlice.assistantText) text = turnSlice.assistantText
            if (text) {
              text = stripWsPriorTurnPollutants(text, prevTurnStripBundle)
            }
            const prevFinal = finalText
            // 简化调试日志
            let textChanged = false
            if (text && canMergeValuesAssistantSnapshot) {
              const next = accumulateStreamAssistantText(finalText, text)
              if (next !== finalText) {
                finalText = next
                textChanged = true
                // [ws-debug][values-text] removed — kept wsDebugValuesEnabled() guard for future use
                if (wsDebugValuesEnabled()) {
                  // debug log removed
                }
              }
            }
            const allowValuesToolCallsFromSnapshot =
              EMIT_TOOL_EVENTS_FROM_VALUES_SNAPSHOT && canMergeValuesAssistantSnapshot
            const callsRaw = allowValuesToolCallsFromSnapshot
              ? collectToolCallsMergedFromValuesRoot(rawRoot) || collectToolCallsForTurnAfterLastUser(messages)
              : null
            const calls = Array.isArray(callsRaw) ? callsRaw.filter(streamToolCallReadyForUi) : null
            const hasToolCalls = Array.isArray(calls) && calls.length > 0
            const sig = hasToolCalls ? JSON.stringify(calls) : ''
            let toolCallsChanged = false
            if (allowValuesToolCallsFromSnapshot && EMIT_TOOL_EVENTS_FROM_VALUES_SNAPSHOT) {
              toolCallsChanged = sig !== lastValuesToolCallsSig
              if (toolCallsChanged) {
                lastValuesToolCallsSig = sig
                evfWsToolStreamDebug('stream-values-tool', {
                  n: calls?.length ?? 0,
                  t: evfBriefEmittedToolCallsForDebug(calls || []),
                })
                // [ws-debug][values-tool-calls] removed — kept wsDebugValuesEnabled() guard for future use
                if (wsDebugValuesEnabled()) {
                  // debug log removed
                }
              }
            }
            /*
             * messages-tuple 常先发无参 stub；完整 args 往往在 values 的 assistant.tool_calls 里。
             * 原 values 工具事件依赖 canMergeValuesAssistantSnapshot（要等正文流或末尾仍是 assistant），
             * 「只有工具、无正文」或末尾已是 ToolMessage 时会永远补不齐。
             * 这里只对本轮 tuple 已登记过的 tool_call_id 做合并，避免把上一轮快照误灌进本轮。
             */
            if (
              anchorOk &&
              allowMessagesTupleToolCalls &&
              EMIT_TOOL_EVENTS_FROM_VALUES_SNAPSHOT &&
              tupleToolCallAccumById.size > 0
            ) {
              const callsForEnrich =
                collectToolCallsMergedFromValuesRoot(rawRoot) || collectToolCallsForTurnAfterLastUser(messages)
              if (Array.isArray(callsForEnrich)) {
                for (const c of callsForEnrich) {
                  if (!c || typeof c !== 'object') continue
                  if (!streamToolCallReadyForUi(c)) continue
                  const cid = c.id || c.tool_call_id
                  if (cid == null || cid === '') continue
                  const idKey = String(cid)
                  if (!tupleToolCallAccumById.has(idKey)) continue
                  const prevAcc = tupleToolCallAccumById.get(idKey)
                  const merged = mergeMessagesTupleToolCallAccum(prevAcc, c)
                  tupleToolCallAccumById.set(idKey, merged)
                  const enrichSig = (() => {
                    try {
                      return JSON.stringify(merged)
                    } catch {
                      return idKey
                    }
                  })()
                  if (lastTupleToolCallEmitSig.get(idKey) === enrichSig) continue
                  lastTupleToolCallEmitSig.set(idKey, enrichSig)
                  evfWsToolStreamDebug('values-enrich-tool', { t: evfBriefEmittedToolCallsForDebug([merged]) })
                  const emitId = merged.id || merged.tool_call_id || cid
                  this._emitEvent('chat', {
                    sessionKey: key,
                    runId,
                    state: 'tool',
                    data: { type: 'tool_call', tool_calls: [merged] },
                    toolCallId: emitId,
                    name: merged.name || (merged.function && merged.function.name) || '工具',
                  })
                  _logStreamEmit(
                    'tool',
                    key,
                    runId,
                    { role: 'assistant', content: [{ type: 'text', text: '' }] },
                    {
                      toolCallId: emitId,
                      toolName: merged.name || (merged.function && merged.function.name) || '工具',
                    },
                  )
                }
              }
            }
            /* values 快照常带完整 tool_calls+args（LangGraph 用 args 而非 function.arguments） */
            /* values 正文：始终按增量 piece 下发（含 messages-tuple 已流式时 values 仍可能补 post_tools 最终回复） */
            if (textChanged || toolCallsChanged) {
              if (textChanged) {
                if (!firstPageTokenReported) {
                  firstPageTokenReported = true
                  void reportClientFirstTokenTiming({
                    trace_id: traceId,
                    thread_id: threadId,
                    path: `/api/langgraph/threads/${threadId}/runs/stream`,
                    user_input_ts_ms: userInputTsMs,
                    page_first_token_ts_ms: nowTs(),
                  })
                }
                streamUiEmittedText = emitStreamUiTextDelta(
                  this,
                  key,
                  runId,
                  finalText,
                  streamUiEmittedText,
                )
              }
              if (toolCallsChanged) {
                this._emitEvent('chat', {
                  sessionKey: key,
                  runId,
                  state: 'tool',
                  data: { type: 'tool_call', tool_calls: calls || [] },
                })
                _logStreamEmit(
                  'tool',
                  key,
                  runId,
                  { role: 'assistant', content: [{ type: 'text', text: '' }] },
                  { toolCalls: Array.isArray(calls) ? calls.length : 0 },
                )
              }
            }
            emitThreadStateFull(this, key, runId, data, { activityAnchorOk: anchorOk })
          } else if (eventName === 'messages' || eventName === 'messages-tuple') {
            if (uiStreamMode) return
            const tupleMeta = unwrapMessagesTupleStreamMeta(data)
            const root = unwrapMessagesTupleRoot(data)
            if (!messagesStreamAnchored) {
              // Server may already have anchored (streamAnchorOk from values); skip dual hold.
              if (streamAnchorOk) {
                messagesStreamAnchored = true
                if (bufferedUnanchoredMessagesRoots.length > 0) {
                  const replay = bufferedUnanchoredMessagesRoots.splice(
                    0,
                    bufferedUnanchoredMessagesRoots.length,
                  )
                  for (const r of replay) {
                    const replayRoot = r && typeof r === 'object' && 'root' in r ? r.root : r
                    const replayMeta = r && typeof r === 'object' && 'meta' in r ? r.meta : null
                    consumeMessagesRoot(replayRoot, replayMeta)
                  }
                }
                consumeMessagesRoot(root, tupleMeta)
                return
              }
              // Buffer until values 锚定；勿在未 anchorOk 时重放 tool/旧轮 tool_calls。
              bufferedUnanchoredMessagesRoots.push({ root, meta: tupleMeta })
              unanchoredMessagesEventCount += 1
              if (unanchoredMessagesEventCount >= 2) {
                messagesStreamAnchored = true
                const replay = bufferedUnanchoredMessagesRoots.splice(
                  0,
                  bufferedUnanchoredMessagesRoots.length,
                )
                for (const r of replay) {
                  if (!streamAnchorOk) continue
                  const replayRoot = r && typeof r === 'object' && 'root' in r ? r.root : r
                  const replayMeta = r && typeof r === 'object' && 'meta' in r ? r.meta : null
                  consumeMessagesRoot(replayRoot, replayMeta)
                }
              }
              return
            }

            consumeMessagesRoot(root, tupleMeta)
          } else if (eventName === 'end') {
            if (uiStreamMode) return
            runUsage.absorbEndEvent(data)
          } else if (eventName === 'custom') {
            if (uiStreamMode && !evfLane?._legacyCustomReplay) return
            const chunk = normalizeCustomTaskPayload(data)
            if (!chunk || typeof chunk !== 'object') return
            const t = chunk.type
            if (t === 'trae_stream_delta') {
              const deltaType = String(chunk.delta_type || 'delta')
              const piece = String(chunk.text || '')
              if (piece) {
                if (!streamTextFromMessages) streamTextFromMessages = true
                let emitPiece = piece
                const prev = finalText || ''
                if (deltaType === 'replace') {
                  if (!prev) {
                    finalText = piece
                    emitPiece = piece
                  } else if (piece.startsWith(prev)) {
                    emitPiece = piece.slice(prev.length)
                    finalText = piece
                  } else if (prev.startsWith(piece)) {
                    return
                  } else if (isStreamAssistantLineRewrite(prev, piece)) {
                    finalText = piece
                    emitPiece = piece
                  } else {
                    finalText = piece
                    emitPiece = piece
                  }
                } else {
                  finalText = prev + piece
                }
                if (!emitPiece) return
                if (!firstPageTokenReported) {
                  firstPageTokenReported = true
                  void reportClientFirstTokenTiming({
                    trace_id: traceId,
                    thread_id: threadId,
                    path: `/api/langgraph/threads/${threadId}/runs/stream`,
                    user_input_ts_ms: userInputTsMs,
                    page_first_token_ts_ms: nowTs(),
                  })
                }
                emitChatAssistantTextPiece(this, key, runId, emitPiece)
                streamUiEmittedText = accumulateStreamAssistantText(streamUiEmittedText, emitPiece)
              }
              return
            }
            if (t === 'trae_stream_error') {
              this._emitEvent('chat', {
                sessionKey: key,
                runId,
                state: 'error',
                errorMessage: String(chunk.error || 'External CLI stream error'),
              })
              _logStreamEmit('error', key, runId, { role: 'system', content: [{ type: 'text', text: String(chunk.error || 'External CLI stream error') }] })
              return
            }
            if (t === 'trae_stream_done') {
              return
            }
            if (t === 'context_compaction_start') {
              this._emitEvent('thread_state', {
                sessionKey: key,
                runId,
                partial: true,
                activityKind: 'compacting',
                activityDetail: '正在压缩上下文…',
              })
              return
            }
            if (t === 'context_compaction_end') {
              return
            }
            if (t === 'pending_inject_consumed') {
              // runtime ItemCompleted(UserMessage) ack for mid-turn steers
              emitPendingInjectConsumedEvent(this, key, runId, chunk)
              return
            }
            if (t === 'context_usage') {
              emitContextUsageEvent(this, key, runId, chunk)
              return
            }
            if (t === 'prefetch_tool_calls_batch') {
              const rawCalls = Array.isArray(chunk.calls) ? chunk.calls : []
              const emitTcs = []
              for (const row of rawCalls) {
                if (!row || typeof row !== 'object') continue
                const tcId = String(row.tool_call_id || '').trim()
                const filePath = String(row.path || '').trim()
                if (!tcId || !filePath) continue
                const rowArgs = row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? row.args : {}
                const invSrc = String(row.invocation_source || rowArgs.invocation_source || 'prefetch').trim() || 'prefetch'
                const toolName = String(row.tool_name || 'read_file').trim() || 'read_file'
                const lintPaths = toolName === 'read_lints' ? filePath : undefined
                const parentWorkerId = String(row.parent_tool_call_id || rowArgs.parent_worker_tool_call_id || '').trim()
                emitTcs.push({
                  id: tcId,
                  tool_call_id: tcId,
                  name: toolName,
                  type: 'tool_call',
                  args: {
                    path: filePath,
                    ...(lintPaths != null ? { paths: lintPaths } : {}),
                    ...rowArgs,
                    invocation_source: invSrc,
                    ...(parentWorkerId ? { parent_worker_tool_call_id: parentWorkerId } : {}),
                  },
                })
              }
              if (!emitTcs.length) return
              this._emitEvent('chat', {
                sessionKey: key,
                runId,
                state: 'tool',
                data: { type: 'tool_call', tool_calls: emitTcs },
                toolCallId: emitTcs[0].tool_call_id,
                name: emitTcs[0]?.name || 'read_file',
              })
              _logStreamEmit(
                'tool',
                key,
                runId,
                { role: 'assistant', content: [{ type: 'text', text: '' }] },
                { toolCalls: emitTcs.length, prefetch: true },
              )
              return
            }
            if (t === 'prefetch_tool_call') {
              const tcId = String(chunk.tool_call_id || '').trim()
              const filePath = String(chunk.path || '').trim()
              if (!tcId || !filePath) return
              const emitTc = {
                id: tcId,
                tool_call_id: tcId,
                name: 'read_file',
                type: 'tool_call',
                args: { path: filePath, invocation_source: 'prefetch' },
              }
              this._emitEvent('chat', {
                sessionKey: key,
                runId,
                state: 'tool',
                data: { type: 'tool_call', tool_calls: [emitTc] },
                toolCallId: tcId,
                name: 'read_file',
              })
              _logStreamEmit(
                'tool',
                key,
                runId,
                { role: 'assistant', content: [{ type: 'text', text: '' }] },
                { toolCallId: tcId, toolName: 'read_file', prefetch: true },
              )
              return
            }
            if (t === 'prefetch_tool_result') {
              const mapped = prefetchToolResultChatPayload(chunk)
              if (!mapped) return
              this._emitEvent('chat', {
                sessionKey: key,
                runId,
                state: 'tool',
                data: mapped.data,
                toolCallId: mapped.tcId,
                name: mapped.toolName,
              })
              return
            }
            if (t === 'worker_file_completed') {
              emitWorkerFileCompletedChat(this, key, runId, chunk)
              return
            }
            if (t === 'evoflow_session_workspace') {
              const resolved = String(chunk.local_workspace_root || '').trim()
              const pinned = isWorkspaceUserPinned(this.getSessionContext(key))
              if (resolved && !pinned) {
                void this
                  .bindSessionWorkspace(key, resolved, { userPinned: false })
                  .then(() => {
                    if (chunk.use_virtual_paths === true) {
                      return this.updateSessionContext(key, { use_virtual_paths: true })
                    }
                    return undefined
                  })
                  .then(() => {
                    try {
                      window.dispatchEvent(
                        new CustomEvent('evopanel:session-workspace-updated', {
                          detail: { sessionKey: key, local_workspace_root: resolved },
                        }),
                      )
                    } catch (_) {}
                  })
                  .catch(() => {})
              }
              return
            }
            if (
              t === 'terminal_start' ||
              t === 'terminal_stdout' ||
              t === 'terminal_stderr' ||
              t === 'terminal_exit'
            ) {
              this._emitEvent('chat', {
                sessionKey: key,
                runId,
                state: 'terminal',
                terminalEvent: chunk,
              })
              return
            }
            if (t === 'agent_activity') {
              emitAgentActivityChat(this, key, runId, {
                kind: chunk.kind,
                detail: chunk.detail,
                toolName: chunk.tool_name,
                toolCalls: Array.isArray(chunk.tool_calls) ? chunk.tool_calls : undefined,
              })
              return
            }
            if (
              t === 'task_started' ||
              t === 'task_running' ||
              t === 'task_completed' ||
              t === 'task_failed' ||
              t === 'task_timed_out'
            ) {
              const subtaskEvent = normalizeSubagentStreamEvent(chunk)
              subtaskStreamDebug('langgraph_custom_recv', {
                sessionKey: key,
                runId,
                type: subtaskEvent.type,
                mapKey: subtaskEvent.task_id,
                collab_subtask_id: subtaskEvent.collab_subtask_id ?? subtaskEvent.collabSubtaskId,
              })
              this._collabChatRunBySession.set(key, String(runId))
              this._emitEvent('chat', {
                sessionKey: key,
                runId,
                state: 'subtask',
                subtaskEvent,
              })
              _logStreamEmit('subtask', key, runId, { role: 'system', content: [{ type: 'text', text: '' }] }, { subtaskType: String(subtaskEvent.type || '') })
            }
          }
      }

      const dispatchSseFrame = (frameText) => {
        if (frameText && String(frameText).trim()) sseFrameCount += 1
        const lines = String(frameText || '').split('\n')
        let dataRaw = ''
        let eventName = ''
        for (const line of lines) {
          const l = line.replace(/\r$/, '')
          if (l.startsWith('event:')) eventName = l.slice(6).trim()
          if (l.startsWith('data:')) dataRaw = appendSseDataLine(dataRaw, l)
        }
        if (!dataRaw) return
        if (dataRaw === '[DONE]') {
          dispatchParsedStreamEvent(eventName, '[DONE]', '[DONE]')
          return
        }
        const data = safeParseJSON(dataRaw, null)
        if (!data) return
        dispatchParsedStreamEvent(eventName, data, dataRaw)
      }

      evfLane.dispatchCustomViaLegacy = (chunk) => {
        evfLane._legacyCustomReplay = true
        try {
          dispatchParsedStreamEvent('custom', chunk, JSON.stringify(chunk))
        } finally {
          evfLane._legacyCustomReplay = false
        }
      }

      const sseQueue = createSseFrameQueue(dispatchSseFrame, { maxPerSlice: 16 })

      let runEndTailStartedAt = null
      if (useStructuredPipe) {
        structuredDispatch = (eventName, data) => {
          streamLastEventTs = Date.now()
          sseFrameCount += 1
          if (streamSilentWarned) streamSilentWarned = false
          try {
            dispatchParsedStreamEvent(eventName, data, typeof data === 'string' ? data : '')
          } catch (err) {
            console.warn('[evoflow] structured stream event failed', eventName, err)
          }
          if (evfLane?.evfRunEndSeen && evfLane?.finalEmitted) {
            runEndTailStartedAt = runEndTailStartedAt ?? Date.now()
          }
        }
        for (const [en, d] of structuredEventBuf.splice(0, structuredEventBuf.length)) {
          structuredDispatch(en, d)
        }
        try {
          await Promise.race([
            resp.done,
            new Promise((_, reject) => {
              const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
              if (controller.signal.aborted) onAbort()
              else controller.signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
        } catch (readErr) {
          if (controller.signal.aborted || readErr?.name === 'AbortError') {
            /* user stop / cancel */
          } else {
            throw readErr
          }
        }
      } else {
      while (true) {
        let done = false
        let value
        try {
          ;({ done, value } = await readWithDeadline(reader))
        } catch (readErr) {
          if (isStreamReadTimeoutError(readErr) && !controller.signal.aborted) {
            streamReadTimedOut = true
            try {
              await reader.cancel()
            } catch {
              /* ignore */
            }
            break
          }
          throw readErr
        }
        if (done) break
        streamLastEventTs = Date.now()
        if (streamSilentWarned) {
          streamSilentWarned = false
        }
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = takeCompleteSseFrames(buffer)
        buffer = rest
        for (const frame of frames) {
          sseQueue.push(frame)
        }
        if (evfLane?.evfRunEndSeen && evfLane?.finalEmitted) {
          runEndTailStartedAt = runEndTailStartedAt ?? Date.now()
          if (Date.now() - runEndTailStartedAt >= RUN_END_TAIL_DRAIN_MS) {
            try {
              await reader.cancel()
            } catch {
              /* ignore */
            }
            break
          }
        }
        // Silent stream warning: if no events arrived for STREAM_SILENT_WARN_MS,
        // let the user know the stream is still alive.
        if (!streamSilentWarned && Date.now() - streamLastEventTs > STREAM_SILENT_WARN_MS) {
          streamSilentWarned = true
          this._emitEvent('chat', {
            sessionKey: key,
            runId,
            state: 'stream_health',
            status: 'silent',
            message: '模型仍在分析中，请耐心等待…',
          })
        }
      }
      sseQueue.flush()
      if (buffer.trim()) {
        dispatchSseFrame(buffer.replace(/\r\n/g, '\n'))
      }
      }

      if (streamReadTimedOut && !evfLane?.evfRunEndSeen && !controller.signal.aborted) {
        this._emitEvent('chat', {
          sessionKey: key,
          runId,
          state: 'stream_health',
          status: 'silent',
          message: '流读取超时，请刷新会话后查看进度',
        })
      }

      finalText = evfLane.finalText || finalText
      const turnHumanIdx = findLastNonCollabHumanIndex(lastStreamDisplayMessages)
      const turnMerged =
        turnHumanIdx >= 0
          ? mergeTurnAssistantTextsForDisplay(
              collectAssistantTextsAfterHuman(
                lastStreamDisplayMessages,
                turnHumanIdx,
                prevTurnAssistantStripPrefix,
              ),
            )
          : ''
      let finalTextOut = ''
      if (uiStreamMode) {
        finalTextOut = stripWsPriorTurnPollutants(String(finalText || '').trim(), prevTurnStripBundle)
        if (!finalTextOut) {
          finalTextOut = stripWsPriorTurnPollutants(
            pickRichestAssistantDisplayText(lastAssistantTextFromValues, turnMerged),
            prevTurnStripBundle,
          )
        }
      } else {
        finalTextOut = stripWsPriorTurnPollutants(
          pickRichestAssistantDisplayText(finalText, lastAssistantTextFromValues, turnMerged),
          prevTurnStripBundle,
        )
      }
      const usageTriplet = runUsage.tripletForFinal()
      const finalTextTrim = String(finalTextOut || '').trim()
      const streamHadOutput =
        !!finalTextTrim ||
        !!usageTriplet ||
        (evfLane.deltaCount || 0) > 0 ||
        evfLane.firstPageTokenReported ||
        (evfLane.toolCallAccumById instanceof Map && evfLane.toolCallAccumById.size > 0) ||
        (Array.isArray(evfLane.authoritativeDisplaySegments) &&
          evfLane.authoritativeDisplaySegments.length > 0) ||
        (Array.isArray(evfLane.authoritativeReasoningSegments) &&
          evfLane.authoritativeReasoningSegments.length > 0)
      if (!streamHadOutput) {
        let runErr = String(evfLane.lastError || '').trim()
        if (!runErr && sseBytesReceived === 0) {
          runErr =
            '流式响应为空（未收到任何 SSE 数据）。请确认 LangGraph 已启动，并重启 Gateway 后再试。'
        } else if (!runErr && sseFrameCount === 0 && sseBytesReceived > 0) {
          runErr = '流式响应无法解析（收到字节但无有效 SSE 帧）。'
        } else if (!runErr) {
          // 常见于 send-prep cancel 误杀：只有 RUN_STARTED/FINISHED，无正文
          runErr = '本轮未产生任何回复内容。'
        }
        const diag = {
          runId: String(runId),
          threadId,
          uiStreamMode,
          evfRunEndSeen: !!evfLane.evfRunEndSeen,
          deltaCount: evfLane.deltaCount || 0,
          sseBytesReceived,
          sseFrameCount,
          upstreamEventCounts: evfLane.upstreamEventCounts || null,
          runError: runErr || null,
          emptyRetry: !!opts?.__emptyStreamRetry,
        }
         
        console.warn('[evoflow] chat stream ended with no assistant output', diag)
        if (!opts?.__emptyStreamRetry && !_userStopSessionKeys.has(key)) {
          try {
            cancelPrepAbort.abort()
          } catch {
            /* ignore */
          }
          this._abortByRunId.delete(runId)
          console.warn('[evoflow] empty stream — auto-retry send once', { sessionKey: key, runId })
          return this.chatSend(sessionKey, message, attachments, contextFiles, {
            ...opts,
            __emptyStreamRetry: true,
            skipTranscriptAppend: true,
          })
        }
        this._emitEvent('chat', {
          sessionKey: key,
          runId,
          state: 'error',
          errorMessage: runErr,
        })
        _logStreamEmit('error', key, runId, {
          role: 'system',
          content: [{ type: 'text', text: runErr.slice(0, 500) }],
        })
        return { ok: false, runId, error: runErr }
      }
      if (
        evfLane.userInterrupt ||
        _userStopSessionKeys.has(key) ||
        isUserInterruptStreamError('', evfLane.lastError)
      ) {
        // 用户点停止：正常 aborted。非用户 interrupt 且无正文：视为误杀，自动重试一次。
        const userStop = _userStopSessionKeys.has(key)
        if (
          !userStop &&
          !finalTextTrim &&
          (evfLane.deltaCount || 0) === 0 &&
          !opts?.__emptyStreamRetry
        ) {
          try {
            cancelPrepAbort.abort()
          } catch {
            /* ignore */
          }
          this._abortByRunId.delete(runId)
          console.warn('[evoflow] spurious interrupt with no output — auto-retry send once', {
            sessionKey: key,
            runId,
          })
          return this.chatSend(sessionKey, message, attachments, contextFiles, {
            ...opts,
            __emptyStreamRetry: true,
            skipTranscriptAppend: true,
          })
        }
        emitStreamUserInterruptAbort(this, key, runId, evfLane, { finalText: finalTextTrim })
        return { ok: true, aborted: true, runId }
      }
      if (!evfLane.finalEmitted) {
        const finalRunId = String(evfLane.aguiChatRunId || runId || '').trim() || runId
        const finalPayload = {
          sessionKey: key,
          runId: finalRunId,
          state: 'final',
          durationMs: nowTs() - started,
          streamTimelineAuthoritative: !!uiStreamMode,
          message: { role: 'assistant', content: [{ type: 'text', text: finalTextOut }] },
        }
        if (Array.isArray(evfLane.authoritativeDisplaySegments) && evfLane.authoritativeDisplaySegments.length) {
          finalPayload.displaySegments = evfLane.authoritativeDisplaySegments
        }
        if (Array.isArray(evfLane.authoritativeReasoningSegments) && evfLane.authoritativeReasoningSegments.length) {
          finalPayload.reasoningSegments = evfLane.authoritativeReasoningSegments
        }
        if (typeof evfLane.authoritativeReasoningPreview === 'string' && evfLane.authoritativeReasoningPreview.trim()) {
          finalPayload.reasoningPreview = evfLane.authoritativeReasoningPreview.trim()
        }
        if (usageTriplet) {
          finalPayload.usage = usageWirePayloadFromTriplet(usageTriplet) || undefined
        }
        evfLane.finalEmitted = true
        this._emitEvent('chat', finalPayload)
        _logStreamEmit(
          'final',
          key,
          runId,
          { role: 'assistant', content: [{ type: 'text', text: finalTextOut }] },
          { durationMs: nowTs() - started, usage: usageTriplet || undefined },
        )
        void reportClientStreamEndTiming({
          trace_id: traceId,
          thread_id: threadId,
          user_input_ts_ms: userInputTsMs,
          page_stream_end_ms: nowTs(),
          duration_ms: nowTs() - userInputTsMs,
        })
      }

      if (map[key]) {
        map[key].updatedAt = nowTs()
        saveSessionMap(map, { keys: [key] })
      }
      // Gateway marks run_status idle only after LangGraph confirms the run ended.
      markSessionStreamWireSource(key, null)
      const result = { ok: true, runId }
      return result
    } catch (err) {
      if (controller.signal.aborted) {
        // Backend run-idle callback handles partial AI response persistence
        // from mirror frames — no frontend write needed here.
        if (_userStopSessionKeys.has(key)) {
          _userStopSessionKeys.delete(key)
          if (!_userStopSkipRunIdleKeys.has(key)) {
            void this._markSessionRunIdleBestEffort(key)
          }
          _userStopSkipRunIdleKeys.delete(key)
        }
        this._emitEvent('chat', { sessionKey: key, runId, state: 'aborted' })
        _logStreamEmit('aborted', key, runId, { role: 'system', content: [{ type: 'text', text: 'aborted' }] })
        return { ok: true, aborted: true, runId }
      }
      // Safety net: connect-path recovery missed (e.g. mid-read 404 on other transports).
      if (
        !opts?.__threadMissingRetry &&
        isLangGraphThreadOrAssistantMissing(err)
      ) {
        try {
          const newTid = await withTimeout(
            this._ensureThreadAfterLangGraphMissing(key),
            THREAD_ENSURE_TIMEOUT_MS,
            null,
          ).catch(() => null)
          if (newTid) {
            this._abortByRunId.delete(runId)
            console.warn('[evoflow] thread missing mid-send — recreate + retry once', {
              sessionKey: key,
              threadId: newTid,
            })
            return this.chatSend(sessionKey, message, attachments, contextFiles, {
              ...opts,
              __threadMissingRetry: true,
              skipTranscriptAppend: true,
            })
          }
        } catch (recreateErr) {
          console.warn('[evoflow] thread-missing recreate failed', recreateErr)
        }
      }
      // Emit disconnected health event so the UI shows a connection lost banner.
      this._emitEvent('chat', {
        sessionKey: key,
        runId,
        state: 'stream_health',
        status: 'disconnected',
        message: '流连接已断开，请检查网络或服务状态',
      })
      // Improve error messages for common network error patterns.
      const errMsg = String(err?.message || err || '请求失败')
      // 用统一分类区分 502（服务端不可达）与客户端网络错误，给出不同提示
      const netCode = classifyNetworkError(err, { status: err?.status })
      const friendlyMsg = (() => {
        if (/前端流超时|stream read timeout/i.test(errMsg)) return errMsg
        if (isLangGraphThreadOrAssistantMissing(err)) {
          return '会话线程已失效（服务重启后常见），请再发一条消息重试'
        }
        // 优先用网络错误分类，确保 502 与 Failed to fetch 文案区分
        if (netCode) {
          const netMsg = messageForNetworkErrorCode(netCode)
          if (netMsg) return netMsg
        }
        if (/响应流为空|resp.*body/i.test(errMsg)) return '服务未返回有效响应，请刷新后重试'
        if (/BodyStreamLost|stream.*broken|connection.*reset|BrokenPipe/i.test(errMsg)) return '流连接中断，分析可能仍在后台运行，请稍后查看结果'
        if (/timeout|timed.?out/i.test(errMsg)) return '请求超时，任务可能仍在后台运行，请刷新会话后查看'
        return errMsg
      })()
      const enhanced = new Error(friendlyMsg)
      enhanced.cause = err
      // 附带错误码，供 UI 区分重试策略（502 限制重试 / 客户端网络错误可重试）
      if (netCode) enhanced.errorCode = netCode
      this._emitEvent('chat', {
        sessionKey: key,
        runId,
        state: 'error',
        errorMessage: friendlyMsg,
        errorCode: netCode || undefined,
      })
      _logStreamEmit('error', key, runId, { role: 'system', content: [{ type: 'text', text: friendlyMsg }] })
      // Re-throw with friendly message so the caller (ChatApp) also gets the improved message.
      throw enhanced
    } finally {
      this._abortByRunId.delete(runId)
      const latest = this._latestRunBySession.get(key)
      if (latest != null && String(latest) === String(runId)) {
        this._latestRunBySession.delete(key)
      }
    }
  }

  /**
   * 聊天历史：``GET /api/chat/sessions/{key}/messages``（``evoflow_chat_messages``，与 LangGraph checkpoint 解耦）。
   */
  async chatHistory(sessionKey, limit = 40, opts = {}) {
    const key = sessionKey || MAIN_SESSION_KEY
    const all = !!opts?.all
    const lim = Math.max(1, Number(limit) || 40)
    const beforeSeq = !all && opts?.beforeSeq != null ? Number(opts.beforeSeq) : null
    const flightKey = all
      ? `${key}:all`
      : `${key}:${lim}:${beforeSeq != null && Number.isFinite(beforeSeq) ? beforeSeq : ''}`
    const inflight = _chatHistoryInflight.get(flightKey)
    if (inflight) return inflight

    const map = loadSessionMap()
    const promise = (async () => {
      try {
        const qs = new URLSearchParams()
        if (all) {
          qs.set('all', '1')
        } else {
          qs.set('limit', String(lim))
          if (beforeSeq != null && Number.isFinite(beforeSeq) && beforeSeq > 0) {
            qs.set('before_seq', String(Math.floor(beforeSeq)))
          }
        }
        // 桌面：历史打开走 Rust→Gateway HTTP，不跟列表/其它 API 抢 stdio 管道
        const data = await fetchJson(
          `/api/chat/sessions/${encodeURIComponent(key)}/messages?${qs.toString()}`,
          { preferGatewayHttp: true },
        )
        const messages = Array.isArray(data?.messages) ? data.messages : []
        const count = Number(data?.messageCount) || messages.length
        if (map[key]) {
          map[key].messageCount = count
          _sessionMapCache = map
          _sessionMapHydrated = true
        }
        return {
          messages,
          valuesSnapshot: null,
          hasMore: !!data?.hasMore,
          oldestSeq: data?.oldestSeq != null ? Number(data.oldestSeq) : null,
          messageCount: count,
        }
      } catch {
        return { messages: [], valuesSnapshot: null, hasMore: false, oldestSeq: null, messageCount: 0 }
      }
    })()
    _chatHistoryInflight.set(flightKey, promise)
    try {
      return await promise
    } finally {
      if (_chatHistoryInflight.get(flightKey) === promise) {
        _chatHistoryInflight.delete(flightKey)
      }
    }
  }

  /**
   * Transcript by LangGraph thread_id — same store as main chat (`evoflow_chat_messages`).
   * Subtask nodes use executor thread `{lead}__sub__{subtask_id}`.
   */
  async chatMessagesByThread(threadId, opts = {}) {
    const tid = String(threadId || '').trim()
    if (!tid) return { messages: [], messageCount: 0, sessionKey: '' }
    const all = opts?.all !== false
    const lim = Math.max(1, Number(opts?.limit) || 2000)
    const qs = new URLSearchParams()
    if (all) qs.set('all', '1')
    else qs.set('limit', String(lim))
    try {
      const data = await fetchJson(
        `/api/chat/sessions/by-thread/${encodeURIComponent(tid)}/messages?${qs.toString()}`,
      )
      const messages = Array.isArray(data?.messages) ? data.messages : []
      return {
        messages,
        messageCount: Number(data?.messageCount) || messages.length,
        sessionKey: String(data?.sessionKey || ''),
      }
    } catch {
      return { messages: [], messageCount: 0, sessionKey: '' }
    }
  }

  async chatSuggestions(sessionKey, n = 3, modelName = undefined, recentMessages = undefined) {
    const key = sessionKey || MAIN_SESSION_KEY
    let threadId
    try {
      threadId = await this._ensureThread(key)
    } catch {
      return { suggestions: [] }
    }

    let recent
    if (Array.isArray(recentMessages) && recentMessages.length) {
      recent = recentMessages
        .map(m => ({
          role: m?.role === 'assistant' ? 'assistant' : 'user',
          content: (typeof m?.content === 'string' ? m.content : '').trim(),
        }))
        .filter(x => x.content)
        .slice(-6)
    } else {
      try {
        const data = await fetchJson(
          `/api/chat/sessions/${encodeURIComponent(key)}/messages?limit=12`,
        )
        const all = Array.isArray(data?.messages) ? data.messages : []
        recent = all
          .filter((m) => isHumanMessage(m) || isAssistantMessage(m))
          .filter((m) => !(isHumanMessage(m) && isInjectedCheckpointHuman(m)))
          .map((m) => {
            const role = isHumanMessage(m) ? 'user' : 'assistant'
            const content = (extractAssistantText(m) || '').trim()
            return { role, content }
          })
          .filter((x) => x.content)
          .slice(-6)
      } catch {
        recent = []
      }
    }

    if (!recent.length) return { suggestions: [] }

    const data = await fetchJson(`/api/threads/${encodeURIComponent(threadId)}/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: recent,
        n: Math.max(1, Math.min(5, Number(n) || 3)),
        model_name: modelName,
      }),
    })

    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : []
    return {
      suggestions: suggestions
        .map(s => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean)
        .slice(0, 5),
    }
  }

  /** Rewrite draft user message via ``POST /api/prompt/enhance``. */
  async enhancePrompt(text, modelName = null, recentMessages = undefined, sessionKey = null) {
    const draft = String(text || '').trim()
    if (!draft) return { text: '' }
    let messages
    if (Array.isArray(recentMessages) && recentMessages.length) {
      messages = recentMessages
        .map((m) => ({
          role: m?.role === 'assistant' ? 'assistant' : 'user',
          content: (typeof m?.content === 'string' ? m.content : '').trim(),
        }))
        .filter((x) => x.content)
        .slice(-6)
    }
    if (!messages?.length && sessionKey) {
      const key = String(sessionKey || '').trim() || MAIN_SESSION_KEY
      try {
        const data = await fetchJson(
          `/api/chat/sessions/${encodeURIComponent(key)}/messages?limit=12`,
        )
        const all = Array.isArray(data?.messages) ? data.messages : []
        messages = all
          .filter((m) => isHumanMessage(m) || isAssistantMessage(m))
          .filter((m) => !(isHumanMessage(m) && isInjectedCheckpointHuman(m)))
          .map((m) => {
            const role = isHumanMessage(m) ? 'user' : 'assistant'
            const content = (extractAssistantText(m) || '').trim()
            return { role, content }
          })
          .filter((x) => x.content)
          .slice(-6)
      } catch {
        messages = undefined
      }
    }
    const data = await fetchJson('/api/prompt/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: draft,
        model_name: modelName || undefined,
        ...(messages?.length ? { messages } : {}),
      }),
    })
    const enhanced = typeof data?.text === 'string' ? data.text.trim() : ''
    return { text: enhanced || draft }
  }

  chatAbort(sessionKey, runId, options = {}) {
    const key = sessionKey || MAIN_SESSION_KEY
    const targetRunId = runId || this._latestRunBySession.get(key)
    if (!targetRunId) return Promise.resolve({ ok: true, aborted: false })
    const skipRunIdle = options && options.skipRunIdle === true
    const userInitiated = options && options.userInitiated === true
    if (userInitiated) {
      _userStopSessionKeys.add(key)
      if (skipRunIdle) {
        _userStopSkipRunIdleKeys.add(key)
      } else {
        void this._markSessionRunIdleBestEffort(key)
      }
    }
    const controller = this._abortByRunId.get(targetRunId)
    if (controller) {
      try { controller.abort() } catch {}
      this._abortByRunId.delete(targetRunId)
    } else if (userInitiated) {
      // 无在途 SSE wire 可 drain：勿留下 sticky stop 标记，否则下一轮 send 会被当成 interrupt
      _userStopSessionKeys.delete(key)
      _userStopSkipRunIdleKeys.delete(key)
    }
    this._emitEvent('chat', { sessionKey: key, runId: targetRunId, state: 'aborted' })
    return Promise.resolve({ ok: true, aborted: true, runId: targetRunId })
  }

  /** 刷新续流：仅 abort SSE wire，不触发用户停止语义。 */
  abortStreamWire(sessionKey, runId) {
    const key = sessionKey || MAIN_SESSION_KEY
    const targetRunId = String(runId || this._latestRunBySession.get(key) || '').trim()
    if (!targetRunId) return false
    const controller = this._abortByRunId.get(targetRunId)
    if (controller) {
      try { controller.abort() } catch {}
      this._abortByRunId.delete(targetRunId)
      return true
    }
    return false
  }

  /** 侧栏工作目录汇总：各目录会话总数 */
  async sessionsWorkspaceGroups() {
    const cacheKey = 'workspace-groups'
    if (this._sessionsWorkspaceGroupsInflight && this._sessionsWorkspaceGroupsInflightKey === cacheKey) {
      return this._sessionsWorkspaceGroupsInflight
    }
    if (this._sessionsWorkspaceGroupsAbortController) {
      try { this._sessionsWorkspaceGroupsAbortController.abort() } catch {}
      this._sessionsWorkspaceGroupsAbortController = null
    }
    const controller = new AbortController()
    this._sessionsWorkspaceGroupsAbortController = controller
    this._sessionsWorkspaceGroupsInflightKey = cacheKey
    this._sessionsWorkspaceGroupsInflight = (async () => {
      let groups = []
      let source = 'evoflow_chat_sessions'
      try {
        const data = await fetchJson('/api/chat/sessions/workspace-groups', { signal: controller.signal })
        source = data?.source || source
        groups = Array.isArray(data?.groups) ? data.groups : []
      } catch (e) {
        if (e?.name === 'AbortError') throw e
         
        console.warn('[evoflow] GET /api/chat/sessions/workspace-groups failed', e)
      }
      return { groups, source }
    })().finally(() => {
      if (this._sessionsWorkspaceGroupsAbortController === controller) {
        this._sessionsWorkspaceGroupsAbortController = null
      }
      this._sessionsWorkspaceGroupsInflight = null
      this._sessionsWorkspaceGroupsInflightKey = ''
    })
    return this._sessionsWorkspaceGroupsInflight
  }

  /** 侧栏列表：``GET /api/chat/sessions``（``evoflow_chat_sessions`` 为唯一数据源） */
  async sessionsList(limit = 20, offset = 0, workspaceKey = null) {
    const lim = Math.max(1, Number(limit) || 20)
    const off = Math.max(0, Number(offset) || 0)
    const wk = workspaceKey ? String(workspaceKey).trim() : ''
    const cacheKey = `${lim}:${off}:${wk}`
    // 按 cacheKey 并发：首次进入会 Promise.all 预拉多个工作空间首页。
    // 旧实现只有一个 AbortController，后发请求会 abort 先发的 → 批次全失败，
    // 普通对话 Tab 只剩全局最近里挤掉员工会话后的 1～2 条。
    if (!this._sessionsListInflightByKey) this._sessionsListInflightByKey = new Map()
    if (!this._sessionsListAbortByKey) this._sessionsListAbortByKey = new Map()
    const existing = this._sessionsListInflightByKey.get(cacheKey)
    if (existing) return existing

    const controller = new AbortController()
    this._sessionsListAbortByKey.set(cacheKey, controller)
    const inflight = (async () => {
      let sessions = []
      let source = 'evoflow_chat_sessions'
      try {
        const qs = new URLSearchParams({ limit: String(lim), offset: String(off) })
        if (wk) qs.set('workspace_key', wk)
        const data = await fetchJson(`/api/chat/sessions?${qs.toString()}`, { signal: controller.signal })
        source = data?.source || source
        sessions = Array.isArray(data?.sessions) ? data.sessions : []
        applySessionsListToCache(sessions)
      } catch (e) {
        if (e?.name === 'AbortError') throw e
         
        console.warn('[evoflow] GET /api/chat/sessions failed', e)
      }
      sessions.sort((a, b) => {
        const aPin = a?.isPinned ? 1 : 0
        const bPin = b?.isPinned ? 1 : 0
        if (aPin !== bPin) return bPin - aPin
        if (aPin && bPin) {
          const po = Number(a?.pinOrder ?? 0) - Number(b?.pinOrder ?? 0)
          if (po !== 0) return po
        }
        return (b.updatedAt || 0) - (a.updatedAt || 0)
      })
      return { sessions: sessions.slice(0, lim), source }
    })().finally(() => {
      if (this._sessionsListAbortByKey?.get(cacheKey) === controller) {
        this._sessionsListAbortByKey.delete(cacheKey)
      }
      if (this._sessionsListInflightByKey?.get(cacheKey) === inflight) {
        this._sessionsListInflightByKey.delete(cacheKey)
      }
    })
    this._sessionsListInflightByKey.set(cacheKey, inflight)
    return inflight
  }

  /**
   * 单会话详情：``GET /api/chat/sessions/{key}``（绕过分页/工作区过滤，用于刷新后恢复 model_name 等）。
   * 成功时写入内存 session map。
   */
  async getChatSession(sessionKey) {
    const key = String(sessionKey || '').trim()
    if (!key) return null
    try {
      const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}`)
      if (!data || typeof data !== 'object') return null
      applySessionsListToCache([data])
      return data
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      console.warn('[evoflow] GET /api/chat/sessions/{key} failed', e)
      return null
    }
  }

  /**
   * 搜索会话（标题 + 消息内容），覆盖全部会话，不受分页限制。
   * GET /api/chat/sessions?search=<q> → 后端 search_sessions_for_ui。
   * 返回结构与 sessionsList 一致：{ sessions, source }。
   */
  async sessionsSearch(query, limit = 50) {
    const q = String(query || '').trim()
    if (!q) return { sessions: [], source: 'evoflow_chat_sessions' }
    const lim = Math.max(1, Number(limit) || 50)
    try {
      const qs = new URLSearchParams({ search: q, limit: String(lim) })
      const data = await fetchJson(`/api/chat/sessions?${qs.toString()}`)
      const sessions = Array.isArray(data?.sessions) ? data.sessions : []
      applySessionsListToCache(sessions)
      return { sessions, source: data?.source || 'evoflow_chat_sessions' }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      console.warn('[evoflow] GET /api/chat/sessions?search= failed', e)
      return { sessions: [], source: 'evoflow_chat_sessions' }
    }
  }

  /**
   * 失效 sessionsList inflight 缓存。
   *
   * 置顶/取消置顶/重排等会话变更后，若上一轮 GET /api/chat/sessions 仍在 flight
   * 列表不再对 active 行 reconcile（改走 execution/state 或 startup sweep），
   * 后续 refreshSessions 会复用旧 promise，拿到变更前的数据覆盖乐观更新。
   * 在 _notifySessionsMutated 中调用此方法可确保下一次 sessionsList 发起新请求。
   */
  invalidateSessionsListCache() {
    if (this._sessionsListAbortByKey) {
      for (const controller of this._sessionsListAbortByKey.values()) {
        try { controller.abort() } catch {}
      }
      this._sessionsListAbortByKey.clear()
    }
    if (this._sessionsListInflightByKey) this._sessionsListInflightByKey.clear()
    // 兼容旧字段（若仍有外部引用）
    this._sessionsListAbortController = null
    this._sessionsListInflight = null
    this._sessionsListInflightKey = ''
    if (this._sessionsWorkspaceGroupsAbortController) {
      try { this._sessionsWorkspaceGroupsAbortController.abort() } catch {}
      this._sessionsWorkspaceGroupsAbortController = null
    }
    this._sessionsWorkspaceGroupsInflight = null
    this._sessionsWorkspaceGroupsInflightKey = ''
  }

  /** 新建会话：落库 + 可选 ensure-thread，返回完整会话行 */
  async createChatSession(agentId = 'main', options = {}) {
    const data = await fetchJson('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agentId || 'main',
        title: options.title || '新对话',
        context: options.context && typeof options.context === 'object' ? options.context : undefined,
        ensureThread: options.ensureThread !== false,
        sessionKey: options.sessionKey || null,
      }),
      // 避开聊天流占用时的 app-server stdio 排队，否则「新建对话」会长时间无响应
      preferGatewayHttp: true,
    })
    const sk = String(data?.sessionKey || data?.key || '').trim()
    if (sk) {
      const map = loadSessionMap()
      map[sk] = {
        threadId: data.threadId ? String(data.threadId).trim() : null,
        title: typeof data.title === 'string' ? data.title : '',
        createdAt: Number(data.createdAt) || nowTs(),
        updatedAt: Number(data.updatedAt) || nowTs(),
        messageCount: Number(data.messageCount) || 0,
        context: mergeSessionContextFromApiRow(data),
      }
      _sessionMapCache = map
      _sessionMapHydrated = true
    }
    return data
  }

  async sessionsDelete(key, options = {}) {
    if (!key) throw new Error('session_key required')
    const clearWorkspaceHistory = !!options?.clearWorkspaceHistory
    try {
      await refreshSessionMapFromDb()
    } catch {
      /* use in-memory map */
    }
    const map = loadSessionMap()
    const threadId = String(map[key]?.threadId || '').trim()
    await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' })
    delete map[key]
    if (threadId) {
      for (const [sk, meta] of Object.entries(map)) {
        if (String(meta?.threadId || '').trim() === threadId) delete map[sk]
      }
    }
    if (clearWorkspaceHistory) this._clearWorkspaceHistoryForSession(key)
    addDeleteSessionTombstone(key)
    if (threadId) addDeleteSessionTombstone(`thread:${threadId}`)
    _sessionMapCache = map
    _sessionMapHydrated = true
    return { ok: true }
  }

  async sessionsReset(key) {
    const sessionKey = key || MAIN_SESSION_KEY
    const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(sessionKey)}/reset`, {
      method: 'POST',
    })
    const threadId = String(data?.threadId || '').trim()
    if (!threadId) throw new Error('重置会话失败：未返回 thread_id')
    const map = loadSessionMap()
    const oldContext = map[sessionKey]?.context
    map[sessionKey] = {
      threadId,
      createdAt: map[sessionKey]?.createdAt || nowTs(),
      updatedAt: nowTs(),
      messageCount: 0,
      context: oldContext || { ...buildDefaultSessionContext() },
    }
    saveSessionMap(map, { keys: [sessionKey] })
    return { ok: true, threadId }
  }

  async updateSessionContext(sessionKey, context, opts = {}) {
    const key = String(sessionKey || '').trim()
    if (!key) throw new Error('session_key required')
    migrateLegacyGlobalWorkspaceOnce()
    const map = loadSessionMap()
    if (!map[key]) {
      map[key] = {
        createdAt: nowTs(),
        updatedAt: nowTs(),
        messageCount: 0,
        context: { ...buildDefaultSessionContext() },
      }
    }
    const merged = { ...(map[key].context || {}), ...context }
    for (const k of Object.keys(context || {})) {
      if (context[k] === null) delete merged[k]
    }
    map[key].context = merged
    map[key].updatedAt = nowTs()
    _sessionMapCache = map
    _sessionMapHydrated = true
    if (opts.localOnly) return merged
    await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/context`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
      preferGatewayHttp: true,
    })
    return merged
  }

  isSessionWorkspaceUserPinned(sessionKey) {
    return isWorkspaceUserPinned(this.getSessionContext(sessionKey))
  }

  getSessionContext(sessionKey) {
    migrateLegacyGlobalWorkspaceOnce()
    const key = sessionKey || MAIN_SESSION_KEY
    const map = loadSessionMap()
    return map[key]?.context || { ...buildDefaultSessionContext() }
  }

  /** 同步 scenario 工具结果到会话内存缓存（运行态；持久化由后端 scenario 链路负责） */
  patchSessionActivatedScenarios(sessionKey, scenarios) {
    const key = String(sessionKey || '').trim()
    if (!key) return
    const list = Array.isArray(scenarios)
      ? scenarios.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    // After schema v75 the scenario list is derived from session_mode, so keep
    // session_mode in sync with the new scenario selection for consistency.
    const derivedMode = list.includes('plan') ? 'plan' : list.includes('agent') ? 'agent' : ''
    const map = loadSessionMap()
    const prev = map[key] && typeof map[key] === 'object' ? map[key] : {}
    const prevCtx = prev.context && typeof prev.context === 'object' ? prev.context : {}
    const nextCtx = { ...prevCtx, activated_scenarios: list }
    if (derivedMode) nextCtx.session_mode = derivedMode
    map[key] = {
      ...prev,
      activatedScenarios: list,
      sessionMode: derivedMode || prev.sessionMode || prevCtx.session_mode || null,
      context: nextCtx,
      updatedAt: nowTs(),
    }
    _sessionMapCache = map
    _sessionMapHydrated = true
  }

  /** 壳层启动时拉一次全局工作空间历史，写入内存缓存 */
  async hydrateGlobalWorkspaceHistoryOnce() {
    return loadGlobalWorkspaceHistoryFromDb()
  }

  /**
   * 按会话拉 workspace-history（仅首次或 force）；切换会话勿调用。
   * @param {string} sessionKey
   * @param {{ force?: boolean }} [options]
   */
  async ensureSessionWorkspaceHistory(sessionKey, options = {}) {
    const key = String(sessionKey || '').trim()
    if (!key) return []
    return loadSessionWorkspaceHistoryFromDb(key, { force: !!options.force })
  }

  /** @deprecated 请用 hydrateGlobalWorkspaceHistoryOnce + ensureSessionWorkspaceHistory */
  async hydrateWorkspaceHistory(sessionKey) {
    await loadGlobalWorkspaceHistoryFromDb()
    if (sessionKey) await loadSessionWorkspaceHistoryFromDb(String(sessionKey || '').trim())
  }

  /** 某会话的工作空间历史目录列表（与 sessionKey 绑定；需先 hydrate） */
  getWorkspaceHistory(sessionKey) {
    const key = String(sessionKey || '').trim()
    if (!key) return []
    const cached = _sessionWsHistCache[key]
    if (Array.isArray(cached)) return normalizeHistoryList(cached)
    return []
  }

  /** 全局工作空间历史（跨会话共享） */
  getGlobalWorkspaceHistory() {
    if (_globalWsHistLoaded) return normalizeHistoryList(_globalWsHistCache)
    return normalizeHistoryList(loadGlobalWorkspaceHistory())
  }

  /** 绑定工作空间到会话（历史表 + 当前路径） */
  async bindSessionWorkspace(sessionKey, path, opts = {}) {
    const key = String(sessionKey || '').trim()
    const p = String(path || '').trim()
    if (!key || !p) throw new Error('session_key and path required')
    const userPinned = opts.userPinned !== false
    const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/workspace-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, userPinned }),
    })
    const paths = normalizeHistoryList(data?.paths)
    _sessionWsHistCache[key] = paths
    const current = String(data?.currentPath || p).trim()
    if (current) {
      const map = loadSessionMap()
      if (!map[key]) map[key] = { context: { ...buildDefaultSessionContext() } }
      map[key].context = {
        ...(map[key].context || {}),
        local_workspace_root: current,
        use_virtual_paths: false,
        ...(userPinned ? { workspace_user_pinned: true } : {}),
      }
      map[key].updatedAt = nowTs()
      _sessionMapCache = map
    }
    await loadGlobalWorkspaceHistoryFromDb()
    return { paths, currentPath: current || p }
  }

  /** 注册全局工作空间（侧栏「新建工作空间」，无需已有会话） */
  async registerGlobalWorkspacePath(path) {
    const p = String(path || '').trim()
    if (!p) return []
    await migrateLocalWorkspaceHistoryToDbOnce()
    const next = mergeHistory([p], this.getGlobalWorkspaceHistory(), 60)
    await fetchJson('/api/workspaces/user-history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: next }),
    })
    _globalWsHistCache = next
    _globalWsHistLoaded = true
    return next
  }

  /** 写入某会话的工作空间历史（去重、截断由调用方处理） */
  async setWorkspaceHistory(sessionKey, list) {
    const key = String(sessionKey || '').trim()
    if (!key) return
    const normalized = normalizeHistoryList(list).slice(0, 30)
    await migrateLocalWorkspaceHistoryToDbOnce()
    const data = await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/workspace-history`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: normalized }),
    })
    _sessionWsHistCache[key] = normalizeHistoryList(data?.paths || normalized)
    _sessionWsHistHydratedKeys.add(key)
    const g = this.getGlobalWorkspaceHistory()
    const nextGlobal = mergeHistory(normalized, g, 60)
    await fetchJson('/api/workspaces/user-history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: nextGlobal }),
    })
    _globalWsHistCache = nextGlobal
    _globalWsHistLoaded = true
  }

  /** 从所有会话 + 全局历史中删除某个目录条目 */
  async removeWorkspaceHistoryPath(path) {
    const p = String(path || '').trim()
    if (!p) return
    await migrateLocalWorkspaceHistoryToDbOnce()
    const data = await fetchJson('/api/workspaces/user-history/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    })
    _globalWsHistCache = normalizeHistoryList(data?.paths)
    _globalWsHistLoaded = true
    for (const k of Object.keys(_sessionWsHistCache)) {
      if (!Array.isArray(_sessionWsHistCache[k])) continue
      _sessionWsHistCache[k] = _sessionWsHistCache[k].filter((x) => x !== p)
    }
  }

  async _clearWorkspaceHistoryForSession(sessionKey) {
    const key = String(sessionKey || '').trim()
    if (!key) return
    delete _sessionWsHistCache[key]
    _sessionWsHistHydratedKeys.delete(key)
    try {
      await fetchJson(`/api/chat/sessions/${encodeURIComponent(key)}/workspace-history`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [] }),
      })
    } catch {
      /* ignore */
    }
  }

  async request(method, params = {}) {
    if (method === 'sessions.usage') {
      const map = loadSessionMap()
      const rows = Object.entries(map).map(([key, meta]) => ({
        key,
        sessionKey: key,
        updatedAt: meta.updatedAt || 0,
        messageCount: meta.messageCount || 0,
      }))
      return { sessions: rows }
    }
    throw new Error(`旧 RPC 已移除: ${method}`)
  }

  /** Sync session map after ``PATCH /api/settings/tool-approval/sessions/{key}``. */
  applySessionToolApprovalPolicy(sessionKey, result) {
    const key = String(sessionKey || '').trim()
    if (!key || !result || typeof result !== 'object') return
    const map = loadSessionMap()
    const prev =
      map[key] && typeof map[key] === 'object'
        ? map[key]
        : {
            createdAt: nowTs(),
            updatedAt: nowTs(),
            messageCount: 0,
            context: { ...buildDefaultSessionContext() },
          }
    const ctx = {
      ...(prev.context && typeof prev.context === 'object' ? prev.context : buildDefaultSessionContext()),
    }
    const raw = result.tool_approval_policy
    if (raw != null && String(raw).trim()) {
      ctx.tool_approval_policy = String(raw).trim()
    } else {
      delete ctx.tool_approval_policy
    }
    const eff = String(result.effective_policy || result.tool_approval_policy || '').trim()
    if (eff) {
      ctx.effective_tool_approval_policy = eff
    } else {
      delete ctx.effective_tool_approval_policy
    }
    const presetRaw = result.permission_preset ?? result.effective_permission_preset
    if (presetRaw != null && String(presetRaw).trim()) {
      ctx.permission_preset = String(presetRaw).trim()
    } else {
      delete ctx.permission_preset
    }
    const effPreset = String(result.effective_permission_preset || presetRaw || '').trim()
    if (effPreset) {
      ctx.effective_permission_preset = effPreset
    } else {
      delete ctx.effective_permission_preset
    }
    map[key] = { ...prev, context: ctx, updatedAt: nowTs() }
    _sessionMapCache = map
    _sessionMapHydrated = true
    saveSessionMap(map, { keys: [key] })
  }

  onEvent(callback) {
    this._eventListeners.push(callback)
    return () => { this._eventListeners = this._eventListeners.filter(fn => fn !== callback) }
  }
}

/** 供历史加载/外部同步：从 LangGraph checkpoint values 生成输入区上方线程面板状态 */
export function threadStatePayloadFromValues(sessionKey, values) {
  if (!values || typeof values !== 'object') return null
  const { messages, todos, title } = normalizeStreamValues(values)
  const act = deriveActivityFromMessages(messages)
  return {
    sessionKey,
    runId: null,
    partial: false,
    title,
    todos,
    activityKind: act.kind,
    activityDetail: act.detail,
    toolNames: act.toolNames || [],
    reasoningPreview: act.reasoningPreview,
    clarification: act.clarification,
  }
}

const _g = typeof window !== 'undefined' ? window : globalThis
if (!_g.__evopanelWsClient) _g.__evopanelWsClient = new WsClient()
export const wsClient = _g.__evopanelWsClient
