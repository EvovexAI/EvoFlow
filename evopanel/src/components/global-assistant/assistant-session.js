/**
 * 小V全局助手会话：后端 SQLite chat session + 内存消息镜像
 * session agent = xiaomi；key 持久化在 localStorage
 */
import { api } from '../../lib/tauri-api.js'
import { wsClient } from '../../lib/ws-client.js'
import { patchState, getState } from './assistant-store.js'
import { extractPageContext, collectXiaomiPageSnapshot } from './assistant-context.js'
import { emitPageLiveRefresh } from '../../lib/page-live-refresh.js'
import {
  applyXiaomiAgUiProcessEvent,
  applyXiaomiClassicToolEvent,
} from './xiaomi-stream-tools.js'
import {
  applyAgUiEvent,
  emptyAgUiTurnState,
  projectAgUiToStreamTurnFields,
  timelineWithOpenAgUiAssistantText,
  timelineWithOpenAgUiReasoning,
} from '../../react/lib/agui-turn-reducer.js'
import { normalizeAssistantSegmentTimelineOrder } from '../../lib/chat-normalize.js'

const LS_SESSION = 'evopanel_xiaomi_assistant_session_key'
export const XIAOMI_AGENT = 'xiaomi'
export const XIAOMI_SESSION_TITLE = '小V · 全局助手'

let _unsubEvent = null
let _activeRunId = ''
/** @type {import('../../react/lib/agui-turn-reducer.js').AgUiTurnState | null} */
let _aguiTurn = null
/** 语音唤醒发起的一轮：流式正文同步到 TTS */
let _voiceReplyPending = false
let _voiceSpeechSyncedPlain = ''

/**
 * @param {{ voiceInitiated?: boolean }} [opts]
 */
async function armXiaomiVoiceReply(opts = {}) {
  _voiceReplyPending = true
  _voiceSpeechSyncedPlain = ''
  try {
    const { getVoiceReplyEnabled } = await import('../../lib/panel-settings.js')
    const { shouldArmVoiceReply } = await import('../../lib/voice-reply-mode.js')
    if (!shouldArmVoiceReply(getVoiceReplyEnabled())) {
      _voiceReplyPending = false
      return
    }
    const { resetStreamingSpeechQueue } = await import('../../lib/speech-client.js')
    resetStreamingSpeechQueue()
    const { startVoiceSimpleAck, resetVoiceToolMuteState } = await import(
      '../../lib/voice-reply-speech.js',
    )
    resetVoiceToolMuteState()
    // 确认语仅语音提问；键盘发送直接等正文播报
    if (opts.voiceInitiated) {
      startVoiceSimpleAck(() => {})
    }
  } catch {
    /* ignore */
  }
}

function clearXiaomiVoiceReply() {
  _voiceReplyPending = false
  _voiceSpeechSyncedPlain = ''
}

function syncXiaomiVoiceSpeech(fullText, { final = false } = {}) {
  if (!_voiceReplyPending) return
  const body = String(fullText || '')
  void import('../../lib/voice-reply-speech.js')
    .then(
      ({
        shouldAdvanceVoiceSpeechSync,
        toVoiceSpeechPlain,
        enqueueVoiceStreamSpeech,
        flushVoiceStreamSpeechIfNeeded,
        clipVoiceSpeechForPlayback,
        exitVoiceToolMute,
        isVoiceToolMuteActive,
      }) => {
        if (!_voiceReplyPending) return
        if (isVoiceToolMuteActive()) exitVoiceToolMute()
        if (final) {
          flushVoiceStreamSpeechIfNeeded(body)
          clearXiaomiVoiceReply()
          return
        }
        const speakable = clipVoiceSpeechForPlayback(body)
        if (!shouldAdvanceVoiceSpeechSync(speakable, _voiceSpeechSyncedPlain)) return
        _voiceSpeechSyncedPlain = toVoiceSpeechPlain(speakable)
        enqueueVoiceStreamSpeech(speakable)
      },
    )
    .catch(() => {})
}

function readStoredSessionKey() {
  try {
    return String(localStorage.getItem(LS_SESSION) || '').trim()
  } catch {
    return ''
  }
}

function writeStoredSessionKey(key) {
  try {
    if (key) localStorage.setItem(LS_SESSION, key)
    else localStorage.removeItem(LS_SESSION)
  } catch {
    /* ignore */
  }
}

