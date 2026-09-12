/**
 * Dual-session stream switch bench — one visible MessageRow at a time (mirrors ChatApp switch).
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageRow } from './components/MessageRow.js'
import { installClientPerfHook } from './lib/client-perf-hook.js'
import type { DisplayRow } from './chat-types.js'

export const BENCH_DUAL_SESSION_A = 'bench-dual-a'
export const BENCH_DUAL_SESSION_B = 'bench-dual-b'

const STREAM_ROW: DisplayRow = {
  role: '_stream',
  text: 'Dual-session stream seed.',
  segments: [{ kind: 'text', text: 'Dual-session stream seed.' }],
  tools: [],
}

declare global {
  interface Window {
    __benchDualSessionSwitch?: (which: 'a' | 'b') => void
  }
}

function BenchDualSessionPerfApp() {
  const [active, setActive] = useState<'a' | 'b'>('a')

  useEffect(() => {
    window.__benchDualSessionSwitch = (which) => setActive(which === 'b' ? 'b' : 'a')
    return () => {
      delete window.__benchDualSessionSwitch
    }
  }, [])

  const sk = active === 'a' ? BENCH_DUAL_SESSION_A : BENCH_DUAL_SESSION_B

  return (
    <div
      id="bench-dual-session-root"
      data-bench-ready="1"
      data-bench-dual="1"
      data-bench-active={active}
      style={{
        height: '100%',
        overflow: 'auto',
        padding: 16,
        boxSizing: 'border-box',
        background: 'var(--bg-primary, #111)',
      }}
    >
      <div style={{ marginBottom: 12, opacity: 0.7, fontSize: 13 }}>
        Dual-session switch bench — only active MessageRow mounted (A ↔ B), no API
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          id="bench-switch-a"
          type="button"
          aria-pressed={active === 'a'}
          onClick={() => setActive('a')}
          style={{ padding: '6px 12px' }}
        >
          Session A
        </button>
        <button
          id="bench-switch-b"
          type="button"
          aria-pressed={active === 'b'}
          onClick={() => setActive('b')}
          style={{ padding: '6px 12px' }}
        >
          Session B
        </button>
      </div>
      <div className="msg-ai msg-ai-streaming" style={{ marginBottom: 12 }}>
        <MessageRow key={sk} row={STREAM_ROW} sessionKey={sk} isStreaming />
      </div>
      <button id="bench-probe-target" type="button" style={{ padding: '8px 12px' }}>
        probe target
      </button>
    </div>
  )
}

export function mountBenchDualSessionPerf(container: HTMLElement): () => void {
  try {
    localStorage.setItem('evopanel_client_perf', '1')
    localStorage.setItem('evopanel_live_stream_path', '1')
  } catch {
    /* ignore */
  }
  installClientPerfHook()
  const root = createRoot(container)
  root.render(<BenchDualSessionPerfApp />)
  return () => {
    try {
      root.unmount()
    } catch {
      /* ignore */
    }
  }
}
