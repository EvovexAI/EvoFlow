/**
 * XMind-style balanced mind-map layout: root centered, branches alternate left/right,
 * siblings stack vertically, connections are cubic Bézier curves.
 */

/** @typedef {'left' | 'right' | 'center'} Side */

/** @typedef {{ id: string, x: number, y: number, width: number, height: number, depth: number, side: Side, branchIndex: number, collapsed: boolean, hasChildren: boolean }} LayoutNode */

/** @typedef {{ fromId: string, toId: string, path: string, color: string, strokeWidth: number }} LayoutEdge */

/** @typedef {{ nodes: LayoutNode[], edges: LayoutEdge[], width: number, height: number, padding: number }} XMindLayout */

/** 简约灰阶配色 — 不用彩虹分支，仅用字重/边框粗细区分层级 */
export const MINIMAL_PALETTE = {
  canvas: '#fafafa',
  line: '#d4d4d8',
  lineFromRoot: '#a1a1aa',
  rootBg: '#27272a',
  rootFg: '#fafafa',
  mainBg: '#ffffff',
  mainBorder: '#a1a1aa',
  mainFg: '#18181b',
  subBg: '#ffffff',
  subBorder: '#e4e4e7',
  subFg: '#52525b',
  muted: '#71717a',
}

/** @deprecated 图例保留；节点不再按分支索引上色 */
export const XMIND_BRANCH_COLORS = [
  MINIMAL_PALETTE.muted,
  MINIMAL_PALETTE.muted,
  MINIMAL_PALETTE.muted,
  MINIMAL_PALETTE.muted,
  MINIMAL_PALETTE.muted,
  MINIMAL_PALETTE.muted,
]

const H_GAP = 108
const V_GAP = 32
const PADDING = 64
const OVERLAP_GAP = 16

/** 中心主题 > 分支主题 > 子主题 — 字号与尺寸逐级递减 */
const NODE_SIZE = [
  { w: 260, h: 92 },
  { w: 210, h: 86 },
  { w: 190, h: 74 },
  { w: 178, h: 68 },
]

/**
 * @param {number} depth
 */
function nodeSize(depth) {
  return NODE_SIZE[Math.min(depth, NODE_SIZE.length - 1)]
}

/**
 * @param {import('./knowledge-map-tree.js').buildKnowledgeMapTree extends (...args: any[]) => infer R ? R : never} tree
 */
function buildParentMap(tree) {
  /** @type {Map<string, string>} */
  const parentOf = new Map()
  for (const [parentId, childIds] of tree.childrenOf.entries()) {
    for (const childId of childIds) {
      parentOf.set(childId, parentId)
    }
  }
  return parentOf
}

/**
 * @param {string} id
 * @param {string} rootId
 * @param {Map<string, string>} parentOf
 * @param {Map<string, string[]>} childrenOf
 */
function rootChildIndex(id, rootId, parentOf, childrenOf) {
  let current = id
  const walked = new Set()
  while (current && current !== rootId) {
    if (walked.has(current)) break
    walked.add(current)
    const parent = parentOf.get(current)
    if (parent === rootId) {
      const siblings = childrenOf.get(rootId) || []
      return Math.max(0, siblings.indexOf(current))
    }
    current = parent || ''
  }
  return 0
}

/**
 * @param {string} id
 * @param {string} rootId
 * @param {Map<string, string>} parentOf
 * @param {Map<string, string[]>} childrenOf
 * @returns {Side}
 */
function branchSide(id, rootId, parentOf, childrenOf) {
  if (id === rootId) return 'center'
  const idx = rootChildIndex(id, rootId, parentOf, childrenOf)
  return idx % 2 === 0 ? 'right' : 'left'
}

/**
 * @param {number} branchIndex
 */
export function branchColor(branchIndex) {
  return XMIND_BRANCH_COLORS[Math.abs(branchIndex) % XMIND_BRANCH_COLORS.length]
}

/**
 * @param {string} hex
 */
function parseHex(hex) {
  const raw = String(hex || '').replace('#', '')
  if (raw.length !== 6) return { r: 100, g: 116, b: 139 }
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  }
}

/**
 * @param {string} hex
 */
function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex)
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * @param {string} hex
 * @param {number} amount 0–1, mix toward black
 */
