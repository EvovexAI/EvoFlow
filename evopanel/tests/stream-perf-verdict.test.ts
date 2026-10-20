import { describe, expect, it, beforeEach } from 'vitest'
import {
  classifyStreamPerfVerdict,
  formatStreamPerfVerdictLine,
  streamPerfNoteBumpThrottle,
  streamPerfNoteContext,
  streamPerfOnProfilerRender,
  streamPerfReset,
  STREAM_PERF_SPAN_HINTS,
} from '../src/react/lib/stream-perf-trace.ts'

describe('streamperf verdict attribution', () => {
  beforeEach(() => {
    streamPerfReset()
  })

  it('formats a line with class + hint path', () => {
    streamPerfNoteContext({ bumpIntervalMs: 50, historyRows: 20 })
    streamPerfNoteBumpThrottle(50, 16)
    const v = classifyStreamPerfVerdict({ trigger: 'bumpThrottle' })
    expect(v.class).toBe('throttle')
    expect(v.hint).toBe(STREAM_PERF_SPAN_HINTS.bumpThrottle)
    const line = formatStreamPerfVerdictLine(v)
    expect(line).toMatch(/^streamperf verdict: class=throttle/)
    expect(line).toContain('hint=evopanel/src/react/lib/stream-bump-interval.ts')
    expect(line).toContain('bumpIntervalMs=50')
  })

  it('attributes longtask to markdown when Profiler top is markdown', () => {
    streamPerfNoteContext({ bumpIntervalMs: 16, historyRows: 8 })
    streamPerfOnProfilerRender('markdown', 'update', 48, 40)
    streamPerfOnProfilerRender('messageRow', 'update', 12, 10)
    const v = classifyStreamPerfVerdict({ trigger: 'longtask', durMs: 120 })
    expect(v.class).toBe('markdown')
    expect(v.hint).toBe(STREAM_PERF_SPAN_HINTS.markdown)
    expect(v.top).toMatch(/markdown:48/)
    const line = formatStreamPerfVerdictLine(v)
    expect(line).toContain('hint=evopanel/src/react/components/MarkdownHtml.tsx')
    expect(line).toContain('longtask=120ms')
  })

  it('attributes memo-fail when most visible rows re-render', () => {
    streamPerfNoteContext({ bumpIntervalMs: 16 })
    const v = classifyStreamPerfVerdict({
      trigger: 'memo-fail',
      memoHit: 0.1,
      renderRows: 12,
      visibleRows: 14,
    })
    expect(v.class).toBe('memo-fail')
    expect(v.hint).toBe(STREAM_PERF_SPAN_HINTS.messageRow)
    expect(formatStreamPerfVerdictLine(v)).toContain('class=memo-fail')
  })

  it('registry covers planned span ids', () => {
    for (const id of [
      'buildRow',
      'messageRow',
      'toolList',
      'markdown',
      'reasoningPaint',
      'bumpThrottle',
      'vlistMeasure',
      'scrollCorrect',
      'chat-stream',
    ]) {
      expect(STREAM_PERF_SPAN_HINTS[id]).toMatch(/^evopanel\//)
    }
  })
})
