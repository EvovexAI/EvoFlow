/**
 * Build a mind-map tree from exploration graph nodes (goal root + parent_external_id).
 */

import {
  filterProcessingNodes,
  isProcessingNodeStatus,
  normalizeNodeStatus,
} from './knowledge-map-node-status.js'

export { isProcessingNodeStatus, normalizeNodeStatus } from './knowledge-map-node-status.js'

const KIND_LABEL = {
  file: '文件',
  symbol: '符号',
  module: '模块',
  flow: '链路',
  gap: '待查',
  note: '事项',
  hypothesis: '假设',
  doc: '文档',
  section: '章节',
  claim: '结论',
  source: '来源',
  task: '任务',
  decision: '决策',
  goal: '目标',
  diagram: '图表',
}

const KIND_BRANCH_ORDER = ['flow', 'gap', 'claim', 'diagram', 'file', 'module', 'symbol', 'doc', 'task', 'decision', 'note', 'hypothesis']

const SYNTHETIC_ROOT = '__km_root__'
const SYNTHETIC_KIND_PREFIX = '__km_kind__'

/**
 * @param {{ goal?: string, nodes?: Array<Record<string, unknown>>, edges?: Array<Record<string, unknown>> }} input
 */
export function buildKnowledgeMapTree(input) {
  const goal = String(input?.goal || '').trim()
  const rawNodes = Array.isArray(input?.nodes) ? input.nodes : []
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map()
  for (const n of rawNodes) {
    const id = String(n?.external_id || '').trim()
    if (id) byId.set(id, n)
  }

  /** @type {Map<string, string[]>} */
  const childrenOf = new Map()
  /** @type {Map<string, string>} first parent wins; used to reject cycles */
  const parentOf = new Map()
  /** @type {Set<string>} */
  const hasParent = new Set()

  /** True if linking parentId → childId would introduce a cycle in the forest. */
  const wouldCreateCycle = (parentId, childId) => {
    let cur = parentId
    const seen = new Set()
    while (cur) {
      if (cur === childId) return true
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = parentOf.get(cur)
    }
    return false
  }

  const addChild = (parentId, childId) => {
    const p = String(parentId || '').trim()
    const c = String(childId || '').trim()
    if (!p || !c || p === c) return
    if (wouldCreateCycle(p, c)) return
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    const list = childrenOf.get(p)
    if (!list.includes(c)) list.push(c)
    if (!parentOf.has(c)) parentOf.set(c, p)
  }

  // parent_external_id links
  for (const n of rawNodes) {
    const id = String(n?.external_id || '').trim()
    const parent = String(n?.parent_external_id || '').trim()
    if (!id || !parent) continue
    if (parent === id) continue
    if (byId.has(parent) || parent === SYNTHETIC_ROOT || parent.startsWith(SYNTHETIC_KIND_PREFIX)) {
      addChild(parent, id)
      hasParent.add(id)
    }
  }

  // goal:session children attach under root
  for (const n of rawNodes) {
    const id = String(n?.external_id || '').trim()
    if (!id) continue
    if (String(n?.parent_external_id || '').trim() === 'goal:session') {
      addChild(SYNTHETIC_ROOT, id)
      hasParent.add(id)
    }
  }

  /** @type {Map<string, string[]>} */
  const orphansByKind = new Map()
  for (const n of rawNodes) {
    const id = String(n?.external_id || '').trim()
    if (!id || hasParent.has(id)) continue
    if (id === 'goal:session' && goal) continue
    const kind = String(n?.kind || 'note').trim().toLowerCase() || 'note'
    if (!orphansByKind.has(kind)) orphansByKind.set(kind, [])
    orphansByKind.get(kind).push(id)
  }

  const sortIds = (ids) =>
    [...ids].sort((a, b) => {
      const na = byId.get(a)
      const nb = byId.get(b)
      const sa = String(na?.sort_order ?? 0)
      const sb = String(nb?.sort_order ?? 0)
      if (sa !== sb) return Number(sa) - Number(sb)
      return String(a).localeCompare(String(b), undefined, { numeric: true })
    })

  for (const kind of KIND_BRANCH_ORDER) {
    const ids = orphansByKind.get(kind)
    if (!ids?.length) continue
    const branchId = `${SYNTHETIC_KIND_PREFIX}${kind}`
    addChild(SYNTHETIC_ROOT, branchId)
    for (const id of sortIds(ids)) addChild(branchId, id)
    orphansByKind.delete(kind)
  }
  for (const [kind, ids] of orphansByKind) {
    const branchId = `${SYNTHETIC_KIND_PREFIX}${kind}`
    addChild(SYNTHETIC_ROOT, branchId)
    for (const id of sortIds(ids)) addChild(branchId, id)
  }

  // edge-derived children (when no parent set)
  const edges = Array.isArray(input?.edges) ? input.edges : []
  for (const e of edges) {
    const fromId = String(e?.from_external_id || '').trim()
    const toId = String(e?.to_external_id || '').trim()
    if (!fromId || !toId || fromId === toId) continue
    if (!byId.has(fromId) || !byId.has(toId)) continue
    if (hasParent.has(toId)) continue
    addChild(fromId, toId)
    hasParent.add(toId)
  }

  return {
    rootId: SYNTHETIC_ROOT,
    goal,
    byId,
    childrenOf,
    kindLabel: (kind) => KIND_LABEL[String(kind || '').toLowerCase()] || kind || '节点',
    isSynthetic: (id) => {
      const s = String(id || '')
      return s === SYNTHETIC_ROOT || s.startsWith(SYNTHETIC_KIND_PREFIX)
    },
    syntheticLabel: (id) => {
      const s = String(id || '')
      if (s === SYNTHETIC_ROOT) return goal || '目标'
      if (s.startsWith(SYNTHETIC_KIND_PREFIX)) {
        const kind = s.slice(SYNTHETIC_KIND_PREFIX.length)
        return KIND_LABEL[kind] || kind
      }
      return ''
    },
  }
}

