/**
 * Ensure a chat session key exists (create if composer has none).
 * Extracted from ChatApp.tsx (P65).
 */
export type EnsureChatSessionKeyCtx = {
  sessionRef: { current: string }
  selectedSessionKey: string
  setNewChatButtonActive: (v: boolean) => void
  resolveWorkspaceForNewSession: () => string | null
  coalesceCreateSession: (
    fn: () => Promise<string | null>,
  ) => Promise<string | null>
  createSessionForChat: (opts?: { workspaceRoot?: string | null }) => Promise<string | null>
}

export async function ensureChatSessionKey(
  ctx: EnsureChatSessionKeyCtx,
): Promise<string | null> {
  const existing = (ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  if (existing) return existing
  ctx.setNewChatButtonActive(true)
  const wsHint = ctx.resolveWorkspaceForNewSession()
  return ctx.coalesceCreateSession(() =>
    ctx.createSessionForChat({ workspaceRoot: wsHint }),
  )
}