export function darkenHex(hex, amount) {
  const { r, g, b } = parseHex(hex)
  const mix = (v) => Math.round(v * (1 - amount))
  const toHex = (v) => mix(v).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * @param {string} bgHex
 */
export function textColorForBg(bgHex) {
  return relativeLuminance(bgHex) > 0.55 ? '#2c2c2c' : '#ffffff'
}

/**
 * 统一简约主题（所有分支相同，不随 branchIndex 变化）
 */
export function branchTheme() {
  const p = MINIMAL_PALETTE
  return {
    color: p.lineFromRoot,
    mainBg: p.mainBg,
    mainFg: p.mainFg,
    mainBorder: p.mainBorder,
    subBg: p.subBg,
    subFg: p.subFg,
    subBorder: p.subBorder,
  }
}

/**
 * @param {number} parentDepth
 * @param {number} childDepth
 */
export function edgeStyle(parentDepth, childDepth) {
  return {
    color: parentDepth === 0 ? MINIMAL_PALETTE.lineFromRoot : MINIMAL_PALETTE.line,
    strokeWidth: parentDepth === 0 ? 2 : childDepth === 1 ? 1.75 : childDepth === 2 ? 1.5 : 1.25,
  }
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} from
 * @param {{ x: number, y: number, width: number, height: number }} to
 * @param {Side} side
 */
function bezierPath(from, to, side) {
  const fromY = from.y + from.height / 2
  const toY = to.y + to.height / 2
  let x1
  let x2
  if (side === 'right') {
    x1 = from.x + from.width
    x2 = to.x
  } else {
    x1 = from.x
    x2 = to.x + to.width
  }
  const dx = x2 - x1
  const cp = Math.max(28, Math.abs(dx) * 0.52)
  const cx1 = side === 'right' ? x1 + cp : x1 - cp
  const cx2 = side === 'right' ? x2 - cp : x2 + cp
  return `M ${x1} ${fromY} C ${cx1} ${fromY}, ${cx2} ${toY}, ${x2} ${toY}`
}

/**
 * Push apart vertically overlapping nodes on the same side.
 * @param {LayoutNode[]} nodes
 */
function resolveVerticalOverlaps(nodes) {
  for (const side of ['left', 'right']) {
    const group = nodes.filter((n) => n.side === side).sort((a, b) => a.y - b.y)
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1]
      const curr = group[i]
      const minY = prev.y + prev.height + OVERLAP_GAP
      if (curr.y < minY) {
        const delta = minY - curr.y
        for (const n of nodes) {
          if (n.side === side && n.y >= curr.y) n.y += delta
        }
        group.sort((a, b) => a.y - b.y)
      }
    }
  }
}

/**
 * @param {LayoutEdge[]} edges
 * @param {Map<string, LayoutNode>} nodeById
 */
function refreshEdgePaths(edges, nodeById) {
  for (const edge of edges) {
    const from = nodeById.get(edge.fromId)
    const to = nodeById.get(edge.toId)
    if (!from || !to) continue
    const side = to.side === 'center' ? 'right' : to.side
    edge.path = bezierPath(from, to, side)
  }
}

/**
 * @param {string} id
 * @param {ReturnType<typeof buildParentMap>} parentOf
 * @param {Map<string, string[]>} childrenOf
 * @param {string} rootId
 * @param {(id: string) => string[]} getVisibleChildren
 * @param {Set<string>} collapsedIds
 * @param {number} depth
 */
function measureSubtreeHeight(
  id,
  parentOf,
  childrenOf,
  rootId,
  getVisibleChildren,
  collapsedIds,
  depth,
  ancestors = new Set(),
) {
  if (ancestors.has(id)) return nodeSize(depth).h
  ancestors.add(id)
  const { h } = nodeSize(depth)
  const children = getVisibleChildren(id)
  if (collapsedIds.has(id) || !children.length) {
    ancestors.delete(id)
    return h
  }
  let total = 0
  for (let i = 0; i < children.length; i++) {
    total += measureSubtreeHeight(
      children[i],
      parentOf,
      childrenOf,
      rootId,
      getVisibleChildren,
      collapsedIds,
      depth + 1,
      ancestors,
    )
    if (i < children.length - 1) total += V_GAP
  }
  ancestors.delete(id)
  return Math.max(h, total)
}

/**
 * @param {string} id
 * @param {ReturnType<typeof buildParentMap>} parentOf
 * @param {Map<string, string[]>} childrenOf
 * @param {string} rootId
 * @param {(id: string) => string[]} getVisibleChildren
 * @param {Set<string>} collapsedIds
 * @param {number} depth
 * @param {Side} side
 */