export function nodeDisplayTitle(node, externalId) {
  const id = String(externalId || '').trim()
  const title = String(node?.title || '').trim()
  const body = String(node?.body || '').trim()
  if (title) return title
  if (body) return body.length > 72 ? `${body.slice(0, 71)}…` : body
  return id || '未命名'
}

/** @param {string | undefined | null} status */
export function nodeStatusLabel(status) {
  switch (normalizeNodeStatus(status)) {
    case 'active':
      return '进行中'
    case 'stale':
      return '待更新'
    case 'resolved':
      return '已解决'
    case 'verified':
      return '已验证'
    case 'refuted':
      return '已推翻'
    case 'blocked':
      return '阻塞'
    case 'parked':
      return '搁置'
    case 'collapsed':
      return '已折叠'
    default:
      return normalizeNodeStatus(status)
  }
}

/** @param {Array<{ status?: string, kind?: string }> | undefined | null} nodes */
export function countProcessingNodes(nodes) {
  return filterProcessingNodes(nodes).length
}

const PROCESSING_KIND_PRIORITY = ['flow', 'gap', 'task', 'hypothesis']

function processingKindRank(kind) {
  const k = String(kind || 'note').trim().toLowerCase()
  const idx = PROCESSING_KIND_PRIORITY.indexOf(k)
  return idx >= 0 ? idx : PROCESSING_KIND_PRIORITY.length
}

/** @param {Record<string, unknown> | null | undefined} node */
export function nodeActivityTimestamp(node) {
  const raw = String(node?.updated_at || node?.updatedAt || node?.created_at || node?.createdAt || '').trim()
  if (!raw) return 0
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * @param {Record<string, unknown> | null | undefined} node
 * @param {number} [nowMs]
 */
export function formatNodeActivityLabel(node, nowMs = Date.now()) {
  const ts = nodeActivityTimestamp(node)
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date(nowMs)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return `今天 ${time}`
  if (sameDay(d, yesterday)) return `昨天 ${time}`
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/**
 * @param {Array<{ external_id?: string, kind?: string, status?: string, body?: string, title?: string, updated_at?: string, created_at?: string }> | undefined | null} nodes
 */
export function sortProcessingNodes(nodes) {
  return [...filterProcessingNodes(nodes)].sort((a, b) => {
      const tb = nodeActivityTimestamp(b)
      const ta = nodeActivityTimestamp(a)
      if (tb !== ta) return tb - ta
      const ra = processingKindRank(a?.kind)
      const rb = processingKindRank(b?.kind)
      if (ra !== rb) return ra - rb
      return String(a?.external_id || '').localeCompare(String(b?.external_id || ''))
    })
}

/**
 * Pick the best in-progress node to show in the detail popover (flow/gap with body first).
 * @param {Array<{ external_id?: string, kind?: string, status?: string, body?: string, title?: string }> | undefined | null} nodes
 */
export function pickPrimaryProcessingNodeId(nodes) {
  const sorted = sortProcessingNodes(nodes)
  const first = sorted[0]
  return first ? String(first.external_id || '').trim() : ''
}
