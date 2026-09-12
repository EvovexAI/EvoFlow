/**
 * Diagram detection and labels for mind map nodes (Mermaid in body or kind=diagram).
 */

import { looksLikeMermaidSource, stripMermaidFence } from './mermaid-code.js'

/** @type {Record<string, string>} */
export const DIAGRAM_TYPE_LABEL_ZH = {
  flowchart: '流程图',
  sequence: '时序图',
  state: '状态图',
  class: '类图',
  er: 'ER 图',
  architecture: '架构图',
  mindmap: '思维导图',
  gantt: '甘特图',
  journey: '用户旅程',
  git: 'Git 图',
  block: '块图',
  c4: 'C4 图',
  quadrant: '象限图',
  timeline: '时间线',
  ishikawa: '鱼骨图',
}

const MERMAID_BLOCK_RE = /```(?:mermaid)?\s*\n?([\s\S]*?)```/gi

const DETECT_RULES = [
  ['sequence', /^sequenceDiagram\b/im],
  ['state', /^stateDiagram(?:-v2)?\b/im],
  ['class', /^classDiagram\b/im],
  ['er', /^erDiagram\b/im],
  ['gantt', /^gantt\b/im],
  ['journey', /^journey\b/im],
  ['mindmap', /^mindmap\b/im],
  ['git', /^gitGraph\b/im],
  ['architecture', /^architecture(?:-beta)?\b/im],
  ['block', /^block(?:-beta)?\b/im],
  ['c4', /^C4(?:Context|Container|Component|Dynamic|Deployment)\b/im],
  ['quadrant', /^quadrantChart\b/im],
  ['timeline', /^timeline\b/im],
  ['ishikawa', /^ishikawa\b/im],
  ['flowchart', /^(?:flowchart|graph)\b/im],
]

/** @param {unknown} raw */
export function normalizeDiagramType(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
  if (!key) return ''
  const aliases = {
    flow: 'flowchart',
    seq: 'sequence',
    sequence_diagram: 'sequence',
    state_diagram: 'state',
    class_diagram: 'class',
    er_diagram: 'er',
    arch: 'architecture',
  }
  return aliases[key] || key
}

/** @param {string} source */
export function detectDiagramTypeFromSource(source) {
  const text = stripMermaidFence(source)
  for (const [dtype, pattern] of DETECT_RULES) {
    if (pattern.test(text)) return dtype
  }
  return ''
}

/** @param {string} dtype */
export function diagramTypeLabel(dtype) {
  const key = normalizeDiagramType(dtype)
  return DIAGRAM_TYPE_LABEL_ZH[key] || '图表'
}

/**
 * @param {{ kind?: string, external_id?: string, body?: string, meta?: Record<string, unknown> } | null | undefined} node
 */
export function resolveNodeDiagramType(node) {
  const meta = node?.meta && typeof node.meta === 'object' ? node.meta : {}
  const fromMeta = normalizeDiagramType(meta.diagram_type)
  if (fromMeta) return fromMeta
  const kind = String(node?.kind || '').trim().toLowerCase()
  const id = String(node?.external_id || '').trim().toLowerCase()
  if (kind === 'diagram' || id.startsWith('diagram:')) {
    const detected = detectDiagramTypeFromSource(String(node?.body || ''))
    if (detected) return detected
  }
  return detectDiagramTypeFromSource(String(node?.body || ''))
}

/**
 * @param {{ kind?: string, external_id?: string, body?: string, meta?: Record<string, unknown> } | null | undefined} node
 */
export function extractMermaidFromNode(node) {
  const body = String(node?.body || '').trim()
  if (!body) return ''
  const kind = String(node?.kind || '').trim().toLowerCase()
  const id = String(node?.external_id || '').trim().toLowerCase()
  if (kind === 'diagram' || id.startsWith('diagram:')) {
    return stripMermaidFence(body)
  }
  const blocks = [...body.matchAll(MERMAID_BLOCK_RE)]
  if (blocks.length) return stripMermaidFence(blocks[blocks.length - 1][1] || '')
  if (looksLikeMermaidSource(body)) return stripMermaidFence(body)
  return ''
}

/**
 * @param {{ kind?: string, external_id?: string, body?: string, meta?: Record<string, unknown> } | null | undefined} node
 */
export function nodeHasDiagram(node) {
  return Boolean(extractMermaidFromNode(node))
}

/**
 * Plain text remaining after removing mermaid blocks / bare mermaid source.
 * @param {string} body
 */
export function bodyTextWithoutMermaid(body) {
  let text = String(body || '').trim()
  if (!text) return ''
  text = text.replace(MERMAID_BLOCK_RE, '').trim()
  if (looksLikeMermaidSource(text)) return ''
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