function measureSubtreeWidth(
  id,
  parentOf,
  childrenOf,
  rootId,
  getVisibleChildren,
  collapsedIds,
  depth,
  side,
  ancestors = new Set(),
) {
  if (ancestors.has(id)) return nodeSize(depth).w
  ancestors.add(id)
  const { w } = nodeSize(depth)
  const children = getVisibleChildren(id)
  if (collapsedIds.has(id) || !children.length) {
    ancestors.delete(id)
    return w
  }
  let maxChild = 0
  for (const childId of children) {
    maxChild = Math.max(
      maxChild,
      measureSubtreeWidth(
        childId,
        parentOf,
        childrenOf,
        rootId,
        getVisibleChildren,
        collapsedIds,
        depth + 1,
        side,
        ancestors,
      ),
    )
  }
  ancestors.delete(id)
  return w + H_GAP + maxChild
}

/**
 * @param {string} id
 * @param {number} depth
 * @param {Side} side
 * @param {number} branchIndex
 * @param {number} x
 * @param {number} yCenter
 * @param {ReturnType<typeof buildParentMap>} parentOf
 * @param {Map<string, string[]>} childrenOf
 * @param {string} rootId
 * @param {(id: string) => string[]} getVisibleChildren
 * @param {Set<string>} collapsedIds
 * @param {LayoutNode[]} nodes
 * @param {Map<string, LayoutNode>} nodeById
 */
function placeSubtree(
  id,
  depth,
  side,
  branchIndex,
  x,
  yCenter,
  parentOf,
  childrenOf,
  rootId,
  getVisibleChildren,
  collapsedIds,
  nodes,
  nodeById,
  ancestors = new Set(),
) {
  if (ancestors.has(id)) return
  ancestors.add(id)
  const { w, h } = nodeSize(depth)
  const y = yCenter - h / 2
  const children = getVisibleChildren(id)
  const collapsed = collapsedIds.has(id)
  const hasChildren = (childrenOf.get(id) || []).length > 0

  /** @type {LayoutNode} */
  const layoutNode = {
    id,
    x,
    y,
    width: w,
    height: h,
    depth,
    side,
    branchIndex,
    collapsed,
    hasChildren,
  }
  nodes.push(layoutNode)
  nodeById.set(id, layoutNode)

  if (collapsed || !children.length) {
    ancestors.delete(id)
    return
  }

  const heights = children.map((childId) =>
    measureSubtreeHeight(childId, parentOf, childrenOf, rootId, getVisibleChildren, collapsedIds, depth + 1),
  )
  let totalH = heights.reduce((sum, v) => sum + v, 0) + V_GAP * Math.max(0, children.length - 1)
  let cursorY = yCenter - totalH / 2

  for (let i = 0; i < children.length; i++) {
    const childId = children[i]
    const childH = heights[i]
    const childCenterY = cursorY + childH / 2
    const childDepth = depth + 1
    const childW = nodeSize(childDepth).w
    const childBranchIndex = depth === 0 ? i : branchIndex
    let childX
    if (side === 'right') {
      childX = x + w + H_GAP
    } else {
      childX = x - H_GAP - childW
    }
    placeSubtree(
      childId,
      childDepth,
      side,
      childBranchIndex,
      childX,
      childCenterY,
      parentOf,
      childrenOf,
      rootId,
      getVisibleChildren,
      collapsedIds,
      nodes,
      nodeById,
      ancestors,
    )
    cursorY += childH + V_GAP
  }
  ancestors.delete(id)
}

/**
 * @param {ReturnType<typeof import('./knowledge-map-tree.js').buildKnowledgeMapTree>} tree
 * @param {{ collapsedIds: Set<string>, getVisibleChildren: (id: string) => string[] }} options
 * @returns {XMindLayout}
 */
