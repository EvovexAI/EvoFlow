// @ts-nocheck — mechanical P133 extract.
/**
 * Handlers for session-mode / activated-scenarios patching from the composer.
 * Extracted from ChatApp.tsx (P133).
 */
export type BuildScenarioSessionHandlersCtx = Record<string, any>

export function buildScenarioSessionHandlers(ctx: BuildScenarioSessionHandlersCtx) {
  return {
    sessionKey: String(ctx.selectedSessionKey || '').trim(),
    onSessionModeChange: (mode) => ctx.setSessionMode(mode),
    patchSessionScenarios: (sk: string, scenarios: string[]) => {
      ctx.wsClient.patchSessionActivatedScenarios(sk, scenarios)
      // sessionMode is the source of truth after v75; keep it in sync with
      // the new scenario selection so resolveSessionModeForOpenSession stays
      // consistent without waiting for the next API refresh.
      const derivedMode =
        scenarios.includes('plan') ? 'plan' : scenarios.includes('agent') ? 'agent' : 'ask'
      ctx.setSessions((prev) =>
        prev.map((s) =>
          String(s.sessionKey || '') === sk
            ? { ...s, activatedScenarios: scenarios, sessionMode: derivedMode }
            : s,
        ),
      )
    },
  }
}
