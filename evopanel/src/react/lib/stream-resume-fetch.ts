/**
 * Fetch and parse chat stream-resume SSE from Gateway.
 */
import { srLog, srWarn } from './stream-resume-debug.js'

async function openStreamResumeResponse(
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  const { evoflowFetchStream } = await import('../../lib/ws-client.js')
  return evoflowFetchStream(url, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal,
  }) as Promise<Response>
}

export type ResumeUnavailablePayload = { reason?: string }

export type RunCompletedPayload = {
  sessionKey?: string
  runStatus?: string
  threadId?: string | null
  runId?: string | null
  messages?: unknown[]
  session?: Record<string, unknown>
}

export type TranscriptResumeAnchor = {
  persistedTurnText?: string
  persistedToolCallIds?: string[]
}

export type StreamResumeFetchOptions = {
  sessionKey: string
  runId?: string | null
  threadId?: string | null
  signal?: AbortSignal
  /** Diagnostic tag (debug log only) */
  resumeReason?: string
  onResumePhase?: (phase: 'catchup' | 'live') => void
  onResumeUnavailable?: (data: ResumeUnavailablePayload) => void
  onWireFrame?: (frameText: string) => void
  /** History-poll resume: latest DB messages while run still active. */
  onHistorySnapshot?: (data: RunCompletedPayload) => void
  onRunCompleted?: (data: RunCompletedPayload) => void
}

function takeCompleteSseFrames(raw: string): { frames: string[]; rest: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  return { frames: parts, rest }
}

function parseSseFrame(frame: string): { event: string; data: string } {
  let event = ''
  let data = ''
  for (const line of frame.split('\n')) {
    const l = line.replace(/\r$/, '')
    if (l.startsWith('event:')) event = l.slice(6).trim()
    if (l.startsWith('data:')) data += l.slice(5).trim()
  }
  return { event, data }
}

export async function streamResumeFetch(opts: StreamResumeFetchOptions): Promise<{
  completed?: RunCompletedPayload
  resumeUnavailable?: ResumeUnavailablePayload
}> {
  const sk = String(opts.sessionKey || '').trim()
  if (!sk) return {}

  const params = new URLSearchParams()
  if (opts.runId) params.set('runId', String(opts.runId))
  if (opts.threadId) params.set('threadId', String(opts.threadId))
  const qs = params.toString()
  const url = `/api/chat/sessions/${encodeURIComponent(sk)}/stream-resume${qs ? `?${qs}` : ''}`

  srLog('streamResumeFetch GET', {
    sessionKey: sk,
    runId: opts.runId ?? null,
    threadId: opts.threadId ?? null,
    url,
    resumeReason: opts.resumeReason ?? null,
  })
  const resp = await openStreamResumeResponse(url, opts.signal)

  if (!resp.ok) {
    srWarn('streamResumeFetch HTTP error', { status: resp.status, url })
    if (resp.status === 404 || resp.status === 406) {
      return { resumeUnavailable: { reason: 'mirrorUnavailable' } }
    }
    throw new Error(`stream-resume HTTP ${resp.status}`)
  }

  if (!resp.body) {
    srWarn('streamResumeFetch no body', { url })
    return { resumeUnavailable: { reason: 'mirrorUnavailable' } }
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed: RunCompletedPayload | undefined
  let resumeUnavailable: ResumeUnavailablePayload | undefined
  let wireFrames = 0
  let deltaFrames = 0
  // @ts-ignore
  let phase: 'catchup' | 'live' | 'pre' = 'pre'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const { frames, rest } = takeCompleteSseFrames(buffer)
    buffer = rest
    for (const frame of frames) {
      if (!frame.trim()) continue
      const { event, data } = parseSseFrame(frame)
      if (event === 'resumePhase') {
        const p = data === 'catchup' || data === 'live' ? data : undefined
        if (p) {
          phase = p
          srLog(`streamResumeFetch phase:${p}`, {
            sessionKey: sk,
            wireFramesSoFar: wireFrames,
            deltaFramesSoFar: deltaFrames,
          })
          opts.onResumePhase?.(p)
        }
        continue
      }
      if (event === 'resumeUnavailable') {
        try {
          resumeUnavailable = JSON.parse(data) as ResumeUnavailablePayload
        } catch {
          resumeUnavailable = { reason: 'mirrorUnavailable' }
        }
        srWarn('streamResumeFetch resumeUnavailable', {
          sessionKey: sk,
          reason: resumeUnavailable.reason,
          wireFrames,
          deltaFrames,
        })
        opts.onResumeUnavailable?.(resumeUnavailable)
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        return { resumeUnavailable }
      }
      if (event === 'historySnapshot') {
        let snapshot: RunCompletedPayload = {}
        try {
          snapshot = JSON.parse(data) as RunCompletedPayload
        } catch {
          snapshot = {}
        }
        srLog('streamResumeFetch historySnapshot', {
          sessionKey: sk,
          runStatus: snapshot.runStatus,
          messageCount: Array.isArray(snapshot.messages) ? snapshot.messages.length : 0,
        })
        opts.onHistorySnapshot?.(snapshot)
        continue
      }
      if (event === 'runCompleted') {
        try {
          completed = JSON.parse(data) as RunCompletedPayload
        } catch {
          completed = {}
        }
        srLog('streamResumeFetch runCompleted', {
          sessionKey: sk,
          runStatus: completed.runStatus,
          messageCount: Array.isArray(completed.messages) ? completed.messages.length : 0,
          wireFrames,
          deltaFrames,
        })
        opts.onRunCompleted?.(completed)
        continue
      }
      if (event === 'done' && data === '[DONE]') {
        continue
      }
      wireFrames += 1
      if (event === 'ag-ui' || event === 'agui') {
        try {
          const ag = JSON.parse(data) as { type?: string; delta?: string }
          if (
            ag?.type === 'TEXT_MESSAGE_CONTENT' &&
            typeof ag.delta === 'string' &&
            ag.delta
          ) {
            deltaFrames += 1
          }
          if (ag?.type === 'RUN_FINISHED') deltaFrames += 1
        } catch {
          if (data.includes('TEXT_MESSAGE_CONTENT')) deltaFrames += 1
        }
      } else if (event === 'evf') {
        // Legacy wire removed; ignore if still present in old mirror dumps.
        continue
      } else if (
        !event &&
        (data.startsWith('{') || data.startsWith('[')) &&
        data.includes('"chat.completion.chunk"')
      ) {
        try {
          const chunk = JSON.parse(data) as { object?: string; choices?: Array<{ delta?: { content?: string } }> }
          if (chunk?.object === 'chat.completion.chunk' && chunk.choices?.[0]?.delta?.content) {
            deltaFrames += 1
          }
        } catch {
          /* ignore */
        }
      } else if (event === 'meta') {
        try {
          const meta = JSON.parse(data) as { type?: string }
          if (meta?.type === 'run_end') deltaFrames += 1
        } catch {
          /* ignore */
        }
      }
      opts.onWireFrame?.(frame + '\n\n')
    }
  }

  if (buffer.trim()) {
    opts.onWireFrame?.(buffer.replace(/\r\n/g, '\n'))
  }

  srLog('streamResumeFetch stream ended', {
    sessionKey: sk,
    wireFrames,
    deltaFrames,
    completed: Boolean(completed),
    resumeUnavailable: resumeUnavailable ?? null,
  })

  return { completed, resumeUnavailable }
}