/**
 * Flatten LangChain / wire content (string | blocks | nested) to plain text.
 * Never String(object) — that yields "[object Object]".
 * @param {unknown} content
 * @returns {string}
 */
export function contentToPlainText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b == null) return ''
        if (typeof b === 'string') return b
        if (typeof b !== 'object') return String(b)
        const t = /** @type {Record<string, unknown>} */ (b)
        if (typeof t.text === 'string') return t.text
        if (typeof t.content === 'string') return t.content
        if (Array.isArray(t.content)) return contentToPlainText(t.content)
        return ''
      })
      .join('')
  }
  if (typeof content === 'object') {
    const o = /** @type {Record<string, unknown>} */ (content)
    if (typeof o.text === 'string') return o.text
    if (typeof o.content === 'string') return o.content
    if (Array.isArray(o.content)) return contentToPlainText(o.content)
    return ''
  }
  return ''
}

/**
 * Extract display text from a history / transcript row.
 * @param {unknown} m
 * @returns {string}
 */
export function msgText(m) {
  if (!m || typeof m !== 'object') return ''
  const row = /** @type {Record<string, unknown>} */ (m)
  const fromContent = contentToPlainText(row.content)
  if (fromContent.trim()) return fromContent
  const cj = row.contentJson ?? row.content_json
  if (cj && typeof cj === 'object') {
    const fromCj = contentToPlainText(/** @type {Record<string, unknown>} */ (cj).content)
    if (fromCj.trim()) return fromCj
  }
  if (typeof row.text === 'string') return row.text
  if (typeof row.message === 'string') return row.message
  if (row.message && typeof row.message === 'object') {
    return contentToPlainText(/** @type {Record<string, unknown>} */ (row.message).content)
  }
  return ''
}

/**
 * Extract text from a ws chat event payload (delta / final / completed).
 * Wire format puts body in `message.content` as [{ type:'text', text }].
 * @param {Record<string, unknown>} p
 * @returns {string}
 */
export function payloadAssistantText(p) {
  if (!p || typeof p !== 'object') return ''
  if (typeof p.content === 'string') return p.content
  if (Array.isArray(p.content)) return contentToPlainText(p.content)
  if (typeof p.text === 'string') return p.text
  if (typeof p.delta === 'string') return p.delta
  const msg = p.message
  if (typeof msg === 'string') return msg
  if (msg && typeof msg === 'object') {
    return contentToPlainText(/** @type {Record<string, unknown>} */ (msg).content)
  }
  return ''
}

function historyToUiMessages(rows) {
  const out = []
  for (const m of Array.isArray(rows) ? rows : []) {
    const role = String(m.role || m.type || '').toLowerCase()
    if (role !== 'user' && role !== 'human' && role !== 'assistant' && role !== 'ai') continue
    const text = stripInjectedPageContext(msgText(m)).trim()
    if (!text) continue
    out.push({
      id: String(m.id || m.message_id || `${role}-${out.length}`),
      role: role === 'user' || role === 'human' ? 'user' : 'assistant',
      text,
      kind: 'text',
      createdAt: m.created_at || m.timestamp || '',
      fromBackend: true,
    })
  }
  return out
}

/** Strip legacy "（系统上下文…）" suffix previously appended into user message body. */
export function stripInjectedPageContext(text) {
  return String(text || '')
    .replace(/\n*\s*（系统上下文，仅供理解指代：[^）]*）\s*$/u, '')
    .replace(/\n*\s*\(系统上下文，仅供理解指代：[^\)]*\)\s*$/u, '')
    .trimEnd()
}

/**
 * Ensure backend session for 小V; load transcript into store.messages
 * @returns {Promise<string>} sessionKey
 */
export async function ensureXiaomiSession() {
  let key = String(getState().sessionKey || readStoredSessionKey() || '').trim()

  if (key) {
    try {
      const row = await api.chatSessionsGet(key)
      const sk = String(row?.sessionKey || row?.key || key).trim()
      if (sk) {
        key = sk
        await api.chatUpdateContext(key, {
          agent_name: XIAOMI_AGENT,
          agent_id: XIAOMI_AGENT,
          use_claude_code_chat: false,
          xiaomi_global_assistant: true,
        }).catch(() => {})
      }
    } catch {
      key = ''
    }
  }

  if (!key) {
    const row = await api.chatSessionsCreate(XIAOMI_AGENT, {
      title: XIAOMI_SESSION_TITLE,
      ensureThread: false,
      context: {
        agent_name: XIAOMI_AGENT,
        agent_id: XIAOMI_AGENT,
        xiaomi_global_assistant: true,
        memory_enabled: true,
      },
    })
    key = String(row?.sessionKey || row?.key || '').trim()
    if (!key) throw new Error('创建小V会话失败')
  }

  writeStoredSessionKey(key)
  patchState({ sessionKey: key }, { persistUi: true })

  const hist = await api.chatHistory(key, 80).catch(() => ({ messages: [] }))
  const messages = historyToUiMessages(hist?.messages || [])
  patchState({ messages })
  return key
}

