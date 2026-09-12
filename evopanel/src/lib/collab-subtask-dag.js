/**
 * Build a dependency forest for collab subtask DAG UI (refs + subtask ids).
 * @typedef {import('../react/chat-types.js').CollabSubtaskSnapshot} CollabSubtaskSnapshot
 */

/**
 * Normalize depends_on tokens from API row or UI snapshot.
 * Runtime truth is ``worker_profile.depends_on``; top-level ``dependencies`` often holds
 * legacy plan step refs and must not override an empty worker profile.
 * @param {Record<string, unknown> | CollabSubtaskSnapshot | null | undefined} row
 * @returns {string[]}
 */
export function extractSubtaskDependsOn(row) {
  if (!row || typeof row !== 'object') return []
  const r = /** @type {Record<string, unknown>} */ (row)

  if (Array.isArray(r.dependsOn)) {
    return r.dependsOn.map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (Array.isArray(r.depends_on)) {
    return r.depends_on.map((x) => String(x || '').trim()).filter(Boolean)
  }

  const wp = r.worker_profile || r.workerProfile
  if (wp && typeof wp === 'object') {
    const w = /** @type {Record<string, unknown>} */ (wp)
    if ('depends_on' in w || 'dependsOn' in w) {
      const wpDeps = w.depends_on ?? w.dependsOn
      if (Array.isArray(wpDeps)) {
        return wpDeps.map((x) => String(x || '').trim()).filter(Boolean)
      }
      return []
    }
    // worker_profile present without depends_on => no runtime DAG edges
    return []
  }

  const dependsRaw = r.dependencies
  if (Array.isArray(dependsRaw)) {
    return dependsRaw.map((x) => String(x || '').trim()).filter(Boolean)
  }
  return []
}

/**
 * @param {CollabSubtaskSnapshot[]} subtasks
 * @returns {{
 *   roots: string[],
 *   childrenOf: Map<string, string[]>,
 *   byId: Map<string, CollabSubtaskSnapshot>,
 *   sortKey: (id: string) => string,
 * }}
 */
export function buildSubtaskDagIndex(subtasks) {
  const list = Array.isArray(subtasks) ? subtasks : []
  /** @type {Map<string, CollabSubtaskSnapshot>} */
  const byId = new Map()
  /** @type {Map<string, string>} */
  const refToId = new Map()

  for (const s of list) {
    const id = String(s?.subtaskId || '').trim()
    if (!id) continue
    byId.set(id, s)
    const ref = String(s?.ref || '').trim()
    if (ref) refToId.set(ref, id)
  }

  const resolveDep = (token) => {
    const t = String(token || '').trim()
    if (!t) return null
    if (byId.has(t)) return t
    if (refToId.has(t)) return refToId.get(t)
    return null
  }

  /** @type {Map<string, Set<string>>} */
  const childSets = new Map()
  /** @type {Set<string>} */
  const hasParent = new Set()

  for (const s of list) {
    const id = String(s?.subtaskId || '').trim()
    if (!id) continue
    const rawDeps = extractSubtaskDependsOn(s)
    const parents = [...new Set(rawDeps.map(resolveDep).filter(Boolean))]
    if (!parents.length) continue
    for (const p of parents) {
      hasParent.add(id)
      if (!childSets.has(p)) childSets.set(p, new Set())
      childSets.get(p).add(id)
    }
  }

  const sortKey = (id) => {
    const s = byId.get(id)
    const ref = String(s?.ref || '').trim()
    if (ref && /^\d+$/.test(ref)) return ref.padStart(6, '0')
    return String(s?.name || id)
  }

  const childrenOf = new Map()
  for (const [p, set] of childSets) {
    childrenOf.set(
      p,
      [...set].sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true })),
    )
  }

  const roots = [...byId.keys()]
    .filter((id) => !hasParent.has(id))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }))

  return { roots, childrenOf, byId, sortKey }
}

const DEFAULT_NODE_W = 212
const DEFAULT_NODE_H = 136
const DEFAULT_GAP_X = 40
const DEFAULT_GAP_Y = 80
const DEFAULT_PADDING = 28

/**
 * Layered DAG layout for workflow canvas (top → bottom).
 * @param {ReturnType<typeof buildSubtaskDagIndex>} dag
 * @param {{ nodeWidth?: number, nodeHeight?: number, gapX?: number, gapY?: number, padding?: number }} [opts]
 */
export function layoutSubtaskDagCanvas(dag, opts = {}) {
  const NODE_W = opts.nodeWidth ?? DEFAULT_NODE_W
  const NODE_H = opts.nodeHeight ?? DEFAULT_NODE_H
  const GAP_X = opts.gapX ?? DEFAULT_GAP_X
  const GAP_Y = opts.gapY ?? DEFAULT_GAP_Y
  const PADDING = opts.padding ?? DEFAULT_PADDING
  const { childrenOf, byId, sortKey } = dag

  /** @type {Map<string, number>} */
  const levels = new Map()
  for (const id of byId.keys()) levels.set(id, 0)

  let changed = true
  let guard = 0
  while (changed && guard < byId.size + 2) {
    changed = false
    guard += 1
    for (const [parent, kids] of childrenOf) {
      const pl = levels.get(parent) ?? 0
      for (const child of kids) {
        const want = pl + 1
        if (want > (levels.get(child) ?? 0)) {
          levels.set(child, want)
          changed = true
        }
      }
    }
  }

  const maxLevel = Math.max(0, ...levels.values())
  /** @type {string[][]} */
  const rows = []
  for (let lvl = 0; lvl <= maxLevel; lvl += 1) {
    const ids = [...byId.keys()]
      .filter((id) => (levels.get(id) ?? 0) === lvl)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }))
    if (ids.length) rows.push(ids)
  }

  /** @type {Map<string, { x: number, y: number, w: number, h: number }>} */
  const positions = new Map()
  let maxRowW = 0
  for (const row of rows) {
    const rowW = row.length * NODE_W + Math.max(0, row.length - 1) * GAP_X
    maxRowW = Math.max(maxRowW, rowW)
  }

  let maxY = PADDING
  for (let li = 0; li < rows.length; li += 1) {
    const row = rows[li]
    const rowW = row.length * NODE_W + Math.max(0, row.length - 1) * GAP_X
    let x = PADDING + (maxRowW - rowW) / 2
    const y = PADDING + li * (NODE_H + GAP_Y)
    for (const id of row) {
      positions.set(id, { x, y, w: NODE_W, h: NODE_H })
      x += NODE_W + GAP_X
    }
    maxY = y + NODE_H
  }

  /** @type {{ from: string, to: string }[]} */
  const edges = []
  for (const [from, kids] of childrenOf) {
    for (const to of kids) edges.push({ from, to })
  }

  return {
    positions,
    edges,
    width: PADDING * 2 + maxRowW,
    height: maxY + PADDING,
    nodeWidth: NODE_W,
    nodeHeight: NODE_H,
  }
}

/**
 * SVG cubic path from parent bottom to child top.
 * @param {{ x: number, y: number, w: number, h: number }} from
 * @param {{ x: number, y: number, w: number, h: number }} to
 */
export function subtaskDagEdgePath(from, to) {
  const x1 = from.x + from.w / 2
  const y1 = from.y + from.h
  const x2 = to.x + to.w / 2
  const y2 = to.y
  const mid = y1 + Math.max(24, (y2 - y1) * 0.45)
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}
