import { memo, useCallback, useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * 助手气泡划词操作菜单（对齐 ZCode SelectionActionMenu）：
 * 在气泡内选中文本后，在选区上方浮出「复制 / 引用追问」。
 * 引用通过 window 事件 `evopanel:composer-quote` 投递，由 ChatComposer 拼接草稿。
 */

type SelectionMenuState = {
  /** 选区中心 x（viewport 坐标，fixed 定位） */
  x: number
  /** 选区顶部 y */
  y: number
  /** 原始选中文本 */
  text: string
}

function AssistantSelectionMenuInner({
  containerRef,
  disabled = false,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  disabled?: boolean
}) {
  const [state, setState] = useState<SelectionMenuState | null>(null)

  const syncFromSelection = useCallback(() => {
    const el = containerRef.current
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (disabled || !el || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setState(null)
      return
    }
    const range = sel.getRangeAt(0)
    const node = range.commonAncestorContainer
    const host = node.nodeType === 1 ? (node as Element) : node.parentElement
    // 选区必须完全落在该气泡内
    if (!host || !el.contains(host)) {
      setState(null)
      return
    }
    const text = sel.toString()
    if (!text.trim()) {
      setState(null)
      return
    }
    const rect = range.getBoundingClientRect()
    if (!rect || (!rect.width && !rect.height)) {
      setState(null)
      return
    }
    setState({ x: rect.left + rect.width / 2, y: rect.top, text })
  }, [containerRef, disabled])

  useEffect(() => {
    if (disabled) {
      setState(null)
      return
    }
    document.addEventListener('selectionchange', syncFromSelection)
    window.addEventListener('scroll', () => setState(null), true)
    window.addEventListener('resize', () => setState(null))
    return () => {
      document.removeEventListener('selectionchange', syncFromSelection)
      window.removeEventListener('scroll', () => setState(null), true)
      window.removeEventListener('resize', () => setState(null))
    }
  }, [disabled, syncFromSelection])

  const close = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setState(null)
  }, [])

  const copySelected = useCallback(() => {
    if (!state) return
    navigator.clipboard.writeText(state.text).catch(() => {
      /* 剪贴板失败静默：菜单关闭，不阻塞 */
    })
    setState(null)
  }, [state])

  const quoteSelected = useCallback(() => {
    if (!state) return
    const quoted = state.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
    window.dispatchEvent(new CustomEvent('evopanel:composer-quote', { detail: { text: quoted } }))
    close()
  }, [state, close])

  if (!state || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="evf-sel-menu"
      role="toolbar"
      style={{ left: state.x, top: state.y }}
      // 菜单内按下不清空选区，否则点击时选区已消失
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="evf-sel-menu-btn" onClick={copySelected}>
        复制
      </button>
      <span className="evf-sel-menu-divider" aria-hidden="true" />
      <button type="button" className="evf-sel-menu-btn" onClick={quoteSelected}>
        引用追问
      </button>
    </div>,
    document.body,
  )
}

export const AssistantSelectionMenu = memo(AssistantSelectionMenuInner)