function markXiaomiRunStarted(runId) {
  _activeRunId = runId
  _aguiTurn = emptyAgUiTurnState(String(runId || ''))
  const messages = [...(getState().messages || [])]
  let last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && (last.pending || last.streaming)) {
    last.runId = runId
    last.pending = true
    last.streaming = true
    if (!last.text || last.text === '小V处理中…') last.text = ''
    if (!Array.isArray(last.tools)) last.tools = []
    if (last.reasoning == null) last.reasoning = ''
    last.segments = []
    last.reasoningPreview = ''
    last.systemActivity = '正在处理'
    last.aguiTurn = _aguiTurn
  } else {
    messages.push({
      id: `asst-${runId || Date.now()}`,
      role: 'assistant',
      text: '',
      kind: 'text',
      runId,
      pending: true,
      streaming: true,
      tools: [],
      reasoning: '',
      segments: [],
      reasoningPreview: '',
      systemActivity: '正在处理',
      aguiTurn: _aguiTurn,
    })
  }
  patchState({ messages: [...messages], streaming: true })
}

/**
 * 把主对话同款 AG-UI 投影写回当前流式气泡（供 MessageRow 复用）。
 */
function syncXiaomiLiveFromAgui() {
  if (!_aguiTurn) return
  const proj = projectAgUiToStreamTurnFields(_aguiTurn)
  const timeline = normalizeAssistantSegmentTimelineOrder(
    timelineWithOpenAgUiReasoning(
      timelineWithOpenAgUiAssistantText(proj.timeline, _aguiTurn),
      _aguiTurn,
    ),
  )
  const messages = [...(getState().messages || [])]
  let last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    last = {
      id: `asst-${_activeRunId || Date.now()}`,
      role: 'assistant',
      text: '',
      kind: 'text',
      runId: _activeRunId,
      pending: true,
      streaming: true,
      tools: [],
      reasoning: '',
    }
    messages.push(last)
  }
  const openText = String(proj.openText || '')
  if (openText) {
    last.text = openText
    last.pending = false
  } else if (last.pending || last.text === '小V处理中…') {
    last.text = ''
    last.pending = !proj.tools.length && !proj.reasoningPreview
  }
  last.tools = proj.tools
  last.segments = timeline
  last.reasoningPreview = proj.reasoningPreview || ''
  last.reasoningSegments = proj.reasoningSegments || []
  last.reasoning = proj.reasoningPreview || last.reasoning || ''
  last.systemActivity = proj.systemActivity || (last.streaming ? '正在处理' : null)
  last.aguiTurn = _aguiTurn
  last.streaming = true
  last.runId = _activeRunId || last.runId
  patchState({ messages: [...messages], streaming: true })
  if (openText) syncXiaomiVoiceSpeech(openText)
}

/**
 * 把工具 / 思考增量挂到当前流式助手气泡（classic 回退路径）。
 * @param {{ tools?: unknown[], reasoningDelta?: string }} patch
 */
function patchXiaomiLiveProcess(patch) {
  const messages = [...(getState().messages || [])]
  let last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    last = {
      id: `asst-${_activeRunId || Date.now()}`,
      role: 'assistant',
      text: '',
      kind: 'text',
      runId: _activeRunId,
      pending: true,
      streaming: true,
      tools: [],
      reasoning: '',
    }
    messages.push(last)
  }
  if (Array.isArray(patch.tools)) last.tools = patch.tools
  if (patch.reasoningDelta) {
    last.reasoning = `${String(last.reasoning || '')}${patch.reasoningDelta}`
    last.reasoningPreview = last.reasoning
  }
  last.pending = false
  last.streaming = true
  patchState({ messages: [...messages], streaming: true })
}

