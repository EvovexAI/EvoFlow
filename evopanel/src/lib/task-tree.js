/**
 * Task-center forest helpers: roots vs handoff children (`parent_task_id`).
 * List UI aggregates by root; children nest under expand.
 */

import { taskMatchesStatusTab, toTaskStatusGroup } from './task-status-label.js'

/** Statuses that count as「本层已交」for downstream rollup (not necessarily 整单结束). */
const ROLLUP_TERMINAL = new Set([
  'completed',
  'reviewed',
  'awaiting_close',
  'failed',
  'error',
  'cancelled',
  'canceled',
])

export function taskIdOf(task) {
  return String(task?.id || task?.task_id || '').trim()
}

export function taskParentId(task) {
  return String(task?.parent_task_id || task?.parent?.task_id || '').trim()
}

export function isRollupTerminalStatus(status) {
  const s = String(status || '').trim().toLowerCase().replace(/-/g, '_')
  return ROLLUP_TERMINAL.has(s)
}

/**
 * Build parent→children index from a flat task list.
 * Orphans (parent missing from set) are treated as roots.
 *
 * @param {unknown[]} tasks
 * @returns {{
 *   byId: Map<string, object>,
 *   childrenByParent: Map<string, object[]>,
 *   roots: object[],
 * }}
 */
export function buildTaskForest(tasks) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : []
  const byId = new Map()
  for (const t of list) {
    const id = taskIdOf(t)
    if (id) byId.set(id, t)
  }
  const childrenByParent = new Map()
  const roots = []
  for (const t of list) {
    const id = taskIdOf(t)
    if (!id) continue
    const pid = taskParentId(t)
    if (pid && byId.has(pid)) {
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, [])
      childrenByParent.get(pid).push(t)
    } else {
      roots.push(t)
    }
  }
  const sortKey = (a, b) => {
    const ta = Date.parse(String(a?.created_at || a?.started_at || a?.updated_at || '')) || 0
    const tb = Date.parse(String(b?.created_at || b?.started_at || b?.updated_at || '')) || 0
    return tb - ta
  }
  roots.sort(sortKey)
  for (const kids of childrenByParent.values()) kids.sort(sortKey)
  return { byId, childrenByParent, roots }
}

export function directChildrenOf(forest, parentId) {
  const pid = String(parentId || '').trim()
  if (!pid || !forest?.childrenByParent) return []
  return forest.childrenByParent.get(pid) || []
}

/** Direct-child rollup: done/total among handoff siblings. */
export function childRollup(forest, parentId) {
  const kids = directChildrenOf(forest, parentId)
  let done = 0
  for (const k of kids) {
    if (isRollupTerminalStatus(k?.status)) done += 1
  }
  const total = kids.length
  return {
    total,
    done,
    open: Math.max(0, total - done),
    all_done: total > 0 && done === total,
    children: kids,
  }
}

/** One-line hint for list/card under a parent row. */
export function formatDownstreamHint(rollup) {
  const total = Number(rollup?.total) || 0
  if (total <= 0) return ''
  const done = Number(rollup?.done) || 0
  if (rollup?.all_done) return `下游已齐 ${done}/${total} · 待验收闭环`
  return `下游 ${done}/${total} 已结`
}

/**
 * Collect ancestor ids from task up to (but not including) a missing parent.
 * @param {Map<string, object>} byId
 * @param {string} taskId
 */
export function ancestorIds(byId, taskId) {
  const out = []
  const seen = new Set()
  let cur = String(taskId || '').trim()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const row = byId.get(cur)
    if (!row) break
    const pid = taskParentId(row)
    if (!pid || !byId.has(pid)) break
    out.push(pid)
    cur = pid
  }
  return out
}

/**
 * Roots to show in the task center list after filters.
 * Matching a child (search / agent) includes its root and returns expand hints.
 *
 * @param {object[]} visibleTasks time-filtered flat list
 * @param {{
 *   sourceKey?: (t: object) => string,
 *   sourceFilter?: string | null,
 *   statusFilter?: string | null,
 *   appFilter?: string | null,
 *   agentFilter?: string | null,
 *   textQuery?: string,
 *   taskMatchesAgent?: (t: object, filter: string) => boolean,
 *   taskMatchesText?: (t: object, q: string) => boolean,
 *   taskAppId?: (t: object) => string,
 * }} filters
 * @returns {{ roots: object[], forest: ReturnType<typeof buildTaskForest>, autoExpandIds: string[] }}
 */
