import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStreamStopTrace,
  logStreamStop,
  markStreamStopTrace,
  noteStreamStopUiIdle,
  streamStopSinceMs,
} from '../src/react/lib/stream-stop-log.ts'

afterEach(() => {
  clearStreamStopTrace()
})

describe('stream stop sinceStopMs', () => {
  it('marks click and reports sinceStopMs on later events', async () => {
    markStreamStopTrace({
      sessionKey: 'agent:main:demo',
      source: 'composer_stop_button',
    })
    expect(streamStopSinceMs({ sessionKey: 'agent:main:demo' })).toBeGreaterThanOrEqual(0)

    await new Promise((r) => setTimeout(r, 25))
    const kind = logStreamStop({
      sessionKey: 'agent:main:demo',
      trigger: 'stop_api_done',
      hasEndMarker: false,
      skipDedupe: true,
    })
    expect(kind).toBe('normal')
    const since = streamStopSinceMs({ sessionKey: 'agent:main:demo' })
    expect(since).toBeGreaterThanOrEqual(20)
  })

  it('ui_idle_after_stop clears the trace', async () => {
    markStreamStopTrace({
      sessionKey: 'agent:main:demo',
      threadId: 'thread-1',
      source: 'v4_stop_button',
    })
    await new Promise((r) => setTimeout(r, 10))
    noteStreamStopUiIdle({
      sessionKey: 'agent:main:demo',
      threadId: 'thread-1',
    })
    expect(streamStopSinceMs({ sessionKey: 'agent:main:demo' })).toBeNull()
  })

  it('matches threadId when SessionPane logged thread as sessionKey', () => {
    markStreamStopTrace({
      threadId: 'abc-thread',
      source: 'v4_stop_button',
    })
    expect(streamStopSinceMs({ sessionKey: 'abc-thread' })).not.toBeNull()
    expect(streamStopSinceMs({ threadId: 'abc-thread' })).not.toBeNull()
  })
})