/** Append one assistant text piece (classic delta or AG-UI TEXT_MESSAGE_CONTENT). */
function appendXiaomiAssistantPiece(piece, runId) {
  const text = String(piece || '')
  if (!text) return
  const messages = [...(getState().messages || [])]
  let last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || (last.runId && runId && last.runId !== runId && !last.pending)) {
    last = {
      id: `asst-${runId || Date.now()}`,
      role: 'assistant',
      text: '',
      kind: 'text',
      runId,
      streaming: true,
      pending: false,
    }
    messages.push(last)
  }
  if (last.pending || last.text === '小V处理中…') {
    last.text = ''
    last.pending = false
  }
  last.runId = runId || last.runId
  last.streaming = true
  last.text = `${last.text || ''}${text}`
  patchState({ messages: [...messages], streaming: true })
  syncXiaomiVoiceSpeech(last.text)
}

function finishXiaomiAssistantRun(runId, finalText) {
  const messages = [...(getState().messages || [])]
  let last = messages[messages.length - 1]
  const incoming = String(finalText || '').trim()
  if (last && last.role === 'assistant' && (last.runId === runId || last.pending || last.streaming)) {
    const streamed = String(last.text || '').trim()
    // Prefer richer text: final payload can briefly lag behind streamed body after tools.
    if (incoming && (!streamed || incoming.length >= streamed.length || incoming.includes(streamed.slice(0, 48)))) {
      last.text = incoming
    } else if (last.pending || last.text === '小V处理中…') {
      last.text = incoming || ''
    }
    last.pending = false
    last.streaming = false
    syncXiaomiVoiceSpeech(last.text || '', { final: true })
  } else if (incoming) {
    messages.push({
      id: `asst-${runId || Date.now()}`,
      role: 'assistant',
      text: incoming,
      kind: 'text',
      runId,
    })
    syncXiaomiVoiceSpeech(incoming, { final: true })
  } else {
    clearXiaomiVoiceReply()
  }
  _activeRunId = ''
  _aguiTurn = null
  patchState({ messages: [...messages], streaming: false })
  // 写操作结束后通知左侧模块页实时刷新（员工/工作流/知识库/事项等）
  try {
    const ctx = extractPageContext()
    const domains = ctx.module ? [String(ctx.module)] : []
    emitPageLiveRefresh({
      domains,
      source: 'xiaomi',
      reason: 'xiaomi-run-finished',
      soft: true,
    })
  } catch {
    /* ignore */
  }
  // Delay history reload so DB catch-up cannot wipe a just-streamed body with a tool-only row.
  window.setTimeout(() => {
    void reloadXiaomiHistoryQuiet()
  }, 900)
}

function failXiaomiAssistantRun(errText) {
  clearXiaomiVoiceReply()
  const err = String(errText || '生成失败').trim()
  const messages = [...(getState().messages || [])]
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && (last.pending || last.streaming)) {
    messages.pop()
  }
  messages.push({
    id: `err-${Date.now()}`,
    role: 'system',
    text: err,
    kind: 'error',
  })
  _activeRunId = ''
  _aguiTurn = null
  patchState({ messages, streaming: false })
}

/**
 * AG-UI wire (default stream_format): text arrives as agui_event TEXT_MESSAGE_CONTENT,
 * not classic state=delta. Extract the piece for the panel bubble.
 * @param {Record<string, unknown>} aguiEvent
 * @returns {string}
 */
export function aguiAssistantTextPiece(aguiEvent) {
  if (!aguiEvent || typeof aguiEvent !== 'object') return ''
  const t = String(aguiEvent.type || '').trim()
  if (t !== 'TEXT_MESSAGE_CONTENT') return ''
  return typeof aguiEvent.delta === 'string' ? aguiEvent.delta : ''
}

