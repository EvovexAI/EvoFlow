// @ts-nocheck — mechanical P130 extract.
/**
 * Click-outside dismiss for session 「···」 menus (document click, not mousedown).
 * Extracted from ChatApp.tsx (P130).
 */
export type InstallMoreMenuDismissCtx = Record<string, any>

export function runMoreMenuDismissEffect(ctx: InstallMoreMenuDismissCtx): (() => void) | void {
  if (!ctx.moreMenuKey) return
  const onClick = (e: MouseEvent) => {
    const target =
      e.target instanceof Element
        ? e.target
        : (e.target as Node | null)?.parentElement ?? null
    if (!target) return
    if (
      target.closest(
        '[data-session-more-root], .modal-overlay, .react-chat-session-more-menu, .react-chat-session-context-menu',
      )
    ) {
      return
    }
    ctx.setMoreMenuKey(null)
  }
  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
