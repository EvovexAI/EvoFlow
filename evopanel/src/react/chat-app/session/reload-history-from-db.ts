// @ts-nocheck — mechanical P118 extract.
/**
 * Reload thread history from DB, optionally clearing live stream first (dbOnly).
 * Extracted from ChatApp.tsx (P118).
 */
export type ReloadHistoryFromDbCtx = Record<string, any>

export async function reloadHistoryFromDb(
  ctx: ReloadHistoryFromDbCtx,
  opt?: { bypassCache?: boolean; anchorRunId?: string | null; dbOnly?: boolean },
): Promise<any> {
  const sk = String(ctx.selectedSessionKey || '').trim()
  const dbOnly = Boolean(opt?.dbOnly)
  if (dbOnly && sk) {
    // 旧 endLiveStreamSession 已删：live-stream-store 没了
    ctx.resetSessionLiveStreamDisplay(sk, ctx.streamRef)
    ctx.deleteLiveRunSnapshotBestEffort(sk)
    ctx.markSessionResumeCatchupReplay(sk, false)
    if (sk === String(ctx.sessionRef.current || '').trim()) {
      ctx.setThreadPanelState((prev) => ctx.clearThreadPanelActivity(prev))
      const cached = ctx.threadPanelBySessionRef.current.get(sk)
      if (cached) {
        ctx.threadPanelBySessionRef.current.set(sk, ctx.clearThreadPanelActivity(cached))
      }
    }
    ctx.bumpStreamFullRef.current()
    ctx.sfWarn('reloadHistoryFromDb — clearing live stream', { sessionKey: sk, dbOnly })
    ctx.srLog('reloadHistoryFromDb cleared live stream + header activity', { sessionKey: sk })
  }
  const result = await ctx.reload({ ...opt, dbOnly })
  if (dbOnly && sk && Array.isArray(result?.rows)) {
    const rt = ctx.getSessionRuntime(sk)
    const localRows = rt.rows.length ? rt.rows : ctx.rowsRef.current
    const lastAsst = [...localRows].reverse().find((r) => r?.role === 'assistant')
    const runId = String(lastAsst?.runId || '').trim() || null
    const mergedRows = ctx.mergeDbOnlyHistoryRows(
      localRows,
      result.rows,
      runId,
      Boolean(opt?.bypassCache),
    )
    ctx.sfLog('reloadHistoryFromDb replace rows', {
      sessionKey: sk,
      rowCount: mergedRows.length,
      tail: ctx.sfSummarizeRowsTail(mergedRows),
      preservedLocalIncomplete: mergedRows !== result.rows,
    })
    ctx.replaceSessionRuntimeRowsFromHistory(sk, mergedRows)
    if (sk === String(ctx.selectedSessionKey || '').trim()) {
      // bypassCache 只保证重新拉库；合并结果与当前画面等价则不 setRows，
      // 避免流刚结束、DB 尚未写完时整页闪一下或被半截历史盖掉。
      ctx.setRows((prev) => (ctx.displayRowsEquivalent(prev, mergedRows) ? prev : mergedRows))
    }
  }
  return result
}