export function bindXiaomiStreamListener() {
  if (_unsubEvent) return
  _unsubEvent = wsClient.onEvent((msg) => {
    if (!msg || msg.event !== 'chat') return
    const p = msg.payload || {}
    const sk = String(p.sessionKey || '').trim()
    const mine = String(getState().sessionKey || '').trim()
    if (!mine || sk !== mine) return

    const st = String(p.state || '').trim()
    const runId = String(p.runId || '').trim()

    if (st === 'run_started') {
      markXiaomiRunStarted(runId)
      return
    }

    // Default wire is AG-UI：整轮事件走主对话同一套 reducer → MessageRow
    if (st === 'agui_event') {
      const ev = p.aguiEvent && typeof p.aguiEvent === 'object' ? p.aguiEvent : {}
      const t = String(ev.type || '').trim()
      const aguiRunId = String(ev.runId || runId || '').trim()
      if (t === 'RUN_STARTED') {
        markXiaomiRunStarted(aguiRunId)
        return
      }
      if (t === 'RUN_ERROR') {
        const err =
          typeof ev.message === 'string'
            ? ev.message
            : typeof ev.error === 'string'
              ? ev.error
              : '生成失败'
        failXiaomiAssistantRun(err)
        _aguiTurn = null
        return
      }
      if (!_aguiTurn) {
        if (!_activeRunId && aguiRunId) markXiaomiRunStarted(aguiRunId)
        else if (!_aguiTurn) _aguiTurn = emptyAgUiTurnState(aguiRunId || _activeRunId || '')
      }
      try {
        _aguiTurn = applyAgUiEvent(_aguiTurn, /** @type {any} */ (ev))
      } catch (e) {
        console.warn('[xiaomi] applyAgUiEvent', e)
        // 回退：至少保留工具过程
        const live = getState().messages || []
        const last = live[live.length - 1]
        const curTools = Array.isArray(last?.tools) ? last.tools : []
        const applied = applyXiaomiAgUiProcessEvent(ev, curTools)
        if (applied.changed || applied.reasoningDelta) {
          patchXiaomiLiveProcess({
            tools: applied.changed ? applied.tools : undefined,
            reasoningDelta: applied.reasoningDelta,
          })
        }
        if (t === 'TEXT_MESSAGE_CONTENT') {
          const piece = aguiAssistantTextPiece(ev)
          if (piece) appendXiaomiAssistantPiece(piece, aguiRunId || runId)
        }
        return
      }
      syncXiaomiLiveFromAgui()
      return
    }

    // classic：工具 / 推理也进过程层
    if (st === 'reasoning' || st === 'tool' || st === 'tool_result' || st === 'tool_call') {
      const live = getState().messages || []
      const last = live[live.length - 1]
      const curTools = Array.isArray(last?.tools) ? last.tools : []
      const applied = applyXiaomiClassicToolEvent(st, p, curTools)
      if (applied.changed || applied.reasoningDelta) {
        if (!_activeRunId && runId) markXiaomiRunStarted(runId)
        patchXiaomiLiveProcess({
          tools: applied.changed ? applied.tools : undefined,
          reasoningDelta: applied.reasoningDelta,
        })
      }
      return
    }

    if (st === 'delta') {
      const piece = payloadAssistantText(p)
      if (piece) appendXiaomiAssistantPiece(piece, runId)
      return
    }

    if (st === 'final' || st === 'completed') {
      finishXiaomiAssistantRun(runId, payloadAssistantText(p).trim())
      return
    }

    if (st === 'error' || st === 'failed') {
      failXiaomiAssistantRun(p.error || (typeof p.message === 'string' ? p.message : '') || '生成失败')
      return
    }

    if (st === 'aborted') {
      clearXiaomiVoiceReply()
      const messages = [...(getState().messages || [])]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.pending) {
        messages.pop()
      } else if (last && last.streaming) {
        last.pending = false
        last.streaming = false
      }
      _activeRunId = ''
      _aguiTurn = null
      patchState({ messages: [...messages], streaming: false })
    }
  })
}

export function unbindXiaomiStreamListener() {
  if (_unsubEvent) {
    try {
      _unsubEvent()
    } catch {
      /* ignore */
    }
    _unsubEvent = null
  }
}

