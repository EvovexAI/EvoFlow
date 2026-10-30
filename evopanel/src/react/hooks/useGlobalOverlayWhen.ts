import { useLayoutEffect } from 'react'
import { beginGlobalOverlay, endGlobalOverlay } from '../../lib/browser-embed-overlay.js'

/** 盖住聊天的弹层/下拉打开时隐藏原生浏览器 HWND（须在 paint 前 begin，否则一帧内仍被 HWND 压住）。 */
export function useGlobalOverlayWhen(open: boolean, reason: string) {
  useLayoutEffect(() => {
    if (!open) return
    beginGlobalOverlay(reason)
    return () => endGlobalOverlay(reason)
  }, [open, reason])
}
