/**
 * Offline stream UI routing replay — mirrors ChatApp `afterLiveOrStructuralBump`
 * decisions without WebSocket, backend, or React mount.
 */
import {
  bumpStreamDisplayTick,
  getStreamDisplayTick,
  resetStreamDisplayTick,
} from './stream-display-tick.js'
import {
  getLiveStreamSnapshot,
  publishLiveStream,
  resetLiveStreamStoreForTests,
} from './live-stream-store.js'
import {
  disposeLiveStreamUiBatch,
  drainLiveStreamTextBatch,
  isAgUiLiveTextEvent,
  isStreamTurnLiveTextEvent,
  prepareLiveStreamStructuralUpdate,
  scheduleLiveStreamTextPublish,
} from './live-stream-ui.js'
import { setLiveStreamPathEnabled } from './stream-live-path-toggle.js'
import {
  getClientPerfSnapshot,
  resetClientPerf,
  setChatSurfaceVisible,
} from './client-perf.js'

const LIFECYCLE = new Set(['RUN_STARTED', 'RUN_FINISHED'])

export type StreamReplayResult = {
  eventCount: number
  textDeltaCount: number
  structuralCount: number
  displayTicks: number
  livePublishes: number
  liveEpoch: number
  displayTickPerTextDelta: number
  livePathEnabled: boolean
}

function isLiveTextEvent(type: string): boolean {
  return isAgUiLiveTextEvent(type) || isStreamTurnLiveTextEvent(type)
}

function applyTextDelta(
  event: { type: string; delta?: string; text?: string },
  text: { body: string; reasoning: string },
): void {
  const delta = String(event.delta ?? event.text ?? '')
  if (!delta) return
  if (event.type === 'REASONING_MESSAGE_CONTENT' || event.type === 'reasoning_piece') {
    text.reasoning += delta
    return
  }
  if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'text_piece') {
    text.body += delta
  }
}

function routeEvent(sessionKey: string, type: string, livePath: boolean, text: { body: string; reasoning: string }): 'live' | 'structural' | 'skip' {
  if (LIFECYCLE.has(type)) return 'skip'
  if (isLiveTextEvent(type)) {
    if (livePath && scheduleLiveStreamTextPublish(sessionKey)) {
      publishLiveStream(sessionKey, {
        text: text.body,
        reasoning: text.reasoning,
        streaming: true,
      })
      return 'live'
    }
    bumpStreamDisplayTick()
    return 'live'
  }
  prepareLiveStreamStructuralUpdate(sessionKey)
  bumpStreamDisplayTick()
  return 'structural'
}

export function replayStreamEvents(
  events: Array<{ type: string; delta?: string; text?: string }>,
  opts?: { livePath?: boolean; sessionKey?: string; chatVisible?: boolean },
): StreamReplayResult {
  const livePath = opts?.livePath ?? true
  const sk = String(opts?.sessionKey || 'perf-replay').trim()

  resetStreamDisplayTick()
  resetLiveStreamStoreForTests()
  resetClientPerf()
  setLiveStreamPathEnabled(livePath)
  setChatSurfaceVisible(opts?.chatVisible ?? true)
  disposeLiveStreamUiBatch()

  const text = { body: '', reasoning: '' }
  let textDeltaCount = 0
  let structuralCount = 0

  for (const ev of events) {
    const type = String(ev?.type || '').trim()
    if (!type) continue
    if (type === 'TEXT_MESSAGE_CONTENT' || type === 'REASONING_MESSAGE_CONTENT' || type === 'text_piece' || type === 'reasoning_piece') {
      textDeltaCount += 1
      applyTextDelta(ev, text)
    }
    const route = routeEvent(sk, type, livePath, text)
    if (route === 'structural') structuralCount += 1
  }

  drainLiveStreamTextBatch()
  const displayTicks = getStreamDisplayTick()
  const snap = getClientPerfSnapshot()

  return {
    eventCount: events.length,
    textDeltaCount,
    structuralCount,
    displayTicks,
    livePublishes: snap.liveStreamPublishes,
    liveEpoch: getLiveStreamSnapshot(sk).epoch,
    displayTickPerTextDelta: textDeltaCount > 0 ? displayTicks / textDeltaCount : 0,
    livePathEnabled: livePath,
  }
}

