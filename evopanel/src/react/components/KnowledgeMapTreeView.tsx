import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  buildKnowledgeMapTree,
  countProcessingNodes,
  formatNodeActivityLabel,
  nodeDisplayTitle,
  nodeStatusLabel,
  normalizeNodeStatus,
  sortProcessingNodes,
} from '../../lib/knowledge-map-tree.js'
import {
  diagramTypeLabel,
  nodeHasDiagram,
  resolveNodeDiagramType,
} from '../../lib/knowledge-map-diagram.js'
import { canUserEditNodeStatus, isCollapsedNodeStatus, shouldDisplayNodeStatus } from '../../lib/knowledge-map-node-status.js'
import { layoutXmindMindMap } from '../../lib/knowledge-map-xmind-layout.js'
import type { KnowledgeMapEdge, KnowledgeMapNode } from '../hooks/useKnowledgeMap.js'
import { KnowledgeMapNodeBodyContent } from './KnowledgeMapNodeBodyContent.js'
import {
  KnowledgeMapNodeStatusMenu,
  statusMenuAnchorFromElement,
  statusMenuAnchorFromPoint,
} from './KnowledgeMapNodeStatusMenu.js'
import type { StatusMenuAnchor } from './KnowledgeMapNodeStatusMenu.js'

const MIN_ZOOM = 0.35
const MAX_ZOOM = 2
const ZOOM_STEP = 0.1
const FALLBACK_ZOOM_PANEL = 0.68
const FALLBACK_ZOOM_MODAL = 0.82
const NOTE_BRANCH_AUTO_COLLAPSE = 6
const MAX_NOTE_PREVIEW = 5
const PAN_CLICK_SUPPRESS_PX = 4

const KIND_LEGEND: { kind: string; label: string }[] = [
  { kind: 'flow', label: '链路' },
  { kind: 'gap', label: '待查' },
  { kind: 'file', label: '文件' },
  { kind: 'diagram', label: '图表' },
  { kind: 'note', label: '事项' },
  { kind: 'processing', label: '进行中' },
]

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

function computeFitZoom(
  wrap: HTMLElement,
  layoutWidth: number,
  layoutHeight: number,
  fallback: number,
): number {
  if (layoutWidth <= 0 || layoutHeight <= 0) return fallback
  const pad = 32
  const sx = (wrap.clientWidth - pad) / layoutWidth
  const sy = (wrap.clientHeight - pad) / layoutHeight
  if (sx <= 0 || sy <= 0) return fallback
  return clampZoom(Math.min(sx, sy, 1) * 0.9)
}

interface LayoutBounds {
  x: number
  y: number
  width: number
  height: number
}

function computeBoundsFitZoom(
  wrap: HTMLElement,
  bounds: LayoutBounds,
  fallback: number,
  opts?: { maxZoom?: number },
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return fallback
  const pad = 40
  const sx = (wrap.clientWidth - pad) / bounds.width
  const sy = (wrap.clientHeight - pad) / bounds.height
  if (sx <= 0 || sy <= 0) return fallback
  const maxZ = opts?.maxZoom ?? 1.35
  return clampZoom(Math.min(sx, sy, maxZ))
}

function buildParentMap(tree: ReturnType<typeof buildKnowledgeMapTree>): Map<string, string> {
  const parentOf = new Map<string, string>()
  for (const [parentId, childIds] of tree.childrenOf.entries()) {
    for (const childId of childIds) {
      parentOf.set(childId, parentId)
    }
  }
  return parentOf
}

function processingLayoutBounds(
  layoutNodes: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  processingIds: Set<string>,
): LayoutBounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (const ln of layoutNodes) {
    const id = ln.id
    if (!processingIds.has(id)) continue
    minX = Math.min(minX, ln.x)
    minY = Math.min(minY, ln.y)
    maxX = Math.max(maxX, ln.x + ln.width)
    maxY = Math.max(maxY, ln.y + ln.height)
    count += 1
  }
  if (!count || !Number.isFinite(minX)) return null
  const pad = 56
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  }
}

function scrollViewportToBounds(
  wrap: HTMLElement,
  bounds: LayoutBounds,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const cx = (bounds.x + bounds.width / 2) * zoom
  const cy = (bounds.y + bounds.height / 2) * zoom
  wrap.scrollLeft = Math.max(0, Math.min(cx - wrap.clientWidth / 2, canvasWidth * zoom - wrap.clientWidth))
  wrap.scrollTop = Math.max(0, Math.min(cy - wrap.clientHeight / 2, canvasHeight * zoom - wrap.clientHeight))
}

function scrollViewportToCanvasCenter(
  wrap: HTMLElement,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const scaledW = canvasWidth * zoom
  const scaledH = canvasHeight * zoom
  wrap.scrollLeft = Math.max(0, (scaledW - wrap.clientWidth) / 2)
  wrap.scrollTop = Math.max(0, (scaledH - wrap.clientHeight) / 2)
}