export function layoutXmindMindMap(tree, options) {
  const { collapsedIds, getVisibleChildren } = options
  const rootId = tree.rootId
  const parentOf = buildParentMap(tree)
  const rootChildren = getVisibleChildren(rootId)
  const rootSize = nodeSize(0)

  const rightChildren = rootChildren.filter((_, i) => i % 2 === 0)
  const leftChildren = rootChildren.filter((_, i) => i % 2 === 1)

  let leftWidth = 0
  for (const childId of leftChildren) {
    leftWidth = Math.max(
      leftWidth,
      measureSubtreeWidth(childId, parentOf, tree.childrenOf, rootId, getVisibleChildren, collapsedIds, 1, 'left'),
    )
  }

  let rightWidth = 0
  for (const childId of rightChildren) {
    rightWidth = Math.max(
      rightWidth,
      measureSubtreeWidth(childId, parentOf, tree.childrenOf, rootId, getVisibleChildren, collapsedIds, 1, 'right'),
    )
  }

  const rightHeights = rightChildren.map((id) =>
    measureSubtreeHeight(id, parentOf, tree.childrenOf, rootId, getVisibleChildren, collapsedIds, 1),
  )
  const leftHeights = leftChildren.map((id) =>
    measureSubtreeHeight(id, parentOf, tree.childrenOf, rootId, getVisibleChildren, collapsedIds, 1),
  )

  const sumHeights = (heights) => heights.reduce((sum, h) => sum + h, 0) + V_GAP * Math.max(0, heights.length - 1)
  const contentHeight = Math.max(rootSize.h, sumHeights(rightHeights), sumHeights(leftHeights))

  const rootX = PADDING + leftWidth
  const rootY = PADDING + contentHeight / 2 - rootSize.h / 2

  /** @type {LayoutNode[]} */
  const nodes = []
  /** @type {Map<string, LayoutNode>} */
  const nodeById = new Map()

  /** @type {LayoutNode} */
  const rootNode = {
    id: rootId,
    x: rootX,
    y: rootY,
    width: rootSize.w,
    height: rootSize.h,
    depth: 0,
    side: 'center',
    branchIndex: -1,
    collapsed: collapsedIds.has(rootId),
    hasChildren: (tree.childrenOf.get(rootId) || []).length > 0,
  }
  nodes.push(rootNode)
  nodeById.set(rootId, rootNode)

  const rootCenterY = rootY + rootSize.h / 2

  if (rightChildren.length) {
    let cursorY = rootCenterY - sumHeights(rightHeights) / 2
    for (let i = 0; i < rightChildren.length; i++) {
      const childId = rightChildren[i]
      const childH = rightHeights[i]
      const childCenterY = cursorY + childH / 2
      placeSubtree(
        childId,
        1,
        'right',
        rootChildren.indexOf(childId),
        rootX + rootSize.w + H_GAP,
        childCenterY,
        parentOf,
        tree.childrenOf,
        rootId,
        getVisibleChildren,
        collapsedIds,
        nodes,
        nodeById,
      )
      cursorY += childH + V_GAP
    }
  }

  if (leftChildren.length) {
    let cursorY = rootCenterY - sumHeights(leftHeights) / 2
    for (let i = 0; i < leftChildren.length; i++) {
      const childId = leftChildren[i]
      const childH = leftHeights[i]
      const childCenterY = cursorY + childH / 2
      const childW = nodeSize(1).w
      placeSubtree(
        childId,
        1,
        'left',
        rootChildren.indexOf(childId),
        rootX - H_GAP - childW,
        childCenterY,
        parentOf,
        tree.childrenOf,
        rootId,
        getVisibleChildren,
        collapsedIds,
        nodes,
        nodeById,
      )
      cursorY += childH + V_GAP
    }
  }

  /** @type {LayoutEdge[]} */
  const edges = []
  for (const [parentId, childIds] of tree.childrenOf.entries()) {
    const parent = nodeById.get(parentId)
    if (!parent || parent.collapsed) continue
    const visibleChildren = getVisibleChildren(parentId)
    for (const childId of childIds) {
      if (!visibleChildren.includes(childId)) continue
      const child = nodeById.get(childId)
      if (!child) continue
      const side = child.side === 'center' ? 'right' : child.side
      const { color, strokeWidth } = edgeStyle(parent.depth, child.depth)
      edges.push({
        fromId: parentId,
        toId: childId,
        path: bezierPath(parent, child, side),
        color,
        strokeWidth,
      })
    }
  }

  resolveVerticalOverlaps(nodes)

  let canvasWidth = PADDING * 2 + leftWidth + rootSize.w + rightWidth
  let canvasHeight = PADDING * 2 + contentHeight
  if (nodes.length) {
    let minX = Infinity
    let minY = Infinity
    let maxX = 0
    let maxY = 0
    for (const n of nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const dx = minX < PADDING ? PADDING - minX : 0
    const dy = minY < PADDING ? PADDING - minY : 0
    if (dx || dy) {
      for (const n of nodes) {
        n.x += dx
        n.y += dy
      }
      maxX += dx
      maxY += dy
    }
    canvasWidth = Math.max(canvasWidth, maxX + PADDING)
    canvasHeight = Math.max(canvasHeight, maxY + PADDING)
  }

  refreshEdgePaths(edges, nodeById)

  return {
    nodes,
    edges,
    width: canvasWidth,
    height: canvasHeight,
    padding: PADDING,
  }
}
