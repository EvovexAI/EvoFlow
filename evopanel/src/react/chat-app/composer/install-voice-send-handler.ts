// @ts-nocheck — mechanical P146 extract.
/**
 * Register background voice → chat send bridge (once on mount).
 * Extracted from ChatApp.tsx (P146).
 */
export type InstallVoiceSendHandlerCtx = Record<string, any>

export function runVoiceSendHandlerEffect(ctx: InstallVoiceSendHandlerCtx): () => void {
  ctx.registerVoiceSendHandler(async (text, opts) => {
    if (opts?.global) {
      const sk = String(ctx.selectedSessionKey || ctx.sessionRef.current || '').trim()
      if (!sk) {
        await ctx.ensureChatSessionKeyRef.current?.()
      }
    }
    await ctx.handleVoiceTranscribedRef.current(text, opts)
  })
  return () => ctx.unregisterVoiceSendHandler()
}
