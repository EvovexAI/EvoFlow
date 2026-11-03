/**
 * 节点库 → 画布拖放载荷。
 * 不用 dataTransfer 自定义 MIME：Tauri/WebView2 上经常拖不动、drop 读不到。
 * 与 React Flow 官方 sidebar DnD 一样，用模块级状态。
 */
export type PaletteDragKind = 'agent-step' | 'template-step' | 'answer' | `agent:${string}`

let activeKind: PaletteDragKind | null = null
let dragMoved = false

export function beginPaletteDrag(kind: PaletteDragKind) {
  activeKind = kind
  dragMoved = false
}

export function markPaletteDragMoved() {
  dragMoved = true
}

export function endPaletteDrag() {
  activeKind = null
  dragMoved = false
}

export function getPaletteDragKind(): PaletteDragKind | null {
  return activeKind
}

/** 若本次是拖拽而非点击，返回 true（调用方应跳过 onClick 二次添加） */
export function consumePaletteDragClickGuard(): boolean {
  const wasDrag = dragMoved
  dragMoved = false
  return wasDrag
}

export function isPaletteDragKind(kind: string): kind is PaletteDragKind {
  return kind === 'agent-step' || kind === 'template-step' || kind === 'answer' || kind.startsWith('agent:')
}