/** Reasonix-style deterministic filler stream (shape only, no real content). */
export function generateTextDeltaEvents(charCount: number, chunkChars = 12): Array<{ type: string; delta: string }> {
  const events: Array<{ type: string; delta: string }> = [
    { type: 'RUN_STARTED' },
    { type: 'TEXT_MESSAGE_START' },
  ]
  let body = ''
  const sentence = 'More explanatory prose follows here. '
  while (body.length < charCount) body += sentence
  body = body.slice(0, charCount)
  for (let i = 0; i < body.length; i += chunkChars) {
    events.push({ type: 'TEXT_MESSAGE_CONTENT', delta: body.slice(i, i + chunkChars) })
  }
  events.push({ type: 'TEXT_MESSAGE_END' })
  events.push({ type: 'RUN_FINISHED' })
  return events
}

/** DeepSeek-style: long reasoning then answer body. */
export function generateReasoningThenAnswerEvents(
  reasoningChars: number,
  answerChars: number,
  chunkChars = 12,
): Array<{ type: string; delta: string }> {
  const events: Array<{ type: string; delta: string }> = [{ type: 'RUN_STARTED' }]
  const emit = (kind: 'reasoning' | 'text', target: number) => {
    if (target <= 0) return
    if (kind === 'reasoning') {
      events.push({ type: 'REASONING_START' }, { type: 'REASONING_MESSAGE_START' })
    } else {
      events.push({ type: 'TEXT_MESSAGE_START' })
    }
    let buf = ''
    const filler = kind === 'reasoning' ? 'considering the next step. ' : 'answer prose continues. '
    while (buf.length < target) buf += filler
    buf = buf.slice(0, target)
    for (let i = 0; i < buf.length; i += chunkChars) {
      events.push({
        type: kind === 'reasoning' ? 'REASONING_MESSAGE_CONTENT' : 'TEXT_MESSAGE_CONTENT',
        delta: buf.slice(i, i + chunkChars),
      })
    }
    if (kind === 'reasoning') {
      events.push({ type: 'REASONING_MESSAGE_END' }, { type: 'REASONING_END' })
    } else {
      events.push({ type: 'TEXT_MESSAGE_END' })
    }
  }
  emit('reasoning', reasoningChars)
  emit('text', answerChars)
  events.push({ type: 'RUN_FINISHED' })
  return events
}

/** N tool rounds: reasoning → tool call → short answer chunk (multi-round exploring shape). */
export function generateMultiToolRoundEvents(
  rounds: number,
  opts?: { textCharsPerRound?: number; chunkChars?: number },
): Array<{ type: string; delta?: string; toolCallId?: string; toolCallName?: string }> {
  const textChars = opts?.textCharsPerRound ?? 48
  const chunkChars = opts?.chunkChars ?? 12
  const events: Array<{ type: string; delta?: string; toolCallId?: string; toolCallName?: string }> =
    [{ type: 'RUN_STARTED' }]

  for (let r = 0; r < rounds; r += 1) {
    const rid = `reason-${r}`
    const tid = `tool-${r}`
    events.push(
      { type: 'REASONING_START', messageId: rid },
      { type: 'REASONING_MESSAGE_START', messageId: rid },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: rid, delta: `round ${r} thinking. ` },
      { type: 'REASONING_MESSAGE_END', messageId: rid },
      { type: 'REASONING_END', messageId: rid },
      { type: 'TOOL_CALL_START', toolCallId: tid, toolCallName: 'read_file' },
      { type: 'TOOL_CALL_ARGS', toolCallId: tid, delta: `{"path":"file-${r}.md"}` },
      { type: 'TOOL_CALL_END', toolCallId: tid },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: tid,
        messageId: `${tid}-result`,
        content: `# file ${r}`,
      },
      { type: 'TEXT_MESSAGE_START', messageId: `body-${r}` },
    )
    let body = `Round ${r} answer: `
    while (body.length < textChars) body += 'more text. '
    body = body.slice(0, textChars)
    for (let i = 0; i < body.length; i += chunkChars) {
      events.push({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: `body-${r}`,
        delta: body.slice(i, i + chunkChars),
      })
    }
    events.push({ type: 'TEXT_MESSAGE_END', messageId: `body-${r}` })
  }

  events.push({ type: 'RUN_FINISHED' })
  return events
}

export function readBenchHistoryCountFromUrl(defaultCount = 24): number {
  if (typeof window === 'undefined') return defaultCount
  try {
    const hash = String(window.location.hash || '')
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
    const search = hashQuery || String(window.location.search || '').replace(/^\?/, '')
    const raw = new URLSearchParams(search).get('history')
    const n = raw ? Number(raw) : defaultCount
    if (!Number.isFinite(n) || n < 0) return defaultCount
    return Math.min(2000, Math.max(0, Math.floor(n)))
  } catch {
    return defaultCount
  }
}