async function reloadXiaomiHistoryQuiet() {
  const key = String(getState().sessionKey || '').trim()
  if (!key) return
  try {
    const hist = await api.chatHistory(key, 80)
    const messages = historyToUiMessages(hist?.messages || [])
    if (!messages.length) return
    const live = getState().messages || []
    const liveAsst = [...live].reverse().find((m) => m && m.role === 'assistant')
    const histAsst = [...messages].reverse().find((m) => m && m.role === 'assistant')
    const liveLen = String(liveAsst?.text || '').trim().length
    const histLen = String(histAsst?.text || '').trim().length
    const merged = messages.map((m) => ({ ...m }))
    const lastIdx = merged.length - 1
    const canAttachLive =
      liveAsst &&
      lastIdx >= 0 &&
      merged[lastIdx].role === 'assistant' &&
      !getState().streaming
    if (canAttachLive) {
      const richerText =
        liveLen > histLen + 40
          ? liveAsst.text
          : merged[lastIdx].text
      merged[lastIdx] = {
        ...merged[lastIdx],
        text: richerText,
        runId: liveAsst.runId || merged[lastIdx].runId,
        // 历史行常只有正文：把本轮 MessageRow 过程层（工具/分段/思考）留住
        tools: Array.isArray(liveAsst.tools) && liveAsst.tools.length ? liveAsst.tools : merged[lastIdx].tools,
        segments:
          Array.isArray(liveAsst.segments) && liveAsst.segments.length
            ? liveAsst.segments
            : merged[lastIdx].segments,
        reasoningPreview: liveAsst.reasoningPreview || merged[lastIdx].reasoningPreview,
        reasoningSegments: liveAsst.reasoningSegments || merged[lastIdx].reasoningSegments,
        reasoning: liveAsst.reasoning || merged[lastIdx].reasoning,
        aguiTurn: liveAsst.aguiTurn || merged[lastIdx].aguiTurn,
      }
      patchState({ messages: merged })
      return
    }
    if (liveAsst && liveLen > histLen + 40 && !getState().streaming) {
      merged.push({
        id: liveAsst.id || `asst-live-${Date.now()}`,
        role: 'assistant',
        text: liveAsst.text,
        kind: 'text',
        runId: liveAsst.runId,
        tools: liveAsst.tools,
        segments: liveAsst.segments,
        reasoningPreview: liveAsst.reasoningPreview,
        reasoningSegments: liveAsst.reasoningSegments,
        reasoning: liveAsst.reasoning,
        aguiTurn: liveAsst.aguiTurn,
      })
      patchState({ messages: merged })
      return
    }
    patchState({ messages })
  } catch {
    /* keep memory mirror */
  }
}

/**
 * 页面快照指纹：同页连续发送不重复附带（保 KV cache；可损失未变化页的重复提醒）。
 * @param {Record<string, unknown> | null | undefined} snap
 */
export function fingerprintXiaomiPageSnap(snap) {
  if (!snap || typeof snap !== 'object') return ''
  const ui = snap.ui && typeof snap.ui === 'object' ? /** @type {Record<string, unknown>} */ (snap.ui) : {}
  const tabs = Array.isArray(ui.activeTabs) ? ui.activeTabs.map((t) => String(t || '')).join(',') : ''
  const selected = Array.isArray(ui.selected)
    ? ui.selected
        .map((s) => {
          if (s && typeof s === 'object') {
            const o = /** @type {Record<string, unknown>} */ (s)
            return `${o.id || ''}:${o.label || ''}`
          }
          return String(s || '')
        })
        .join('|')
    : ''
  return [
    snap.module || '',
    snap.route || '',
    snap.contextType || '',
    snap.contextId || '',
    snap.label || '',
    ui.pageTitle || '',
    tabs,
    selected,
  ].join('\n')
}

/**
 * 切路由时只刷新本地感知即可；真正注入在 send 且指纹变化时。
 * @param {Partial<{ label?: string, contextLabel?: string, contextId?: string, contextType?: string, route?: string, module?: string }>} [override]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function syncXiaomiPageContext(override = {}) {
  return collectXiaomiPageSnapshot(undefined, override)
}

/**
 * Send user text to backend xiaomi agent.
 * 页面快照：指纹变化才写入 runContext → 后端 ephemeral Human（name=xiaomi_ui_context），不进气泡、不进 system。
 * @param {string} text
 * @param {{ label?: string, contextLabel?: string, contextId?: string, contextType?: string, route?: string, module?: string, voiceInitiated?: boolean }} [ctx]
 */