export function selectRootTasks(visibleTasks, filters = {}) {
  const forest = buildTaskForest(visibleTasks)
  const {
    sourceFilter = null,
    statusFilter = null,
    appFilter = null,
    agentFilter = null,
    textQuery = '',
    sourceKey = () => '',
    taskMatchesAgent = () => false,
    taskMatchesText = () => false,
    taskAppId = () => '',
  } = filters

  const q = String(textQuery || '').trim().toLowerCase()
  const autoExpand = new Set()

  const markExpandTo = (taskId) => {
    const rid = String(taskId || '').trim()
    if (!rid) return
    autoExpand.add(rid)
    for (const a of ancestorIds(forest.byId, rid)) autoExpand.add(a)
  }

  const treeMatchesStatus = (root) => {
    if (!statusFilter) return true
    // 特殊处理「待办」：根单已交但子单未完成的，也要展示
    if (statusFilter === 'todo') {
      const rootMatches = taskMatchesStatusTab(root.status, 'todo')
      if (rootMatches) return true
      const descendants = collectDescendants(forest, taskIdOf(root))
      return descendants.some((t) => taskMatchesStatusTab(t.status, 'todo'))
    }
    if (taskMatchesStatusTab(root.status, statusFilter)) return true
    return collectDescendants(forest, taskIdOf(root)).some((t) => taskMatchesStatusTab(t.status, statusFilter))
  }

  const treeMatchesApp = (root) => {
    if (!appFilter) return true
    if (taskAppId(root) === appFilter) return true
    return collectDescendants(forest, taskIdOf(root)).some((t) => taskAppId(t) === appFilter)
  }

  const treeMatchesSource = (root) => {
    if (!sourceFilter) return true
    if (sourceKey(root) === sourceFilter) return true
    return collectDescendants(forest, taskIdOf(root)).some((t) => sourceKey(t) === sourceFilter)
  }

  const treeMatchesAgent = (root) => {
    if (!agentFilter) return true
    if (taskMatchesAgent(root, agentFilter)) return true
    for (const t of collectDescendants(forest, taskIdOf(root))) {
      if (taskMatchesAgent(t, agentFilter)) {
        markExpandTo(taskIdOf(t))
        return true
      }
    }
    return false
  }

  const treeMatchesText = (root) => {
    if (!q) return true
    if (taskMatchesText(root, q)) return true
    for (const t of collectDescendants(forest, taskIdOf(root))) {
      if (taskMatchesText(t, q)) {
        markExpandTo(taskIdOf(t))
        return true
      }
    }
    return false
  }

  const roots = []
  for (const root of forest.roots) {
    if (!treeMatchesStatus(root)) continue
    if (!treeMatchesSource(root)) continue
    if (!treeMatchesApp(root)) continue
    if (!treeMatchesAgent(root)) continue
    if (!treeMatchesText(root)) continue
    roots.push(root)
  }

  return {
    roots,
    forest,
    autoExpandIds: [...autoExpand],
  }
}

function collectDescendants(forest, rootId) {
  const out = []
  const queue = [...directChildrenOf(forest, rootId)]
  const seen = new Set()
  while (queue.length) {
    const t = queue.shift()
    const id = taskIdOf(t)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(t)
    queue.push(...directChildrenOf(forest, id))
  }
  return out
}

/**
 * Flatten roots page into display rows with depth (maxDepth caps nest in list).
 * @param {object[]} rootsPage
 * @param {ReturnType<typeof buildTaskForest>} forest
 * @param {Set<string>|string[]} expandedIds
 * @param {{ maxDepth?: number }} [opts]
 * @returns {{ task: object, depth: number, childCount: number, rollup: ReturnType<typeof childRollup> }[]}
 */
export function flattenTaskRows(rootsPage, forest, expandedIds, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 2
  const expanded = expandedIds instanceof Set
    ? expandedIds
    : new Set(Array.isArray(expandedIds) ? expandedIds : [])

  const rows = []
  const walk = (task, depth) => {
    const id = taskIdOf(task)
    const kids = directChildrenOf(forest, id)
    const rollup = childRollup(forest, id)
    rows.push({
      task,
      depth,
      childCount: kids.length,
      rollup,
    })
    if (depth >= maxDepth) return
    if (!id || !expanded.has(id) || !kids.length) return
    for (const child of kids) walk(child, depth + 1)
  }

  for (const root of rootsPage || []) walk(root, 0)
  return rows
}

/** Visible roots only — for status cards / today strip. */
export function rootTasksOnly(tasks) {
  return buildTaskForest(tasks).roots
}
