import { useEffect, useMemo, useRef } from 'react'
import type { TerminalStreamTask } from '../chat-types.js'

/** Tool results may carry legacy empty placeholders — treat as truly empty stdout. */
function normalizeTerminalOutputFallback(raw: string | undefined): string {
  const fb = String(raw || '').trim()
  if (!fb || fb === '(no output)' || fb === '（无输出）') return ''
  return fb
}

export function TerminalToolPanel({
  command,
  outputFallback,
  stream,
  running,
}: {
  command: string
  outputFallback?: string
  stream?: TerminalStreamTask
  running?: boolean
}) {
  const screenRef = useRef<HTMLPreElement | null>(null)
  const phase = stream?.phase
  const isRunning = !!running || phase === 'running'
  const cmd = String(command || stream?.command || '').trim() || '（无命令）'

  const outputFallbackNorm = normalizeTerminalOutputFallback(outputFallback)

  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [stream, outputFallbackNorm, isRunning, cmd])

  const outputBody = useMemo(() => {
    // 合并 chunks 为两个大块（stdout / stderr），避免每来一个 chunk 重建所有旧 DOM
    const stdout = stream?.chunks?.length
      ? stream.chunks.map((c) => (c.stream === 'stdout' ? c.text : '')).join('')
      : String(stream?.stdout || '')
    const stderr = stream?.chunks?.length
      ? stream.chunks.map((c) => (c.stream === 'stderr' ? c.text : '')).join('')
      : String(stream?.stderr || '')
    if (stdout || stderr) {
      return (
        <>
          {stdout ? (
            <span className="terminal-panel__line terminal-panel__line--stdout">{stdout}</span>
          ) : null}
          {stderr ? (
            <span className="terminal-panel__line terminal-panel__line--stderr">{stderr}</span>
          ) : null}
        </>
      )
    }
    const fb = outputFallbackNorm
    if (fb) {
      return <span className="terminal-panel__line terminal-panel__line--stdout">{fb}</span>
    }
    if (isRunning) {
      return <span className="terminal-panel__line terminal-panel__line--muted">…</span>
    }
    return null
  }, [stream, outputFallbackNorm, isRunning])

  const exitHint =
    !isRunning && stream?.exitCode != null && stream.exitCode !== 0
      ? `\n[exit ${stream.exitCode}]`
      : !isRunning && phase === 'failed' && stream?.exitCode == null
        ? '\n[exit 1]'
        : ''

  return (
    <div className="terminal-panel" role="region" aria-label="Terminal">
      <div className="terminal-panel__titlebar" aria-hidden="true">
        <span className="terminal-panel__traffic">
          <span className="terminal-panel__dot terminal-panel__dot--red" />
          <span className="terminal-panel__dot terminal-panel__dot--yellow" />
          <span className="terminal-panel__dot terminal-panel__dot--green" />
        </span>
        <span className="terminal-panel__titlebar-label">Terminal</span>
      </div>
      <pre ref={screenRef} className="terminal-panel__screen">
        <span className="terminal-panel__prompt" aria-hidden="true">
          $
        </span>{' '}
        <span className="terminal-panel__cmd">{cmd}</span>
        {'\n'}
        {outputBody}
        {exitHint ? (
          <span className="terminal-panel__line terminal-panel__line--exit">{exitHint}</span>
        ) : null}
        {isRunning ? (
          <span className="terminal-panel__cursor" aria-hidden="true">
            ▌
          </span>
        ) : null}
      </pre>
    </div>
  )
}