export async function sendXiaomiChat(text, ctx = {}) {
  const raw = String(text || '').trim()
  if (!raw) return
  if (getState().streaming) throw new Error('正在生成中，请先停止')

  const key = await ensureXiaomiSession()
  bindXiaomiStreamListener()

  if (await (async () => {
    try {
      const { getVoiceReplyEnabled } = await import('../../lib/panel-settings.js')
      const { shouldArmVoiceReply } = await import('../../lib/voice-reply-mode.js')
      return shouldArmVoiceReply(getVoiceReplyEnabled())
    } catch {
      return false
    }
  })()) {
    await armXiaomiVoiceReply({ voiceInitiated: !!ctx.voiceInitiated })
  } else {
    clearXiaomiVoiceReply()
  }

  const live = extractPageContext()
  /** @type {Record<string, string>} */
  const merged = { ...live }
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'voiceInitiated') continue
    const s = v == null ? '' : String(v).trim()
    if (s) merged[k] = s
  }
  const pageSnap = collectXiaomiPageSnapshot(undefined, merged)
  const fp = fingerprintXiaomiPageSnap(pageSnap)
  let prevFp = ''
  try {
    prevFp = String(wsClient.getSessionContext(key)?.xiaomi_page_context_fp || '').trim()
  } catch {
    prevFp = ''
  }
  const pageChanged = !prevFp || fp !== prevFp

  try {
    await api.chatUpdateContext(key, {
      agent_name: XIAOMI_AGENT,
      agent_id: XIAOMI_AGENT,
      xiaomi_global_assistant: true,
      // 变化才带快照；未变则清空，避免 runContext 重复注入砸缓存
      xiaomi_page_context: pageChanged ? pageSnap : null,
      xiaomi_page_context_fp: fp || null,
    })
  } catch (e) {
    console.warn('[xiaomi] page context sync failed', e)
  }

  const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const messages = [
    ...(getState().messages || []),
    {
      id: userMsgId,
      role: 'user',
      text: raw,
      kind: 'text',
      createdAt: new Date().toISOString(),
    },
    {
      id: `asst-pending-${Date.now()}`,
      role: 'assistant',
      text: '',
      kind: 'text',
      pending: true,
      streaming: true,
    },
  ]
  patchState({ messages, streaming: true, draft: '', activeView: 'chat' }, { persistUi: true })

  try {
    let voiceReply = false
    try {
      const { getVoiceReplyEnabled } = await import('../../lib/panel-settings.js')
      const { shouldArmVoiceReply } = await import('../../lib/voice-reply-mode.js')
      voiceReply = shouldArmVoiceReply(getVoiceReplyEnabled())
    } catch {
      /* ignore */
    }
    await wsClient.chatSend(key, raw, [], [], {
      messageId: userMsgId,
      ...(ctx.voiceInitiated ? { voiceInitiated: true } : {}),
      ...(voiceReply ? { voiceReply: true } : {}),
    })
  } catch (e) {
    clearXiaomiVoiceReply()
    const err = String(e?.message || e || '发送失败')
    const cur = [...(getState().messages || [])]
    const last = cur[cur.length - 1]
    if (last?.pending) cur.pop()
    patchState({
      streaming: false,
      messages: [...cur, { id: `err-${Date.now()}`, role: 'system', text: err, kind: 'error' }],
    })
    throw e
  }
}

export async function stopXiaomiChat() {
  const key = String(getState().sessionKey || '').trim()
  if (!key) return
  const runId = _activeRunId || wsClient.getCollabChatRunId?.(key) || ''
  try {
    if (runId) await api.chatAbort?.(key, runId)
    else await api.chatSessionsStopExecution?.(key).catch(() => {})
  } catch {
    try {
      wsClient.abortStreamWire?.(key, runId)
    } catch {
      /* ignore */
    }
  }
  _activeRunId = ''
  patchState({ streaming: false })
}

/**
 * 在当前小V会话内开新轮次：清空 transcript，换新 LangGraph thread（session_key 不变）。
 * 对齐智能体员工「每轮新 thread」的隔离感，避免一直叠在超长历史上。
 * @returns {Promise<string>} sessionKey
 */
export async function startXiaomiNewRound() {
  if (getState().streaming) {
    await stopXiaomiChat().catch(() => {})
  }
  const key = await ensureXiaomiSession()
  await api.chatSessionsReset(key)
  await api
    .chatUpdateContext(key, {
      agent_name: XIAOMI_AGENT,
      agent_id: XIAOMI_AGENT,
      xiaomi_global_assistant: true,
      xiaomi_page_context: null,
      xiaomi_page_context_fp: null,
    })
    .catch(() => {})
  _activeRunId = ''
  _aguiTurn = null
  clearXiaomiVoiceReply()
  patchState(
    {
      messages: [
        {
          id: `sys-round-${Date.now()}`,
          role: 'system',
          kind: 'text',
          text: '已新开一轮：此前对话上下文已清空，可以重新提问。',
        },
      ],
      streaming: false,
      activeView: 'chat',
      sessionHistoryOpen: false,
    },
    { persistUi: true },
  )
  return key
}

