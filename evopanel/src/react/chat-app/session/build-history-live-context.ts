// @ts-nocheck — mechanical P137 extract.
/**
 * Build live-context bag passed into useThreadHistory for the selected session.
 * Extracted from ChatApp.tsx (P137).
 */
export type BuildHistoryLiveContextCtx = Record<string, any>

export function buildHistoryLiveContext(ctx: BuildHistoryLiveContextCtx) {
  const sk = String(ctx.selectedSessionKey || '').trim()
  const rt = sk ? ctx.getSessionRuntime(sk) : null
  const live = ctx.isSessionRuntimeLive(rt) || ctx.executingSessionKeys.has(sk)
  const sessionRow = sk ? ctx.sessions.find((s) => s.sessionKey === sk) : null
  return {
    isHot: live,
    liveRows: rt?.rows?.length ? rt.rows : null,
    liveSending: ctx.isTurnBusy(rt) || ctx.isSessionRuntimeLive(rt),
    currentRunId: sessionRow?.currentRunId || null,
    runStatus: sessionRow?.runStatus || null,
    getLive: () => {
      if (!sk) return null
      const cur = ctx.getSessionRuntime(sk)
      return {
        rows: cur.rows,
        live: ctx.isSessionRuntimeLive(cur) || ctx.executingSessionKeys.has(sk),
      }
    },
  }
}
