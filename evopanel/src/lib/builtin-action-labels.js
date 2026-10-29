/**
 * 独立 builtin 工具（tasks / assets / knowledge）的 action 中文枚举。
 * 与 ``tasks_tool`` / ``assets_tool`` / ``knowledge_tool`` 的 action 字面量对齐；
 * 折叠条用短标签，流式半截 JSON 也能靠 action 字段出字。
 *
 * 注意：这不是 platform(action=tasks.*) / platform(action=assets.*) /
 * platform(action=knowledge.*)——那条走 ``platform-action-labels.js``。
 */

/** @type {Record<string, string>} */
export const TASKS_ACTION_ZH = {
  create: '创建任务',
  progress: '更新进度',
  state: '结案/改状态',
  delete: '删除任务',
  list: '列出任务',
  get: '查看任务',
}

/** @type {Record<string, string>} */
export const ASSETS_ACTION_ZH = {
  search: '检索资产',
  read: '读取资产',
  list: '列出资产',
  note: '写入笔记',
  profile: '更新画像',
}

/** @type {Record<string, string>} */
export const KNOWLEDGE_ACTION_ZH = {
  search: '检索知识库',
  read: '读取文档',
  list: '列出知识库',
}

/**
 * @param {unknown} input
 * @returns {string}
 */
export function readNamedToolAction(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const direct = String(/** @type {Record<string, unknown>} */ (input).action || '').trim()
    if (direct) return direct
  }
  if (typeof input === 'string') {
    const m = input.match(/"action"\s*:\s*"([^"]+)"/)
    if (m?.[1]) return m[1].trim()
  }
  return ''
}

/**
 * @param {string | null | undefined} action
 * @param {Record<string, string>} map
 * @param {string} fallback
 * @returns {string}
 */
export function builtinActionLabelZh(action, map, fallback) {
  const raw = String(action || '').trim()
  if (!raw) return fallback
  const hit = map[raw] || map[raw.toLowerCase()]
  return hit || raw
}

/**
 * @param {string | null | undefined} action
 * @param {{ max?: number }} [opts]
 */
export function tasksActionLabelZh(action, opts) {
  const label = builtinActionLabelZh(action, TASKS_ACTION_ZH, '员工任务')
  const max = opts?.max ?? 24
  return label.length <= max ? label : `${label.slice(0, max)}…`
}

/**
 * @param {string | null | undefined} action
 * @param {{ max?: number }} [opts]
 */
export function assetsActionLabelZh(action, opts) {
  const label = builtinActionLabelZh(action, ASSETS_ACTION_ZH, '资产')
  const max = opts?.max ?? 24
  return label.length <= max ? label : `${label.slice(0, max)}…`
}

/**
 * @param {string | null | undefined} action
 * @param {{ max?: number }} [opts]
 */
export function knowledgeActionLabelZh(action, opts) {
  const label = builtinActionLabelZh(action, KNOWLEDGE_ACTION_ZH, '知识库')
  const max = opts?.max ?? 24
  return label.length <= max ? label : `${label.slice(0, max)}…`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asTrimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function clip(value, max) {
  const s = asTrimmed(value)
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 折叠条右侧摘要：任务名 / 状态 / id（不堆长正文）。
 * @param {unknown} input
 */
export function readTasksToolBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string') {
      const name = input.match(/"name"\s*:\s*"([^"]+)"/)
      if (name?.[1]) return clip(name[1], 40)
      const tid = input.match(/"task_id"\s*:\s*"([^"]+)"/)
      if (tid?.[1]) return clip(tid[1], 40)
    }
    return ''
  }
  const row = /** @type {Record<string, unknown>} */ (input)
  const status = asTrimmed(row.status)
  const progress = row.progress
  const progressBit =
    typeof progress === 'number' && Number.isFinite(progress)
      ? `${Math.max(0, Math.min(100, Math.round(progress)))}%`
      : asTrimmed(progress)
  const candidates = [
    row.name,
    row.summary,
    status && progressBit ? `${status} · ${progressBit}` : status || progressBit,
    row.task_id,
    row.taskId,
    row.query,
  ]
  for (const c of candidates) {
    const s = clip(c, 40)
    if (s) return s
  }
  return ''
}

/**
 * 折叠条右侧摘要：检索词 / 路径 / 画像维度。
 * @param {unknown} input
 */
export function readAssetsToolBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string') {
      const q = input.match(/"query"\s*:\s*"([^"]+)"/)
      if (q?.[1]) return clip(q[1], 40)
      const p = input.match(/"path"\s*:\s*"([^"]+)"/)
      if (p?.[1]) return clip(p[1], 40)
    }
    return ''
  }
  const row = /** @type {Record<string, unknown>} */ (input)
  const candidates = [
    row.query,
    row.path,
    row.kinds,
    row.entity_type || row.entityType,
    row.scope,
  ]
  for (const c of candidates) {
    const s = clip(c, 40)
    if (s) return s
  }
  // note/profile 正文太长：只露一行前缀
  const content = clip(row.content, 36)
  return content
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pathLeaf(value) {
  const raw = asTrimmed(value).replace(/\\/g, '/')
  if (!raw) return ''
  const parts = raw.split('/').filter(Boolean)
  return parts[parts.length - 1] || raw
}

/**
 * 折叠条右侧摘要：检索词 / 文档名（不暴露 doc_id）。
 * @param {unknown} input
 */
export function readKnowledgeToolBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string') {
      // 允许流式半截 JSON（末尾尚未闭合引号）
      const q = input.match(/"query"\s*:\s*"([^"]+)/)
      if (q?.[1]) return clip(q[1], 40)
      const title = input.match(/"title"\s*:\s*"([^"]+)/)
      if (title?.[1]) return clip(title[1], 40)
      const path = input.match(/"path"\s*:\s*"([^"]+)/)
      if (path?.[1]) return clip(pathLeaf(path[1]), 40)
    }
    return ''
  }
  const row = /** @type {Record<string, unknown>} */ (input)
  const paths = Array.isArray(row.paths) ? row.paths : []
  const firstPath = paths.map((p) => pathLeaf(p)).find(Boolean) || ''
  const candidates = [
    row.query,
    row.title,
    row.name,
    firstPath,
    pathLeaf(row.path),
    row.prefix,
    // knowledge_base 可能是可读名；纯 uuid 也比空摘要更有用，但仍截短
    asTrimmed(row.knowledge_base || row.knowledgeBase),
  ]
  for (const c of candidates) {
    const s = clip(c, 40)
    if (s) return s
  }
  return ''
}
