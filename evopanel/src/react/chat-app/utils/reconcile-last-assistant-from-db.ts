/**
 * Post-stream DB reconcile for last assistant row.
 * Extracted from ChatApp.tsx (P16).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { buildHistoryViewFromRaw } from '../../lib/chatHistoryView.js'
import { fetchSessionHistoryTailMessages } from '../../hooks/fetchSessionHistory.js'
import {
  displayRowsEquivalent,
  reconcileLastAssistantInRows,
} from '../../lib/reconcile-last-assistant-from-history.js'
import {
  getSessionRuntime,
  isTurnBusy,
  replaceSessionRuntimeRowsFromHistory,
  updateSessionRuntimeRows,
} from '../../lib/session-runtime-store.js'
import type { DisplayRow } from '../../chat-types.js'

export type ReconcileLastAssistantFromDbCtx = {
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  rowsRef: MutableRefObject<DisplayRow[]>
  reconcileInflightRef: MutableRefObject<Map<string, Promise<void>>>
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
}

export async function reconcileLastAssistantFromDb(
  ctx: ReconcileLastAssistantFromDbCtx,
  opts: { sessionKey: string; runId?: string | null },
): Promise<void> {
  const sk = String(opts.sessionKey || '').trim()
  const runId = String(opts.runId || '').trim() || null
  if (!sk) return
  const flightKey = `${sk}:${runId || '_'}`
  const prev = ctx.reconcileInflightRef.current.get(flightKey)
  if (prev) return prev

  const work = (async () => {
    const tryOnce = async (): Promise<'applied' | 'synced' | 'retry' | 'skip'> => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        const chatApi = (sessionKey: string, limit: number, historyOpts?: { all?: boolean }) =>
          api.chatHistory(sessionKey, limit, historyOpts)
        const result = await fetchSessionHistoryTailMessages(chatApi, sk, 24)
        const built = buildHistoryViewFromRaw(result.messages)
        const rt = getSessionRuntime(sk)
        const localRows = rt.rows.length ? rt.rows : ctx.rowsRef.current
        const outcome = reconcileLastAssistantInRows(localRows, built.rows, runId)
        if (outcome.status === 'applied') {
          updateSessionRuntimeRows(sk, () => outcome.rows)
          replaceSessionRuntimeRowsFromHistory(sk, outcome.rows)
          if (sk === String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()) {
            ctx.setRows((prevRows) => {
              if (displayRowsEquivalent(prevRows, outcome.rows)) return prevRows
              return outcome.rows
            })
          }
          return 'applied'
        }
        return outcome.status
      } catch {
        return 'retry'
      }
    }
    for (const delayMs of [800, 2000, 4000]) {
      if (delayMs) await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
      const rt = getSessionRuntime(sk)
      if (isTurnBusy(rt)) return
      const status = await tryOnce()
      if (status === 'applied' || status === 'synced' || status === 'skip') return
    }
  })().finally(() => {
    if (ctx.reconcileInflightRef.current.get(flightKey) === work) {
      ctx.reconcileInflightRef.current.delete(flightKey)
    }
  })

  ctx.reconcileInflightRef.current.set(flightKey, work)
  return work
}
