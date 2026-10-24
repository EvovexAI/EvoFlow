// @ts-nocheck — mechanical P115 extract.
/**
 * Home surface window custom-event listeners. Extracted from ChatApp.tsx (P115).
 */
export type InstallHomeWindowListenersCtx = Record<string, any>

export function runHomeWindowListenersEffect(
  ctx: InstallHomeWindowListenersCtx,
): () => void {
  const homeCtx = {
    sessionRef: ctx.sessionRef,
    setSessionHadContent: ctx.setSessionHadContent,
    setPreferHomeDashboard: ctx.setPreferHomeDashboard,
    setSelectedSkills: ctx.setSelectedSkills,
    setSelectedPlugins: ctx.setSelectedPlugins,
    setModelName: (name: string) => ctx.setModelNameRef.current(name),
    setMemoryEnabled: ctx.setMemoryEnabled,
    setVoiceReplyEnabled: ctx.setVoiceReplyEnabled,
    ensureChatSessionKey: async () =>
      (await ctx.ensureChatSessionKeyRef.current?.()) || null,
    attachContextFiles: (files: unknown) => {
      ctx.attachContextFilesRef.current?.(files)
    },
    updateSessionContext: (sk: string, patch: Record<string, unknown>) =>
      ctx.wsClient.updateSessionContext(sk, patch),
    handleSend: (
      text: string,
      attachments?: unknown,
      ctxFiles?: unknown,
      opts?: unknown,
    ) => ctx.handleSendRef.current(text, attachments, ctxFiles, opts),
  }
  const onHomeSend = (event: Event) => ctx.handleHomeSendEvent(homeCtx, event)
  const onHomeSelectModel = (event: Event) => ctx.handleHomeSelectModelEvent(homeCtx, event)
  const onHomeSetMemory = (event: Event) => ctx.handleHomeSetMemoryEvent(homeCtx, event)
  const onHomeSetVoiceReply = (event: Event) =>
    ctx.handleHomeSetVoiceReplyEvent(homeCtx, event)
  window.addEventListener('evopanel:home-send', onHomeSend)
  window.addEventListener('evopanel:home-select-model', onHomeSelectModel)
  window.addEventListener('evopanel:home-set-memory', onHomeSetMemory)
  window.addEventListener('evopanel:home-set-voice-reply', onHomeSetVoiceReply)
  return () => {
    window.removeEventListener('evopanel:home-send', onHomeSend)
    window.removeEventListener('evopanel:home-select-model', onHomeSelectModel)
    window.removeEventListener('evopanel:home-set-memory', onHomeSetMemory)
    window.removeEventListener('evopanel:home-set-voice-reply', onHomeSetVoiceReply)
  }
}
