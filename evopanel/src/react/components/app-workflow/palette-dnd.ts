/**
 * 节点库 → 画布拖放。
 *
 * Tauri/WebView2 上 HTML5 DnD 经常拖不动或 drop 读不到自定义 MIME。
 * 主路径：pointer 拖（阈值后跟手，在画布松手落下）。
 * 辅路径：仍写 text/plain + globalThis，兼容还能吃到原生 drop 的环境。
 */
export type PaletteDragKind = 'agent-step' | 'template-step' | 'answer' | `agent:${string}`

type PaletteDragState = {
  kind: PaletteDragKind | null
  moved: boolean
  /** pointer 拖进行中 */
  pointerActive: boolean
  pointerId: number | null
}

export type PaletteDropHandler = (
  kind: PaletteDragKind,
  clientX: number,
  clientY: number,
) => void

const GLOBAL_KEY = '__evoflowWfPaletteDrag'
const HANDLER_KEY = '__evoflowWfPaletteDropHandler'
const GHOST_ID = 'evoflow-wf-palette-ghost'

function dragState(): PaletteDragState {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: PaletteDragState }
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { kind: null, moved: false, pointerActive: false, pointerId: null }
  }
  return g[GLOBAL_KEY]!
}

export function setPaletteCanvasDropHandler(handler: PaletteDropHandler | null) {
  const g = globalThis as typeof globalThis & { [HANDLER_KEY]?: PaletteDropHandler | null }
  g[HANDLER_KEY] = handler
}

function getDropHandler(): PaletteDropHandler | null {
  const g = globalThis as typeof globalThis & { [HANDLER_KEY]?: PaletteDropHandler | null }
  return g[HANDLER_KEY] || null
}

export function beginPaletteDrag(kind: PaletteDragKind) {
  const s = dragState()
  s.kind = kind
  s.moved = false
}

export function markPaletteDragMoved() {
  dragState().moved = true
}

export function endPaletteDrag() {
  const s = dragState()
  s.kind = null
  s.moved = false
  s.pointerActive = false
  s.pointerId = null
  removeGhost()
}

export function getPaletteDragKind(): PaletteDragKind | null {
  return dragState().kind
}

/** 若本次是拖拽而非点击，返回 true（调用方应跳过 onClick 二次添加） */
export function consumePaletteDragClickGuard(): boolean {
  const s = dragState()
  const wasDrag = s.moved
  s.moved = false
  return wasDrag
}

export function isPaletteDragKind(kind: string): kind is PaletteDragKind {
  return (
    kind === 'agent-step' ||
    kind === 'template-step' ||
    kind === 'answer' ||
    kind.startsWith('agent:')
  )
}

/** 写入 dataTransfer：仅 text/plain，避免 WebView2 拒拖自定义 MIME */
export function writePaletteDragTransfer(dt: DataTransfer, kind: PaletteDragKind) {
  try {
    dt.setData('text/plain', `evoflow-wf:${kind}`)
    // 部分 WebView 只认 Text
    dt.setData('Text', `evoflow-wf:${kind}`)
    dt.effectAllowed = 'copyMove'
  } catch {
    /* setData 失败仍靠 pointer / global */
  }
}

/** 从 drop 的 dataTransfer 兜底读 kind（优先 global） */
export function readPaletteDragKind(dt?: DataTransfer | null): string {
  const fromMem = getPaletteDragKind()
  if (fromMem) return fromMem
  if (!dt) return ''
  try {
    const plain = String(dt.getData('text/plain') || dt.getData('Text') || '').trim()
    if (plain.startsWith('evoflow-wf:')) return plain.slice('evoflow-wf:'.length)
  } catch {
    /* ignore */
  }
  return ''
}

/** dragover 时能否放行：有 global kind，或 types 里有我们的 text/plain */
export function isPaletteDragActive(dt?: DataTransfer | null): boolean {
  if (getPaletteDragKind()) return true
  if (dragState().pointerActive) return true
  if (!dt) return false
  try {
    const types = Array.from(dt.types || [])
    return types.includes('text/plain') || types.includes('Text') || types.includes('text')
  } catch {
    return false
  }
}

function removeGhost() {
  document.getElementById(GHOST_ID)?.remove()
}

function moveGhost(clientX: number, clientY: number, label: string) {
  let el = document.getElementById(GHOST_ID) as HTMLDivElement | null
  if (!el) {
    el = document.createElement('div')
    el.id = GHOST_ID
    el.setAttribute('aria-hidden', 'true')
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '10080',
      pointerEvents: 'none',
      padding: '6px 10px',
      borderRadius: '8px',
      fontSize: '12px',
      fontWeight: '600',
      color: 'var(--text-primary, #111)',
      background: 'var(--bg-card, #fff)',
      border: '1px solid var(--border-primary, #e5e7eb)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      maxWidth: '200px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    } as CSSStyleDeclaration)
    document.body.appendChild(el)
  }
  el.textContent = label
  el.style.left = `${clientX + 12}px`
  el.style.top = `${clientY + 12}px`
}

function isOverCanvas(clientX: number, clientY: number): boolean {
  const el = document.elementFromPoint(clientX, clientY)
  if (!el || !(el instanceof Element)) return false
  return Boolean(el.closest('.app-rf-flow-wrap, .react-flow'))
}

function setCanvasDragOverVisual(on: boolean) {
  document.querySelectorAll('.app-rf-flow-wrap').forEach((node) => {
    node.classList.toggle('is-drag-over', on)
  })
}

const MOVE_THRESHOLD_PX = 6

/**
 * 绑到节点库行：pointer 拖到画布松手即落下；未移动则交给 onClick。
 * 返回 cleanup（一般随 React effect / 组件卸载不必，监听在 window 上一次拖完自拆）。
 */
export function startPalettePointerDrag(opts: {
  kind: PaletteDragKind
  label: string
  pointerId: number
  startX: number
  startY: number
  /** 未移动松手时回调（等同点击添加） */
  onTap?: () => void
}) {
  const { kind, label, pointerId, startX, startY, onTap } = opts
  const s = dragState()
  s.kind = kind
  s.moved = false
  s.pointerActive = true
  s.pointerId = pointerId

  let dragging = false

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!dragging && dx * dx + dy * dy >= MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) {
      dragging = true
      s.moved = true
    }
    if (!dragging) return
    e.preventDefault()
    moveGhost(e.clientX, e.clientY, label)
    setCanvasDragOverVisual(isOverCanvas(e.clientX, e.clientY))
  }

  const finish = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', finish, true)
    window.removeEventListener('pointercancel', finish, true)
    removeGhost()
    setCanvasDragOverVisual(false)

    const wasDragging = dragging
    const x = e.clientX
    const y = e.clientY
    const over = isOverCanvas(x, y)
    const handler = getDropHandler()

    if (wasDragging && over && handler && isPaletteDragKind(kind)) {
      handler(kind, x, y)
      endPaletteDrag()
      return
    }

    if (!wasDragging) {
      endPaletteDrag()
      onTap?.()
      return
    }

    // 拖了但没落到画布：只清状态
    endPaletteDrag()
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', finish, true)
}
