/**
 * Minimal real-DOM stream bench — mounts MessageRow + history without Gateway/SSE.
 * Large history uses lightweight stubs (virtual-list style) so stress can reach 1k–2k turns
 * without multi-minute mount cost; last few rows use real MessageRow.
 */
import { createRoot } from 'react-dom/client'
import { MessageRow } from './components/MessageRow.js'
import { installClientPerfHook } from './lib/client-perf-hook.js'
import { readBenchHistoryCountFromUrl } from './lib/stream-perf-replay.js'
import type { DisplayRow } from './chat-types.js'

export const BENCH_STREAM_SESSION = 'bench-stream-perf'
const RICH_HISTORY_TAIL = 8

function makeHistoryRow(i: number): DisplayRow {
  const text = `History turn ${i}: **markdown** paragraph with \`code\` and enough text to simulate a loaded session row in the virtual list.`
  return {
    role: 'assistant',
    text,
    segments: [{ kind: 'text', text }],
    tools: [],
  } as DisplayRow
}

const STREAM_ROW: DisplayRow = {
  role: '_stream',
  text: 'Streaming seed text.',
  segments: [{ kind: 'text', text: 'Streaming seed text.' }],
  tools: [],
}

function BenchStreamPerfApp() {
  const historyCount = readBenchHistoryCountFromUrl(24)
  const stubCount = Math.max(0, historyCount - RICH_HISTORY_TAIL)
  const richStart = stubCount
  const richRows = Array.from({ length: Math.min(RICH_HISTORY_TAIL, historyCount) }, (_, j) =>
    makeHistoryRow(richStart + j),
  )

  return (
    <div
      id="bench-stream-perf-root"
      data-bench-ready="1"
      data-bench-history={historyCount}
      style={{
        height: '100%',
        overflow: 'auto',
        padding: 16,
        boxSizing: 'border-box',
        background: 'var(--bg-primary, #111)',
      }}
    >
      <div style={{ marginBottom: 12, opacity: 0.7, fontSize: 13 }}>
        EvoPanel stream perf bench — {historyCount} history ({stubCount} stub + {richRows.length}{' '}
        MessageRow) + LiveStream, no API
      </div>
      {Array.from({ length: stubCount }, (_, i) => (
        <div
          key={`stub-${i}`}
          className="msg-ai bench-history-stub"
          style={{ marginBottom: 8, fontSize: 12, opacity: 0.55, lineHeight: 1.35 }}
        >
          History turn {i}: stub row (DOM weight for long-session stress)
        </div>
      ))}
      {richRows.map((row, i) => (
        <div key={`h-${richStart + i}`} className="msg-ai" style={{ marginBottom: 12 }}>
          <MessageRow row={row} sessionKey={BENCH_STREAM_SESSION} />
        </div>
      ))}
      <div className="msg-ai msg-ai-streaming" style={{ marginBottom: 12 }}>
        <MessageRow row={STREAM_ROW} sessionKey={BENCH_STREAM_SESSION} isStreaming />
      </div>
      <button id="bench-probe-target" type="button" style={{ padding: '8px 12px' }}>
        probe target
      </button>
    </div>
  )
}

export function mountBenchStreamPerf(container: HTMLElement): () => void {
  try {
    localStorage.setItem('evopanel_client_perf', '1')
    localStorage.setItem('evopanel_live_stream_path', '1')
  } catch {
    /* ignore */
  }
  installClientPerfHook()
  const root = createRoot(container)
  root.render(<BenchStreamPerfApp />)
  return () => {
    try {
      root.unmount()
    } catch {
      /* ignore */
    }
  }
}
