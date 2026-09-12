/**
 * User-editable mind map node statuses (mirrors backend node_status.py).
 */

/** Kinds where status lifecycle is meaningful (work tracking). */
export const STATUS_TRACKED_KINDS = new Set(['flow', 'gap', 'task', 'hypothesis'])

/** Parent closed — descendants should not appear as in-progress. */
export const CLOSED_NODE_STATUSES = new Set([
  'resolved',
  'verified',
  'refuted',
  'blocked',
  'parked',
  'collapsed',
])

const KIND_PREFIX_MAP = {
  'goal:': 'goal',
  'flow:': 'flow',
  'gap:': 'gap',
  'claim:': 'claim',
  'file:': 'file',
  'diagram:': 'diagram',
  'task:': 'task',
  'note:': 'note',
}

/** Done / closed — folded into a collapsed "已归档" section (mirrors backend ARCHIVED_NODE_STATUSES). */
export const ARCHIVED_NODE_STATUSES = new Set(['resolved', 'verified', 'refuted', 'blocked'])

/** On hold — folded into a separate "已搁置" section (mirrors backend PARKED_NODE_STATUSES). */
export const PARKED_NODE_STATUSES = new Set(['parked'])

/** Hidden from rendering entirely (mirrors backend COLLAPSED_STATUS). */
export const COLLAPSED_STATUS = 'collapsed'

/** @param {string | undefined | null} status */
export function normalizeNodeStatus(status) {
  const s = String(status || 'active').trim().toLowerCase()
  return s || 'active'
}

/** @param {string | undefined | null} status */
export function isArchivedNodeStatus(status) {
  return ARCHIVED_NODE_STATUSES.has(normalizeNodeStatus(status))
}

/** @param {string | undefined | null} status */
export function isParkedNodeStatus(status) {
  return PARKED_NODE_STATUSES.has(normalizeNodeStatus(status))
}

/** @param {string | undefined | null} status */
export function isCollapsedNodeStatus(status) {
  return normalizeNodeStatus(status) === COLLAPSED_STATUS
}

/**
 * Classify a node status into a render bucket.
 * @param {string | undefined | null} status
 * @returns {'active' | 'archived' | 'parked' | 'collapsed'}
 */
export function classifyNodeStatus(status) {
  const s = normalizeNodeStatus(status)
  if (s === COLLAPSED_STATUS) return 'collapsed'
  if (ARCHIVED_NODE_STATUSES.has(s)) return 'archived'
  if (PARKED_NODE_STATUSES.has(s)) return 'parked'
  return 'active'
}

/** @param {string | undefined | null} status */
export function isProcessingNodeStatus(status) {
  const s = normalizeNodeStatus(status)
  return s === 'active' || s === 'stale'
}

/** @type {{ value: string, label: string, hint?: string, primary?: boolean }[]} */
export const USER_NODE_STATUS_OPTIONS = [
  { value: 'parked', label: '搁置', hint: '不再跟进，但未声称已解决', primary: true },
  { value: 'active', label: '进行中', hint: '重新标记为需要处理' },
  { value: 'resolved', label: '已解决', hint: '问题已处理完毕' },
  { value: 'verified', label: '已验证', hint: '修复/结论已验证' },
  { value: 'refuted', label: '已推翻', hint: '假设或方向被排除' },
  { value: 'blocked', label: '阻塞', hint: '外部依赖导致无法继续' },
  { value: 'collapsed', label: '折叠', hint: '从模型上下文隐藏此分支' },
]

const USER_PATCHABLE = new Set(USER_NODE_STATUS_OPTIONS.map((o) => o.value))

/** @param {string | undefined | null} kind @param {string | undefined | null} externalId */
export function effectiveNodeKind(kind, externalId) {
  const k = String(kind || '').trim().toLowerCase()
  if (k && k !== 'note') return k
  const id = String(externalId || '').trim().toLowerCase()
  for (const [prefix, inferred] of Object.entries(KIND_PREFIX_MAP)) {
    if (id.startsWith(prefix)) return inferred
  }
  return k || 'note'
}

/** @param {string | undefined | null} kind @param {string | undefined | null} externalId */
export function isStatusTrackedKind(kind, externalId) {
  return STATUS_TRACKED_KINDS.has(effectiveNodeKind(kind, externalId))
}

/** @param {string | undefined | null} status */
export function isUserPatchableStatus(status) {
  return USER_PATCHABLE.has(normalizeNodeStatus(status))
}

/** @param {string | undefined | null} status */
export function isClosedNodeStatus(status) {
  return CLOSED_NODE_STATUSES.has(normalizeNodeStatus(status))
}

/**
 * @param {string | undefined | null} nodeId
 * @param {string | undefined | null} [kind]
 */
export function canUserEditNodeStatus(nodeId, kind) {
  const id = String(nodeId || '').trim()
  if (!id || id === 'goal:session' || id.startsWith('__km_')) return false
  return isStatusTrackedKind(kind, id)
}

/** @param {string | undefined | null} status */
export function userStatusOptionLabel(status) {
  const s = normalizeNodeStatus(status)
  const hit = USER_NODE_STATUS_OPTIONS.find((o) => o.value === s)
  if (hit) return hit.label
  switch (s) {
    case 'active':
      return '进行中'
    case 'stale':
      return '待更新'
    default:
      return s
  }
}

/**
 * Tracked work nodes actively in-progress (flow/gap/task/hypothesis only).
 * Used for sidebar, canvas highlight, and status badges.
 * @param {Array<Record<string, unknown>> | undefined | null} nodes
 */
export function filterProcessingNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return []
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map()
  for (const n of nodes) {
    const id = String(n?.external_id || '').trim()
    if (id) byId.set(id, n)
  }
  const parentOf = buildNodeParentMap(nodes)
  return nodes.filter((n) => {
    const id = String(n?.external_id || '').trim()
    if (!id || id === 'goal:session' || id.startsWith('__km_')) return false
    if (!isStatusTrackedKind(n?.kind, id)) return false
    if (!isProcessingNodeStatus(n?.status)) return false
    if (hasClosedAncestor(n, byId, parentOf)) return false
    return true
  })
}

/** @param {string | undefined | null} kind @param {string | undefined | null} externalId */
export function shouldDisplayNodeStatus(kind, externalId) {
  return isStatusTrackedKind(kind, externalId)
}

/** Alias — same as filterProcessingNodes. */
export function filterTrackedProcessingNodes(nodes) {
  return filterProcessingNodes(nodes)
}

/**
 * Build parent lookup from flat node list.
 * @param {Array<{ external_id?: string, parent_external_id?: string | null }> | undefined | null} nodes
 */
export function buildNodeParentMap(nodes) {
  /** @type {Map<string, string>} */
  const parentOf = new Map()
  if (!Array.isArray(nodes)) return parentOf
  for (const n of nodes) {
    const id = String(n?.external_id || '').trim()
    const parent = String(n?.parent_external_id || '').trim()
    if (id && parent) parentOf.set(id, parent)
  }
  return parentOf
}

/**
 * @param {Record<string, unknown> | null | undefined} node
 * @param {Map<string, Record<string, unknown>>} byId
 * @param {Map<string, string>} parentOf
 */
export function hasClosedAncestor(node, byId, parentOf) {
  let cur = String(node?.parent_external_id || '').trim()
  const walked = new Set()
  while (cur) {
    if (walked.has(cur)) break
    walked.add(cur)
    const p = byId.get(cur)
    if (p && isClosedNodeStatus(p.status)) return true
    cur = parentOf.get(cur) || ''
  }
  return false
}
