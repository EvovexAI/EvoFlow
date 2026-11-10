import { memo, useEffect, useState } from 'react'
import { fetchToolResultFull } from '../../lib/tool-result-fetch.js'
import { stripMindMapHint } from '../../lib/strip-mind-map-hint.js'
import type { TerminalStreamTask } from '../chat-types.js'
import { TerminalToolPanel } from './TerminalToolPanel.js'

export type TerminalStagePanelProps = {
  title?: string
  command: string
  sessionKey?: string
  toolCallId?: string
  outputFallback?: string
  stream?: TerminalStreamTask
  running?: boolean
}

function streamHasOutput(stream: TerminalStreamTask | undefined): boolean {
  if (!stream) return false
  if (stream.chunks?.length) {
    return stream.chunks.some((c) => String(c.text || '').length > 0)
  }
  return Boolean(String(stream.stdout || '').trim() || String(stream.stderr || '').trim())
}

/** 右栏 terminal 标签正文（从 TerminalToolDetailModal 抽出）。 */
export const TerminalStagePanel = memo(function TerminalStagePanel({
  title,
  command,
  sessionKey,
  toolCallId,
  outputFallback,
  stream,
  running,
}: TerminalStagePanelProps) {
  const [fetchedOutput, setFetchedOutput] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const sk = String(sessionKey || '').trim()
    const tcid = String(toolCallId || '').trim()
    if (!sk || !tcid) return
    let cancelled = false
    let retryTimer = 0
    const pull = (attempt: number) => {
      setLoading(true)
      void fetchToolResultFull(sk, tcid)
        .then((data) => {
          if (cancelled) return
          const text = String((data as { content?: string })?.content ?? '').trim()
          if (!text && attempt < 2) {
            retryTimer = window.setTimeout(() => pull(attempt + 1), 800)
            return
          }
          setFetchedOutput(text || null)
        })
        .catch(() => {
          if (cancelled) return
          if (attempt < 2) {
            retryTimer = window.setTimeout(() => pull(attempt + 1), 800)
            return
          }
          setFetchedOutput(null)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    pull(0)
    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [sessionKey, toolCallId])

  const livePreferred = streamHasOutput(stream)
  const persisted = String(fetchedOutput || '').trim()
  const fallback = String(outputFallback || '').trim()
  const output = livePreferred
    ? undefined
    : stripMindMapHint(persisted || fallback) || undefined

  // 标题已在右栏标签页展示，正文里不再重复「会话终端 / 终端」
  return (
    <div className="react-chat-terminal-stage" role="region" aria-label={title || '终端'}>
      {loading && !livePreferred ? (
        <div className="react-chat-terminal-stage-header">
          <span className="react-chat-terminal-stage-hint">加载输出…</span>
        </div>
      ) : null}
      <div className="react-chat-terminal-stage-body">
        <TerminalToolPanel
          command={command}
          outputFallback={output}
          stream={stream}
          running={running}
        />
      </div>
    </div>
  )
})
