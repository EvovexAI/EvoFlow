/**
 * 助手正文中的 `@@路径@@` 交付物聚合（@@ 协议与 workspace-file-mention-display 同源）。
 *
 * 从回合原文提取模型标记的交付物并按扩展名分类，供回合末尾的交付物卡片使用：
 * - 跳过围栏代码块内的 @@（示例原文不是交付）；
 * - 同路径去重（大小写不敏感，Windows 语义）。
 */

/** @typedef {'web' | 'image' | 'video' | 'audio' | 'doc' | 'data' | 'code' | 'file'} DeliverableKind */

/**
 * @typedef {Object} TurnDeliverable
 * @property {string} path
 * @property {string} name
 * @property {DeliverableKind} kind
 * @property {string} label 类型中文标签（卡片角标）
 */

const FENCE_RE = /```[\w]*\r?\n[\s\S]*?```/g
const AT_PATH_CLOSED_RE = /@@([^@\r\n]+?)@@/gi

/** @type {ReadonlyArray<readonly [string, DeliverableKind, string]>} */
const EXT_KIND_RULES = [
  ['.html', 'web', '网页'],
  ['.htm', 'web', '网页'],
  ['.png', 'image', '图片'],
  ['.jpg', 'image', '图片'],
  ['.jpeg', 'image', '图片'],
  ['.gif', 'image', '图片'],
  ['.webp', 'image', '图片'],
  ['.svg', 'image', '图片'],
  ['.mp4', 'video', '视频'],
  ['.webm', 'video', '视频'],
  ['.mov', 'video', '视频'],
  ['.mp3', 'audio', '音频'],
  ['.wav', 'audio', '音频'],
  ['.md', 'doc', '文档'],
  ['.docx', 'doc', '文档'],
  ['.pdf', 'doc', '文档'],
  ['.xlsx', 'doc', '表格'],
  ['.csv', 'data', '数据'],
  ['.json', 'data', '数据'],
]

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp',
  'cs', 'rb', 'php', 'swift', 'sh', 'sql', 'css', 'scss', 'vue', 'dart', 'lua',
])

/** @param {string} path */
function extOf(path) {
  const leaf = String(path || '').replace(/\\/g, '/').split('/').pop() || ''
  const dot = leaf.lastIndexOf('.')
  return dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : ''
}

/** @param {string} path @returns {{ kind: DeliverableKind, label: string }} */
function classify(path) {
  const ext = extOf(path)
  for (const [ruleExt, kind, label] of EXT_KIND_RULES) {
    if (ext === ruleExt.slice(1)) return { kind, label }
  }
  if (CODE_EXTS.has(ext)) return { kind: 'code', label: '代码' }
  return { kind: 'file', label: '文件' }
}

/** @param {string} path */
function leafName(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

/**
 * 提取一轮回复里的交付物（去重、跳过围栏代码块）。
 * 空串入参快速返回；没有 @@ 时零开销。
 * @param {string} rawText
 * @returns {TurnDeliverable[]}
 */
export function collectTurnDeliverables(rawText) {
  const src = String(rawText || '')
  if (!src.includes('@@')) return []

  /** @type {TurnDeliverable[]} */
  const out = []
  /** @type {Set<string>} */
  const seen = new Set()
  let last = 0
  FENCE_RE.lastIndex = 0
  let fence
  const visit = (chunk) => {
    for (const m of chunk.matchAll(AT_PATH_CLOSED_RE)) {
      const raw = String(m[1] || '').trim()
      if (!raw) continue
      const key = raw.replace(/\\/g, '/').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const { kind, label } = classify(raw)
      out.push({ path: raw, name: leafName(raw), kind, label })
    }
  }
  while ((fence = FENCE_RE.exec(src)) !== null) {
    if (fence.index > last) visit(src.slice(last, fence.index))
    last = fence.index + fence[0].length
  }
  if (last < src.length) visit(src.slice(last))
  return out
}
