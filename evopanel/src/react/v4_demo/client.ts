/**
 * H1 demo: minimal client transport for /v4/demo/* endpoints.
 *
 * Adapter for ``backend/app/gateway/v4_demo/routes.py``。返回 Promise-based
 * ``fetch`` 包装 + ``EventSource`` 解析 v4 frame.
 */

import type {
  ConversationTopicFrame,
  SessionHandle,
} from './protocol'

const DEFAULT_BASE_URL = '/api'

export class H1V4Client {
  private readonly baseUrl: string

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** ``POST {baseUrl}/v4/demo/new_session`` → SessionHandle */
  async newSession(): Promise<SessionHandle> {
    const resp = await fetch(`${this.baseUrl}/v4/demo/new_session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!resp.ok) {
      throw new Error(`new_session failed: ${resp.status}`)
    }
    return (await resp.json()) as SessionHandle
  }

  /** ``POST {baseUrl}/v4/demo/send_text?session_id=&text=`` */
  async sendText(sessionId: string, text: string): Promise<{ turnId: string }> {
    const url = `${this.baseUrl}/v4/demo/send_text?session_id=${encodeURIComponent(
      sessionId,
    )}&text=${encodeURIComponent(text)}`
    const resp = await fetch(url, { method: 'POST' })
    if (!resp.ok) {
      throw new Error(`send_text failed: ${resp.status}`)
    }
    return (await resp.json()) as { turnId: string }
  }

  /** ``GET {baseUrl}/v4/demo/snapshot/{sid}`` */
  async snapshot(sessionId: string): Promise<ConversationTopicFrame> {
    const resp = await fetch(
      `${this.baseUrl}/v4/demo/snapshot/${encodeURIComponent(sessionId)}`,
    )
    if (!resp.ok) {
      throw new Error(`snapshot failed: ${resp.status}`)
    }
    return (await resp.json()) as ConversationTopicFrame
  }

  /**
   * SSE consumer: returns an AsyncIterable that yields ``ConversationTopicFrame``.
   *
   * Wire format: ``event: frame\\ndata: <json>\\n\\n``.
   */
  async *stream(sessionId: string, signal?: AbortSignal): AsyncIterable<ConversationTopicFrame> {
    const url = `${this.baseUrl}/v4/demo/stream/${encodeURIComponent(sessionId)}`
    const resp = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    })
    if (!resp.ok || !resp.body) {
      throw new Error(`stream failed: ${resp.status}`)
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Parse SSE events from buffer.
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const lines = raw.split('\n')
          let eventName: string | null = null
          let data = ''
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              data += line.slice(5).trim()
            }
          }
          if (eventName === 'frame' && data) {
            try {
              yield JSON.parse(data) as ConversationTopicFrame
            } catch (err) {
              // swallow malformed JSON; protocol must be inspected.
              // eslint-disable-next-line no-console
              console.warn('[h1-demo] bad frame JSON', err, data.slice(0, 100))
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // already released
      }
    }
  }
}

export const h1V4Client = new H1V4Client()