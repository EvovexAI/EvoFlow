import { useEffect } from 'react'

const MODAL_OVERLAY_SELECTOR = '.react-chat-modal-overlay'

export type UseModalEscapeCloseOptions = {
  /** When false, listener is not attached. Default true. */
  open?: boolean
  /**
   * Parent modals that may host nested tool-detail popups: skip ESC when another
   * overlay is stacked on top (e.g. tool result modal inside subagent transcript).
   */
  deferToNestedModal?: boolean
}

/** Close modal on Escape (capture phase, wins over side panels / bottom menus). */
export function useModalEscapeClose(
  onClose: () => void,
  options: UseModalEscapeCloseOptions = {},
): void {
  const { open = true, deferToNestedModal = false } = options

  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const overlayCount = document.querySelectorAll(MODAL_OVERLAY_SELECTOR).length
      if (deferToNestedModal && overlayCount > 1) return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose, deferToNestedModal])
}