function isXiaomiSessionRow(row) {
  if (!row || typeof row !== 'object') return false
  const ctx = row.context && typeof row.context === 'object' ? row.context : {}
  if (ctx.xiaomi_global_assistant === true || ctx.xiaomi_global_assistant === 'true') return true
  const aid = String(row.agentId || row.agent_id || ctx.agent_id || ctx.agent_name || '')
    .trim()
    .toLowerCase()
  if (aid === XIAOMI_AGENT) return true
  const sk = String(row.sessionKey || row.key || '').toLowerCase()
  if (sk.includes('xiaomi')) return true
  const title = String(row.title || '')
  if (title.includes('小V')) return true
  return false
}

function normalizeXiaomiSessionRow(row) {
  const key = String(row?.sessionKey || row?.key || '').trim()
  return {
    key,
    title: String(row?.title || '').trim() || XIAOMI_SESSION_TITLE,
    updatedAt: Number(row?.updatedAt || row?.updated_at || 0) || 0,
    messageCount: Number(row?.messageCount || row?.message_count || 0) || 0,
  }
}

/** 拉取小V 历史会话列表（写入 store.xiaomiSessions） */
export async function refreshXiaomiSessionList() {
  patchState({ xiaomiSessionsLoading: true })
  try {
    const res = await api.chatSessionsList(100, 0)
    const all = Array.isArray(res?.sessions) ? res.sessions : Array.isArray(res) ? res : []
    const mine = all.filter(isXiaomiSessionRow).map(normalizeXiaomiSessionRow).filter((s) => s.key)
    // 当前会话即使列表暂未返回也补上
    const cur = String(getState().sessionKey || '').trim()
    if (cur && !mine.some((s) => s.key === cur)) {
      mine.unshift({
        key: cur,
        title: XIAOMI_SESSION_TITLE,
        updatedAt: Date.now(),
        messageCount: (getState().messages || []).length,
      })
    }
    mine.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    patchState({ xiaomiSessions: mine, xiaomiSessionsLoading: false })
    return mine
  } catch (e) {
    patchState({ xiaomiSessionsLoading: false })
    throw e
  }
}

/**
 * 切换到已有小V 会话并加载历史。
 * @param {string} sessionKey
 */
export async function switchXiaomiSession(sessionKey) {
  const key = String(sessionKey || '').trim()
  if (!key) throw new Error('会话无效')
  if (getState().streaming) {
    await stopXiaomiChat().catch(() => {})
  }
  _activeRunId = ''
  _aguiTurn = null
  clearXiaomiVoiceReply()
  writeStoredSessionKey(key)
  patchState(
    {
      sessionKey: key,
      messages: [],
      streaming: false,
      activeView: 'chat',
      selectedContact: 'xiaomi',
      sessionHistoryOpen: false,
      loading: true,
    },
    { persistUi: true },
  )
  try {
    await api
      .chatUpdateContext(key, {
        agent_name: XIAOMI_AGENT,
        agent_id: XIAOMI_AGENT,
        use_claude_code_chat: false,
        xiaomi_global_assistant: true,
      })
      .catch(() => {})
    const hist = await api.chatHistory(key, 80).catch(() => ({ messages: [] }))
    const messages = historyToUiMessages(hist?.messages || [])
    patchState({ messages, loading: false })
    bindXiaomiStreamListener()
  } catch (e) {
    patchState({ loading: false, error: String(e?.message || e || '加载会话失败') })
    throw e
  }
  return key
}

/**
 * 新开一个小V 对话会话（新 session_key，不复用旧线程）。
 * @returns {Promise<string>}
 */
export async function startXiaomiNewChat() {
  if (getState().streaming) {
    await stopXiaomiChat().catch(() => {})
  }
  _activeRunId = ''
  _aguiTurn = null
  clearXiaomiVoiceReply()
  const row = await api.chatSessionsCreate(XIAOMI_AGENT, {
    title: XIAOMI_SESSION_TITLE,
    ensureThread: false,
    context: {
      agent_name: XIAOMI_AGENT,
      agent_id: XIAOMI_AGENT,
      xiaomi_global_assistant: true,
      memory_enabled: true,
    },
  })
  const key = String(row?.sessionKey || row?.key || '').trim()
  if (!key) throw new Error('创建小V会话失败')
  writeStoredSessionKey(key)
  patchState(
    {
      sessionKey: key,
      messages: [],
      streaming: false,
      activeView: 'chat',
      selectedContact: 'xiaomi',
      sessionHistoryOpen: false,
      draft: '',
    },
    { persistUi: true },
  )
  bindXiaomiStreamListener()
  void refreshXiaomiSessionList().catch(() => {})
  return key
}
