/** 在锚点上方显示浮动菜单（侧栏 ··· 菜单 / 右键菜单） */
export function positionMenuAboveAnchor(
  anchorRect: DOMRect,
  menuWidth: number,
  menuHeight: number,
  opts?: { gap?: number; preferAbove?: boolean },
): { left: number; top: number } {
  const gap = opts?.gap ?? 6
  const preferAbove = opts?.preferAbove !== false
  const mw = Math.max(menuWidth, 1)
  const mh = Math.max(menuHeight, 1)

  let left = anchorRect.right - mw
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8))

  let top = preferAbove ? anchorRect.top - mh - gap : anchorRect.bottom + gap
  if (preferAbove && top < 8) {
    top = anchorRect.bottom + gap
  }
  top = Math.max(8, Math.min(top, window.innerHeight - mh - 8))
  return { left, top }
}

export function positionMenuAbovePoint(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  opts?: { gap?: number },
): { left: number; top: number } {
  const gap = opts?.gap ?? 6
  const mw = Math.max(menuWidth, 1)
  const mh = Math.max(menuHeight, 1)
  let left = x
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8))
  let top = y - mh - gap
  top = Math.max(8, Math.min(top, window.innerHeight - mh - 8))
  return { left, top }
}
