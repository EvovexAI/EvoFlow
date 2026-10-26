import { useCallback, useRef } from 'react'

/**
 * 模态退场动画：React 条件渲染（open ? <Overlay/> : null）没有退场动画的根因
 * 是卸载由状态直接驱动。requestClose 先给 overlay 叠 --closing 淡出
 * （见 react-chat.css 的 .react-chat-modal-overlay--closing），动画结束后再
 * 真正调 onClose 让组件卸载。overlay 点击 / 关闭按钮 / Escape 都应走 requestClose。
 *
 * closing 期间 overlay 的 pointer-events 已被该类关掉，无需自行防重复点击；
 * closingRef 只是防 onClose 依赖变化导致的重复触发。
 */
export function useModalExit(onClose: () => void) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const closingRef = useRef(false)

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    const el = overlayRef.current
    if (!el) {
      onClose()
      return
    }
    closingRef.current = true
    el.classList.add('react-chat-modal-overlay--closing')
    window.setTimeout(() => {
      closingRef.current = false
      onClose()
    }, 140)
  }, [onClose])

  return { overlayRef, requestClose }
}