function expandCollapsedForProcessingIds(
  collapsed: Set<string>,
  tree: ReturnType<typeof buildKnowledgeMapTree>,
  processingIds: string[],
): Set<string> {
  if (!processingIds.length) return collapsed
  const next = new Set(collapsed)
  const parentOf = buildParentMap(tree)
  for (const rawId of processingIds) {
    let cur = String(rawId || '').trim()
    const walked = new Set<string>()
    while (cur && cur !== tree.rootId) {
      if (walked.has(cur)) break
      walked.add(cur)
      next.delete(cur)
      cur = parentOf.get(cur) || ''
    }
  }
  return next
}

interface TopicDetailPayload {
  id: string
  title: string
  body: string
  kind: string
  status: string
  activityAt?: string
  activityLabel?: string
  node?: KnowledgeMapNode | Record<string, unknown>
}

interface TopicDetailPopover extends TopicDetailPayload {
  left: number
  top: number
}

function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  b: DOMRect,
  pad = 8,
): boolean {
  const bx = b.left - pad
  const by = b.top - pad
  const bw = b.width + pad * 2
  const bh = b.height + pad * 2
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

function computeSafePopoverPosition(
  nodeEl: HTMLElement,
  wrapEl: HTMLElement,
  opts?: { reserveRight?: number },
): { left: number; top: number } {
  const popoverWidth = 280
  const popoverMaxHeight = Math.min(320, window.innerHeight - 24)
  const reserveRight = opts?.reserveRight ?? 0
  const wrapRect = wrapEl.getBoundingClientRect()
  const nodeRect = nodeEl.getBoundingClientRect()
  const candidates = [
    { left: wrapRect.left + 10, top: wrapRect.top + 10 },
    { left: wrapRect.right - reserveRight - popoverWidth - 10, top: wrapRect.top + 10 },
    { left: wrapRect.left + 10, top: wrapRect.bottom - popoverMaxHeight - 10 },
    { left: wrapRect.right - reserveRight - popoverWidth - 10, top: wrapRect.bottom - popoverMaxHeight - 10 },
  ]
  for (const pos of candidates) {
    if (!rectsOverlap(pos.left, pos.top, popoverWidth, popoverMaxHeight, nodeRect)) {
      return pos
    }
  }
  return candidates[0]
}

function isMindMapPanBlocker(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  return Boolean(
    target.closest(
      'button, .km-mind-toggle, .km-mind-collapsed-hint, .km-mind-expand-btn, .km-xmind-processing-panel, a, input, textarea, select',
    ),
  )
}

function collectBranchIds(
  tree: ReturnType<typeof buildKnowledgeMapTree>,
  id: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(id)) return []
  seen.add(id)
  const children = tree.childrenOf.get(id) || []
  if (!children.length) return []
  const ids: string[] = [id]
  for (const childId of children) {
    ids.push(...collectBranchIds(tree, childId, seen))
  }
  return ids
}

function defaultCollapsedIds(tree: ReturnType<typeof buildKnowledgeMapTree>): Set<string> {
  const collapsed = new Set<string>()
  const noteBranch = '__km_kind__note'
  const noteChildren = tree.childrenOf.get(noteBranch) || []
  if (noteChildren.length >= NOTE_BRANCH_AUTO_COLLAPSE) {
    collapsed.add(noteBranch)
  }
  return collapsed
}

export interface KnowledgeMapTreeViewProps {
  goal: string
  nodes: KnowledgeMapNode[]
  edges: KnowledgeMapEdge[]
  /** panel = sidebar; modal = fullscreen dialog with more vertical space */
  layout?: 'panel' | 'modal'
  onPatchNodeStatus?: (nodeId: string, status: string) => Promise<void>
}

interface StatusMenuState {
  nodeId: string
  status: string
  anchor: StatusMenuAnchor
}

