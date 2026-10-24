/**
 * Open a process item: terminal → right-stage tab; agent → summary panel.
 * Extracted from ChatApp.tsx (P38).
 */
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { ProcessItem } from '../../lib/chat-summary-panel-model.js'
import type { StreamState } from '../../chat-types.js'
import type { InfoRailTab } from '../../components/ChatWorkspaceInfoRail.js'
import { ensureTerminalStage } from '../../../lib/right-stage/ensure-terminal-stage.js'
import { fetchBackgroundBashOutput } from '../../lib/background-bash-api.js'
import { commitStreamSnapshot } from '../../lib/stream-snapshot-store.js'
import type { ChatSummaryDisplayMode } from '../../lib/chat-summary-panel-prefs.js'

export type HandleOpenProcessItemCtx = {
  selectedSessionKey: string
  streamRef: RefObject<StreamState> | MutableRefObject<StreamState>
  sessionRef: MutableRefObject<string>
  streamSeqRef: MutableRefObject<number>
  backgroundOutputPollRef: MutableRefObject<{
    workId: string
    timer: number
    stopAt: number
  } | null>
  scheduleBump: (opts?: { immediate?: boolean }) => void
  setChatPanelDisplayMode: (mode: ChatSummaryDisplayMode) => void
  setInfoRailTab: Dispatch<SetStateAction<InfoRailTab>>
}

export function handleOpenProcessItem(
  ctx: HandleOpenProcessItemCtx,
  item: ProcessItem,
): void {
  if (!item) return
  if (item.kind === 'terminal') {
    const src = item.source as { toolCallId?: string; command?: string; phase?: string }
    const toolCallId = String(src?.toolCallId || item.workId || '').trim()
    if (!toolCallId) {
      ctx.setChatPanelDisplayMode('panel')
      return
    }
    ensureTerminalStage({
      toolCallId,
      title: item.label || '终端',
      command: String(src?.command || ''),
      sessionKey: ctx.selectedSessionKey || undefined,
      running: src?.phase === 'running' || item.state === 'running',
    })
    // ZCode BackgroundBashOutputSidePane：打开时拉输出快照；running 时 1s 轮询。
    const workId = String(item.workId || '').trim()
    if (workId) {
      const prevPoll = ctx.backgroundOutputPollRef.current
      if (prevPoll) {
        window.clearInterval(prevPoll.timer)
        ctx.backgroundOutputPollRef.current = null
      }
      const seed = async () => {
        try {
          const snap = await fetchBackgroundBashOutput(workId)
          if (!snap?.output) return
          const S = ctx.streamRef.current
          if (!S) return
          if (!S.terminalStreams) S.terminalStreams = {}
          const existing = S.terminalStreams[toolCallId]
          const prev = String(existing?.stdout || '')
          if (!prev || prev.length < snap.output.length) {
            S.terminalStreams[toolCallId] = {
              toolCallId,
              command: String(src?.command || existing?.command || ''),
              phase: snap.status === 'running' ? 'running' : existing?.phase || 'running',
              stdout: snap.output,
              stderr: existing?.stderr || '',
              chunks: existing?.chunks,
              startedAt: existing?.startedAt || item.startedAt || Date.now(),
            }
          }
          const sk = String(ctx.selectedSessionKey || ctx.sessionRef.current || '').trim()
          if (sk) {
            ctx.streamSeqRef.current += 1
            commitStreamSnapshot(sk, S, {
              seq: ctx.streamSeqRef.current,
            })
          }
          ctx.scheduleBump({ immediate: true })
          if (snap.status && snap.status !== 'running') {
            const cur = ctx.backgroundOutputPollRef.current
            if (cur?.workId === workId) {
              window.clearInterval(cur.timer)
              ctx.backgroundOutputPollRef.current = null
            }
          }
        } catch {
          /* ignore */
        }
      }
      void seed()
      if (item.state === 'running') {
        const timer = window.setInterval(() => {
          const cur = ctx.backgroundOutputPollRef.current
          if (!cur || Date.now() > cur.stopAt) {
            if (cur) window.clearInterval(cur.timer)
            ctx.backgroundOutputPollRef.current = null
            return
          }
          void seed()
        }, 1000)
        ctx.backgroundOutputPollRef.current = { workId, timer, stopAt: Date.now() + 600_000 }
      }
    }
    return
  }
  if (item.kind === 'agent') {
    ctx.setInfoRailTab('agent')
    ctx.setChatPanelDisplayMode('panel')
  }
}