export function KnowledgeMapTreeView({
  goal,
  nodes,
  edges,
  layout = 'panel',
  onPatchNodeStatus,
}: KnowledgeMapTreeViewProps) {
  const isModalLayout = layout === 'modal'
  const visibleNodes = useMemo(
    () => nodes.filter((n) => !isCollapsedNodeStatus(n.status)),
    [nodes],
  )
  const tree = useMemo(
    // @ts-ignore — KnowledgeMapNode[] is structurally compatible with Record<string, unknown>[]
    () => buildKnowledgeMapTree({ goal, nodes: visibleNodes, edges }),
    [goal, visibleNodes, edges],
  )
  const branchIds = useMemo(() => collectBranchIds(tree, tree.rootId), [tree])
  const [notesExpanded, setNotesExpanded] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => defaultCollapsedIds(tree))
  const [detailPopover, setDetailPopover] = useState<TopicDetailPopover | null>(null)
  const [statusMenu, setStatusMenu] = useState<StatusMenuState | null>(null)
  const [statusSaving, setStatusSaving] = useState(false)
  const [processingPanelOpen, setProcessingPanelOpen] = useState(true)
  const [activeProcessingId, setActiveProcessingId] = useState<string | null>(null)
  const processingPanelDismissedRef = useRef(false)
  const prevProcessingCountRef = useRef(0)
  const processingPanelItemRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const fallbackZoom = isModalLayout ? FALLBACK_ZOOM_MODAL : FALLBACK_ZOOM_PANEL
  const [zoom, setZoom] = useState(fallbackZoom)
  const fitZoomRef = useRef(fallbackZoom)
  const [isPanning, setIsPanning] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const didCenterRef = useRef(false)
  const panSessionRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null)
  const suppressClickRef = useRef(false)

  const getVisibleChildren = useCallback(
    (id: string) => {
      const children = tree.childrenOf.get(id) || []
      if (collapsedIds.has(id)) return []
      const isNoteBranch = id === '__km_kind__note'
      if (isNoteBranch && !notesExpanded && children.length > MAX_NOTE_PREVIEW) {
        return children.slice(0, MAX_NOTE_PREVIEW)
      }
      return children
    },
    [tree, collapsedIds, notesExpanded],
  )

  const xmindLayout = useMemo(
    () => layoutXmindMindMap(tree, { collapsedIds, getVisibleChildren }),
    [tree, collapsedIds, getVisibleChildren],
  )

  const noteBranchHiddenCount = useMemo(() => {
    const noteBranch = '__km_kind__note'
    const children = tree.childrenOf.get(noteBranch) || []
    if (notesExpanded || collapsedIds.has(noteBranch)) return 0
    return Math.max(0, children.length - MAX_NOTE_PREVIEW)
  }, [tree, notesExpanded, collapsedIds])

  const processingCount = useMemo(() => countProcessingNodes(nodes), [nodes])

  const openStatusMenu = useCallback(
    (nodeId: string, currentStatus: string, anchor: StatusMenuAnchor) => {
      if (!onPatchNodeStatus || !canUserEditNodeStatus(nodeId, String(tree.byId.get(nodeId)?.kind ?? ''))) return
      setStatusMenu({ nodeId, status: currentStatus, anchor })
    },
    [onPatchNodeStatus, tree],
  )

  const handleStatusSelect = useCallback(
    async (nextStatus: string) => {
      if (!statusMenu || !onPatchNodeStatus) return
      setStatusSaving(true)
      try {
        await onPatchNodeStatus(statusMenu.nodeId, nextStatus)
        setStatusMenu(null)
        if (detailPopover?.id === statusMenu.nodeId) {
          setDetailPopover(null)
        }
      } finally {
        setStatusSaving(false)
      }
    },
    [statusMenu, onPatchNodeStatus, detailPopover?.id],
  )

  const buildDetailPayload = useCallback(
    (nodeId: string): TopicDetailPayload | null => {
      const id = String(nodeId || '').trim()
      if (!id || tree.isSynthetic(id) || id === tree.rootId) return null
      const node = tree.byId.get(id)
      if (!node) return null
      const kind = String(node?.kind || 'note').toLowerCase()
      const title = nodeDisplayTitle(node, id)
      const body = String(node?.body || '').trim()
      const status = normalizeNodeStatus(node?.status as string | null | undefined)
      const showStatus = shouldDisplayNodeStatus(kind, id) && Boolean(status && status !== 'collapsed')
      const hasDiagram = nodeHasDiagram(node)
      const showBody = Boolean((body && body !== title) || hasDiagram)
      const activityAt = String(node?.updated_at || node?.created_at || '').trim()
      return {
        id,
        title,
        body: showBody ? body : '',
        kind: tree.kindLabel(kind),
        status: showStatus ? nodeStatusLabel(status) : '',
        activityAt: activityAt || undefined,
        activityLabel: formatNodeActivityLabel(node) || undefined,
        node,
      }
    },
    [tree],
  )

  const processingItems = useMemo(() => {
    return sortProcessingNodes(nodes)
      .map((n) => {
        const id = String(n.external_id || '').trim()
        return id ? buildDetailPayload(id) : null
      })
      .filter((item): item is TopicDetailPayload => Boolean(item))
  }, [nodes, buildDetailPayload])

  const setProcessingPanelVisible = useCallback((visible: boolean) => {
    processingPanelDismissedRef.current = !visible
    setProcessingPanelOpen(visible)
    if (!visible) setActiveProcessingId(null)
  }, [])

  useEffect(() => {
    const prev = prevProcessingCountRef.current
    prevProcessingCountRef.current = processingCount
    if (processingCount <= 0) {
      processingPanelDismissedRef.current = false
      return
    }
    if (prev === 0) {
      processingPanelDismissedRef.current = false
    }
    if (!processingPanelDismissedRef.current) {
      setProcessingPanelOpen(true)
    }
  }, [processingCount])

  useEffect(() => {
    if (processingCount <= 0) {
      // Defer state update to avoid cascading renders
      requestAnimationFrame(() => {
        setActiveProcessingId(null)
      })
      return
    }
    requestAnimationFrame(() => {
      setActiveProcessingId((prev) => {
        if (prev && processingItems.some((item) => item.id === prev)) return prev
        return null
      })
    })
  }, [processingCount, processingItems])

  const processingNodeIds = useMemo(
    () => sortProcessingNodes(nodes).map((n) => String(n.external_id || '').trim()).filter(Boolean),
    [nodes],
  )

  const processingIdSet = useMemo(() => new Set(processingNodeIds), [processingNodeIds])

  const fullFitZoomRef = useRef(fallbackZoom)

  useEffect(() => {
    if (!processingNodeIds.length) return
    // Defer state updates to avoid cascading renders
    requestAnimationFrame(() => {
      setCollapsedIds((prev) => expandCollapsedForProcessingIds(prev, tree, processingNodeIds))
      if (processingNodeIds.some((id) => id.startsWith('note:') || tree.byId.get(id)?.kind === 'note')) {
        setNotesExpanded(true)
      }
    })
  }, [processingNodeIds, tree])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      setZoom((prev) => clampZoom(prev + delta))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // hasContent is defined after all hooks (before early return), so it can't be
    // referenced here directly (TDZ). goal + nodes.length are the underlying signals:
    // when data arrives they change, re-running this effect so the listener attaches
    // to the now-rendered wrap element.
  }, [goal, nodes.length])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const session = panSessionRef.current
      const wrap = wrapRef.current
      if (!session || !wrap) return
      const dx = event.clientX - session.x
      const dy = event.clientY - session.y
      if (Math.abs(dx) > PAN_CLICK_SUPPRESS_PX || Math.abs(dy) > PAN_CLICK_SUPPRESS_PX) {
        suppressClickRef.current = true
      }
      wrap.scrollLeft = session.scrollLeft - dx
      wrap.scrollTop = session.scrollTop - dy
    }

    const endPan = () => {
      if (!panSessionRef.current) return
      panSessionRef.current = null
      setIsPanning(false)
      if (suppressClickRef.current) {
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', endPan)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', endPan)
    }
  }, [])

  const handleCanvasBackgroundClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('.km-xmind-topic, button, a, input, textarea, select')) return
    setActiveProcessingId(null)
  }, [])

  const handlePanMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (isMindMapPanBlocker(event.target)) return
    const wrap = wrapRef.current
    if (!wrap) return
    event.preventDefault()
    panSessionRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
    }
    setIsPanning(true)
  }, [])

  const openDetailPopover = useCallback(
    (el: HTMLElement, payload: TopicDetailPayload) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const reserveRight = 0
      const { left, top } = computeSafePopoverPosition(el, wrap, { reserveRight })
      setActiveProcessingId(null)
      setDetailPopover({ ...payload, left, top })
    },
    [],
  )

  const focusNodeOnCanvas = useCallback(
    (nodeId: string) => {
      const id = String(nodeId || '').trim()
      if (!id) return
      setActiveProcessingId(id)
      setDetailPopover(null)
      const wrap = wrapRef.current
      if (!wrap) return
      const ln = xmindLayout.nodes.find((n) => n.id === id)
      if (!ln) return
      const pad = 48
      const bounds: LayoutBounds = {
        x: ln.x - pad,
        y: ln.y - pad,
        width: ln.width + pad * 2,
        height: ln.height + pad * 2,
      }
      const fitAll = computeFitZoom(wrap, xmindLayout.width, xmindLayout.height, fallbackZoom)
      const focusZoom = computeBoundsFitZoom(wrap, bounds, fitAll, { maxZoom: Math.max(fitAll, 1.2) })
      fitZoomRef.current = focusZoom
      setZoom(focusZoom)
      requestAnimationFrame(() => {
        scrollViewportToBounds(wrap, bounds, focusZoom, xmindLayout.width, xmindLayout.height)
        processingPanelItemRefs.current[id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    },
    [xmindLayout.nodes, xmindLayout.width, xmindLayout.height, fallbackZoom],
  )

  useEffect(() => {
    if (!isModalLayout) return
    // Defer state updates to avoid cascading renders
    requestAnimationFrame(() => {
      setCollapsedIds(new Set())
      setNotesExpanded(true)
    })
  }, [isModalLayout, tree])

  useEffect(() => {
    didCenterRef.current = false
    fullFitZoomRef.current = fallbackZoom
    fitZoomRef.current = fallbackZoom
  }, [goal, nodes.length, fallbackZoom])

  const applyProcessingFocus = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || xmindLayout.width <= 0 || xmindLayout.height <= 0) return false
    const bounds = processingLayoutBounds(xmindLayout.nodes, processingIdSet)
    if (!bounds) return false
    const fitAll = computeFitZoom(wrap, xmindLayout.width, xmindLayout.height, fallbackZoom)
    fullFitZoomRef.current = fitAll
    const focusZoom = computeBoundsFitZoom(wrap, bounds, fitAll, { maxZoom: Math.max(fitAll, 1.05) })
    fitZoomRef.current = focusZoom
    setZoom(focusZoom)
    requestAnimationFrame(() => {
      scrollViewportToBounds(wrap, bounds, focusZoom, xmindLayout.width, xmindLayout.height)
    })
    return true
  }, [xmindLayout.width, xmindLayout.height, xmindLayout.nodes, processingIdSet, fallbackZoom])

  const applyFullCanvasView = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || xmindLayout.width <= 0 || xmindLayout.height <= 0) return
    const fit = computeFitZoom(wrap, xmindLayout.width, xmindLayout.height, fallbackZoom)
    fullFitZoomRef.current = fit
    fitZoomRef.current = fit
    setZoom(fit)
    requestAnimationFrame(() => {
      scrollViewportToCanvasCenter(wrap, fit, xmindLayout.width, xmindLayout.height)
    })
  }, [xmindLayout.width, xmindLayout.height, fallbackZoom])

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || didCenterRef.current || xmindLayout.width <= 0 || xmindLayout.height <= 0) return
    const fit = computeFitZoom(wrap, xmindLayout.width, xmindLayout.height, fallbackZoom)
    fullFitZoomRef.current = fit
    fitZoomRef.current = fit
    setZoom(fit)
    requestAnimationFrame(() => {
      scrollViewportToCanvasCenter(wrap, fit, xmindLayout.width, xmindLayout.height)
      didCenterRef.current = true
    })
  }, [xmindLayout.width, xmindLayout.height, goal, nodes.length, fallbackZoom])

  useEffect(() => {
    if (!detailPopover) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailPopover(null)
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest('.km-xmind-detail-popover')) return
      if (target.closest('.km-xmind-processing-panel')) return
      setDetailPopover(null)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [detailPopover])

  const zoomIn = useCallback(() => setZoom((prev) => clampZoom(prev + ZOOM_STEP)), [])
  const zoomOut = useCallback(() => setZoom((prev) => clampZoom(prev - ZOOM_STEP)), [])
  const resetZoom = useCallback(() => {
    if (activeProcessingId) {
      focusNodeOnCanvas(activeProcessingId)
      return
    }
    applyFullCanvasView()
  }, [activeProcessingId, focusNodeOnCanvas, applyFullCanvasView])
  const focusProcessing = useCallback(() => {
    applyProcessingFocus()
    setProcessingPanelVisible(true)
  }, [applyProcessingFocus, setProcessingPanelVisible])

  const toggleBranch = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    setCollapsedIds(new Set())
    setNotesExpanded(true)
  }, [])

  const collapseAll = useCallback(() => {
    setCollapsedIds(new Set(branchIds.filter((id) => id !== tree.rootId)))
    setDetailPopover(null)
  }, [branchIds, tree.rootId])

  const hasContent = Boolean(goal || nodes.length > 0)
  if (!hasContent) {
    return <div className="collab-exec-dag-empty">暂无思维导图节点</div>
  }

  const collapsedCount = collapsedIds.size

  const renderTopic = (layoutNode: (typeof xmindLayout.nodes)[number]) => {
    const id = layoutNode.id
    const synthetic = tree.isSynthetic(id)
    const node = synthetic ? null : tree.byId.get(id)
    const isRoot = id === tree.rootId
    const isNoteBranch = id === '__km_kind__note'
    const childCount = (tree.childrenOf.get(id) || []).length
    const isPopoverOpen = detailPopover?.id === id
    const isProcessingActive = activeProcessingId === id

    const kind = synthetic
      ? isRoot
        ? 'goal'
        : id.replace('__km_kind__', '')
      : String(node?.kind || 'note').toLowerCase()

    const title = synthetic ? tree.syntheticLabel(id) : nodeDisplayTitle(node, id)
    const body = synthetic ? '' : String(node?.body || '').trim()
    const status = synthetic ? '' : normalizeNodeStatus(node?.status as string | null | undefined)
    const isProcessing = !synthetic && !isRoot && processingNodeIds.includes(id)
    const hasDiagram = !synthetic && nodeHasDiagram(node)
    const statusTracked = !synthetic && !isRoot && shouldDisplayNodeStatus(kind, id)
    const showStatus = Boolean(statusTracked && status && status !== 'collapsed')
    const statusLabel = showStatus ? nodeStatusLabel(status) : ''
    const statusEditable =
      !synthetic && canUserEditNodeStatus(id, kind) && Boolean(onPatchNodeStatus)
    const showBody = !synthetic && body && body !== title
    const canExpandDetail = !synthetic && (showBody || hasDiagram || (!isRoot && Boolean(id)))
    const diagramBadge = hasDiagram ? diagramTypeLabel(resolveNodeDiagramType(node)) : ''
    const isMainTopic = !isRoot && layoutNode.depth === 1
    const isSubTopic = !isRoot && layoutNode.depth >= 2

    const handleCardClick = (event: ReactMouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) return
      if (synthetic && layoutNode.hasChildren) {
        toggleBranch(id)
        return
      }
      if (canExpandDetail) {
        if (isProcessing) {
          focusNodeOnCanvas(id)
          return
        }
        const payload = buildDetailPayload(id)
        if (payload) openDetailPopover(event.currentTarget, payload)
      }
    }

    const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (synthetic && layoutNode.hasChildren) {
        toggleBranch(id)
        return
      }
      if (canExpandDetail) {
        if (isProcessing) {
          focusNodeOnCanvas(id)
          return
        }
        const payload = buildDetailPayload(id)
        if (payload) openDetailPopover(event.currentTarget, payload)
      }
    }

    const toggleSide = layoutNode.side === 'left' ? 'left' : 'right'

    return (
      <div
        key={id}
        className={`km-xmind-topic${isRoot ? ' is-root' : ''}${isMainTopic ? ' is-main' : ''}${isSubTopic ? ' is-sub' : ''}${isPopoverOpen ? ' is-popover-open' : ''}${isProcessingActive ? ' is-processing-active' : ''}${canExpandDetail || (synthetic && layoutNode.hasChildren) ? ' is-interactive' : ''}${layoutNode.collapsed ? ' is-collapsed' : ''}${isProcessing ? ' is-processing' : ''}`}
        data-kind={kind}
        data-side={layoutNode.side}
        data-status={showStatus ? status : undefined}
        data-km-node-id={!synthetic ? id : undefined}
        data-has-body={showBody || hasDiagram ? 'true' : undefined}
        data-has-diagram={hasDiagram ? 'true' : undefined}
        style={{
          left: layoutNode.x,
          top: layoutNode.y,
          width: layoutNode.width,
          height: layoutNode.height,
        }}
        title={title}
        onClick={canExpandDetail || (synthetic && layoutNode.hasChildren) ? handleCardClick : undefined}
        onContextMenu={
          statusEditable
            ? (e) => {
                e.preventDefault()
                openStatusMenu(
                  id,
                  status,
                  statusMenuAnchorFromPoint(e.clientX, e.clientY, 'auto'),
                )
              }
            : undefined
        }
        onKeyDown={
          canExpandDetail || (synthetic && layoutNode.hasChildren) ? handleCardKeyDown : undefined
        }
        role={canExpandDetail || (synthetic && layoutNode.hasChildren) ? 'button' : undefined}
        tabIndex={canExpandDetail || (synthetic && layoutNode.hasChildren) ? 0 : undefined}
        aria-expanded={canExpandDetail ? isPopoverOpen : undefined}
      >
        <div className="km-xmind-topic-inner">
          <div className="km-xmind-topic-head">
            {isProcessing ? (
              <span className="km-xmind-topic-status-light" aria-hidden="true" title={statusLabel} />
            ) : null}
            <span className="km-xmind-topic-title">{title}</span>
            {hasDiagram ? (
              <span className="km-xmind-topic-diagram-badge" title={diagramBadge}>
                {diagramBadge}
              </span>
            ) : null}
          </div>
          {showStatus ? (
            statusEditable ? (
              <button
                type="button"
                className="km-xmind-topic-status km-xmind-topic-status-btn"
                title="点击修改状态"
                onClick={(e) => {
                  e.stopPropagation()
                  openStatusMenu(id, status, statusMenuAnchorFromElement(e.currentTarget, 'left'))
                }}
              >
                {statusLabel}
              </button>
            ) : (
              <span className="km-xmind-topic-status">{statusLabel}</span>
            )
          ) : null}
        </div>
        {canExpandDetail ? <span className="km-xmind-topic-more" aria-hidden="true" /> : null}

        {layoutNode.hasChildren ? (
          <button
            type="button"
            className={`km-xmind-topic-toggle km-xmind-topic-toggle--${toggleSide}`}
            aria-expanded={!layoutNode.collapsed}
            aria-label={layoutNode.collapsed ? `展开分支 ${title}` : `折叠分支 ${title}`}
            title={layoutNode.collapsed ? '展开分支' : '折叠分支'}
            onClick={(e) => {
              e.stopPropagation()
              toggleBranch(id)
            }}
          >
            {layoutNode.collapsed ? '+' : '−'}
          </button>
        ) : null}

        {layoutNode.collapsed && childCount > 0 ? (
          <span className={`km-xmind-collapsed-badge km-xmind-collapsed-badge--${toggleSide}`}>{childCount}</span>
        ) : null}

        {isNoteBranch && noteBranchHiddenCount > 0 ? (
          <button
            type="button"
            className="km-xmind-note-expand"
            onClick={(e) => {
              e.stopPropagation()
              setNotesExpanded(true)
            }}
          >
            +{noteBranchHiddenCount} 事项
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className={`km-mind-map-shell km-xmind-shell${isModalLayout ? ' is-modal-layout' : ''}`}>
      <div className="km-mind-toolbar">
        <div className="km-mind-toolbar-actions">
          <button type="button" className="km-mind-tool-btn" onClick={expandAll}>
            全部展开
          </button>
          <button type="button" className="km-mind-tool-btn" onClick={collapseAll}>
            全部折叠
          </button>
          {processingCount > 0 ? (
            <>
              <button type="button" className="km-mind-tool-btn km-mind-tool-btn--processing" onClick={focusProcessing}>
                聚焦进行中
              </button>
              <button
                type="button"
                className={`km-mind-tool-btn${processingPanelOpen ? ' is-active' : ''}`}
                onClick={() => setProcessingPanelVisible(!processingPanelOpen)}
              >
                {processingPanelOpen ? '收起详情' : '进行中详情'}
              </button>
              <button type="button" className="km-mind-tool-btn" onClick={applyFullCanvasView}>
                全览
              </button>
              <span className="km-mind-toolbar-meta km-mind-toolbar-meta--processing">
                <span className="km-mind-toolbar-processing-dot" aria-hidden="true" />
                {processingCount} 个节点处理中
              </span>
            </>
          ) : null}
          {collapsedCount > 0 ? (
            <span className="km-mind-toolbar-meta">{collapsedCount} 个分支已折叠</span>
          ) : (
            <span className="km-mind-toolbar-meta">
              {nodes.length} 节点 · {edges.length} 关系
            </span>
          )}
        </div>
        <div className="km-mind-zoom-controls" aria-label="缩放控制">
          <button type="button" className="km-mind-zoom-btn" onClick={zoomOut} aria-label="缩小">
            −
          </button>
          <button type="button" className="km-mind-zoom-btn km-mind-zoom-label" onClick={resetZoom} aria-label="重置缩放">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className="km-mind-zoom-btn" onClick={zoomIn} aria-label="放大">
            +
          </button>
          <span className="km-mind-zoom-hint">
            {processingCount > 0 ? '右侧查看全部进行中 · ' : ''}
            {onPatchNodeStatus ? '右键或点状态可修改 · ' : ''}Ctrl + 滚轮缩放 · 点击节点查看详情
          </span>
        </div>
        <div className="km-mind-legend" aria-label="节点类型图例">
          {KIND_LEGEND.map(({ kind, label }) => (
            <span key={kind} className="km-mind-legend-item" data-kind={kind}>
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className={`km-mind-map-body${processingPanelOpen && processingCount > 0 ? ' has-processing-panel' : ''}`}>
        <div
          className={`km-mind-map-wrap km-xmind-wrap${isPanning ? ' is-panning' : ''}`}
          ref={wrapRef}
          onMouseDown={handlePanMouseDown}
        >
          <div
            className="km-mind-map-spacer"
            style={{
              width: xmindLayout.width * zoom,
              height: xmindLayout.height * zoom,
            }}
          >
            <div
              className="km-xmind-canvas"
              style={{
                width: xmindLayout.width,
                height: xmindLayout.height,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
              onClick={handleCanvasBackgroundClick}
            >
              <svg className="km-xmind-edges" width={xmindLayout.width} height={xmindLayout.height} aria-hidden="true">
                {xmindLayout.edges.map((edge) => (
                  <path
                    key={`${edge.fromId}-${edge.toId}`}
                    d={edge.path}
                    fill="none"
                    stroke={edge.color}
                    strokeWidth={edge.strokeWidth}
                    strokeLinecap="round"
                  />
                ))}
              </svg>
              <div className="km-xmind-topics">{xmindLayout.nodes.map((layoutNode) => renderTopic(layoutNode))}</div>
            </div>
          </div>
        </div>
        {processingCount > 0 && processingPanelOpen ? (
          <aside className="km-xmind-processing-panel" aria-label="进行中节点详情">
            <div className="km-xmind-processing-panel-head">
              <span className="km-xmind-processing-panel-title">
                <span className="km-mind-toolbar-processing-dot" aria-hidden="true" />
                进行中 ({processingCount})
              </span>
              <button
                type="button"
                className="km-xmind-processing-panel-close"
                aria-label="收起详情面板"
                onClick={() => setProcessingPanelVisible(false)}
              >
                ×
              </button>
            </div>
            <div className="km-xmind-processing-panel-list">
              {processingItems.map((item) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  ref={(el) => {
                    processingPanelItemRefs.current[item.id] = el
                  }}
                  className={`km-xmind-processing-panel-item${activeProcessingId === item.id ? ' is-active' : ''}`}
                  onClick={() => focusNodeOnCanvas(item.id)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    focusNodeOnCanvas(item.id)
                  }}
                >
                  <div className="km-xmind-processing-panel-item-head">
                    <div className="km-xmind-processing-panel-item-head-main">
                      <span className="km-xmind-processing-panel-item-kind">{item.kind}</span>
                      {item.activityLabel ? (
                        <time
                          className="km-xmind-processing-panel-item-time"
                          dateTime={item.activityAt}
                          title={item.activityAt ? `更新于 ${item.activityAt}` : undefined}
                        >
                          {item.activityLabel}
                        </time>
                      ) : null}
                    </div>
                    {item.status ? (
                      onPatchNodeStatus && canUserEditNodeStatus(item.id, (item.node as KnowledgeMapNode | undefined)?.kind) ? (
                        <button
                          type="button"
                          className="km-xmind-processing-panel-item-status km-node-status-btn"
                          title="点击修改状态"
                          onClick={(e) => {
                            e.stopPropagation()
                            const node = item.node as KnowledgeMapNode | undefined
                            openStatusMenu(
                              item.id,
                              String(node?.status || 'active'),
                              statusMenuAnchorFromElement(e.currentTarget, 'left'),
                            )
                          }}
                        >
                          {item.status}
                        </button>
                      ) : (
                        <span className="km-xmind-processing-panel-item-status">{item.status}</span>
                      )
                    ) : null}
                  </div>
                  <div className="km-xmind-processing-panel-item-title">{item.title}</div>
                  {item.body || item.node ? (
                    <KnowledgeMapNodeBodyContent node={item.node} compact fallbackEmpty="暂无详细描述" />
                  ) : (
                    <p className="km-xmind-processing-panel-item-body is-empty">暂无详细描述</p>
                  )}
                </div>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
      {detailPopover ? (
        <div
          className={`km-xmind-detail-popover${detailPopover.status === '进行中' || detailPopover.status === '待更新' ? ' is-processing-detail' : ''}`}
          style={{ left: detailPopover.left, top: detailPopover.top }}
          role="dialog"
          aria-label={`节点详情：${detailPopover.title}`}
        >
          <div className="km-xmind-detail-popover-head">
            <span className="km-xmind-detail-popover-kind">{detailPopover.kind}</span>
            <div className="km-xmind-detail-popover-head-actions">
              {detailPopover.status === '进行中' || detailPopover.status === '待更新' ? (
                onPatchNodeStatus && canUserEditNodeStatus(detailPopover.id, (detailPopover.node as KnowledgeMapNode | undefined)?.kind) ? (
                  <button
                    type="button"
                    className="km-xmind-detail-popover-status-inline km-node-status-btn"
                    title="点击修改状态"
                    onClick={(e) => {
                      const node = detailPopover.node as KnowledgeMapNode | undefined
                      openStatusMenu(
                        detailPopover.id,
                        String(node?.status || 'active'),
                        statusMenuAnchorFromElement(e.currentTarget, 'left'),
                      )
                    }}
                  >
                    {detailPopover.status}
                  </button>
                ) : (
                  <span className="km-xmind-detail-popover-status-inline">{detailPopover.status}</span>
                )
              ) : detailPopover.status && onPatchNodeStatus && canUserEditNodeStatus(detailPopover.id, (detailPopover.node as KnowledgeMapNode | undefined)?.kind) ? (
                <button
                  type="button"
                  className="km-xmind-detail-popover-status-inline km-node-status-btn"
                  title="点击修改状态"
                  onClick={(e) => {
                    const node = detailPopover.node as KnowledgeMapNode | undefined
                    openStatusMenu(
                      detailPopover.id,
                      String(node?.status || 'active'),
                      statusMenuAnchorFromElement(e.currentTarget, 'left'),
                    )
                  }}
                >
                  {detailPopover.status}
                </button>
              ) : null}
              <button
                type="button"
                className="km-xmind-detail-popover-close"
                aria-label="关闭"
                onClick={() => setDetailPopover(null)}
              >
                ×
              </button>
            </div>
          </div>
          <h4 className="km-xmind-detail-popover-title">{detailPopover.title}</h4>
          {detailPopover.activityLabel ? (
            <time
              className="km-xmind-detail-popover-time"
              dateTime={detailPopover.activityAt}
              title={detailPopover.activityAt ? `更新于 ${detailPopover.activityAt}` : undefined}
            >
              {detailPopover.activityLabel}
            </time>
          ) : null}
          {detailPopover.body || detailPopover.node ? (
            <KnowledgeMapNodeBodyContent node={detailPopover.node} fallbackEmpty="暂无详细描述" />
          ) : (
            <p className="km-xmind-detail-popover-body km-xmind-detail-popover-body--empty">暂无详细描述</p>
          )}
          <code className="km-xmind-detail-popover-id">{detailPopover.id}</code>
        </div>
      ) : null}
      {statusMenu ? (
        <KnowledgeMapNodeStatusMenu
          nodeId={statusMenu.nodeId}
          currentStatus={statusMenu.status}
          anchor={statusMenu.anchor}
          saving={statusSaving}
          onSelect={(next) => void handleStatusSelect(next)}
          onClose={() => setStatusMenu(null)}
        />
      ) : null}
    </div>
  )
}