/**
 * 文件预览视图判定：按文件格式（扩展名 + 内容嗅探）决定
 * 「渲染预览 / 源码」是否可切换，以及当前该渲染哪一种。
 *
 * 纯函数，供 WorkspaceFilePreviewPane 与单测共用。
 * 注意：本模块不 import 组件（避免把 CSS / React 依赖带进纯逻辑测试）。
 */

/** @typedef {'markdown' | 'html' | 'svg' | 'json' | 'csv' | 'mermaid' | 'code'} PreviewDocKind */
/** @typedef {'preview' | 'code'} PreviewViewMode */
/** @typedef {'render' | 'source'} PreviewView */

export const PREVIEW_DOC_MARKDOWN = 'markdown'
export const PREVIEW_DOC_HTML = 'html'
export const PREVIEW_DOC_SVG = 'svg'
export const PREVIEW_DOC_JSON = 'json'
export const PREVIEW_DOC_CSV = 'csv'
export const PREVIEW_DOC_MERMAID = 'mermaid'
export const PREVIEW_DOC_CODE = 'code'

/** 有「渲染预览 / 源码」两种形态的文档类型。 */
const RENDERABLE_KINDS = new Set([
  PREVIEW_DOC_MARKDOWN,
  PREVIEW_DOC_HTML,
  PREVIEW_DOC_SVG,
  PREVIEW_DOC_JSON,
  PREVIEW_DOC_CSV,
  PREVIEW_DOC_MERMAID,
])

/** 这些格式渲染 = 执行内容（iframe / 图片），流式半成品不值得实时渲染。 */
const STREAM_SOURCE_ONLY_KINDS = new Set([PREVIEW_DOC_HTML, PREVIEW_DOC_SVG, PREVIEW_DOC_MERMAID])

/** 扩展名嗅探 Markdown。 */
export function isMarkdownPreviewPath(pathOrName) {
  return /\.(md|markdown|mdx)$/i.test(String(pathOrName || '').trim())
}

/** 扩展名嗅探 HTML。 */
export function isHtmlPreviewPath(pathOrName) {
  return /\.(html?|htm)$/i.test(String(pathOrName || '').trim())
}

/** 扩展名嗅探 SVG。 */
export function isSvgPreviewPath(pathOrName) {
  return /\.svg$/i.test(String(pathOrName || '').trim())
}

/** 扩展名嗅探 JSON（含 JSONC / geo 等以 json 结尾的变体）。 */
export function isJsonPreviewPath(pathOrName) {
  return /\.(json|jsonc|json5|geojson)$/i.test(String(pathOrName || '').trim())
}

/** 扩展名嗅探 CSV / TSV。 */
export function isCsvPreviewPath(pathOrName) {
  return /\.(csv|tsv)$/i.test(String(pathOrName || '').trim())
}

/** 扩展名嗅探 Mermaid 图定义文件。 */
export function isMermaidPreviewPath(pathOrName) {
  return /\.(mmd|mermaid)$/i.test(String(pathOrName || '').trim())
}

/** 内容嗅探：允许无扩展名/流式写入的片段也识别成 HTML。 */
export function looksLikeHtmlContent(content) {
  const raw = String(content || '')
  if (!raw.trim()) return false
  return /<!DOCTYPE|<html[\s>]/i.test(raw)
}

/** 内容嗅探 SVG（无扩展名时兜底）。 */
export function looksLikeSvgContent(content) {
  const raw = String(content || '').trim()
  if (!raw) return false
  return raw.startsWith('<svg') || /<svg[\s>]/i.test(raw.slice(0, 512))
}

/** 内容嗅探 Mermaid 图（以流程图/时序图等图表关键字开头）。 */
export function looksLikeMermaidContent(content) {
  const raw = String(content || '').trim()
  if (!raw) return false
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|quadrantChart|mindmap|timeline|gitGraph|xychart-beta|block-beta|packet-beta|architecture-beta|C4\w*)\b/m.test(
    raw,
  )
}

/**
 * 判断预览文档类型。顺序即优先级：Markdown > HTML > SVG > Mermaid > JSON > CSV > 其它源码。
 * @param {{ path?: string, name?: string, content?: string }} file
 * @returns {PreviewDocKind}
 */
export function previewDocKind({ path = '', name = '', content = '' } = {}) {
  if (isMarkdownPreviewPath(path) || isMarkdownPreviewPath(name)) return PREVIEW_DOC_MARKDOWN
  if (isHtmlPreviewPath(path) || isHtmlPreviewPath(name)) return PREVIEW_DOC_HTML
  if (isSvgPreviewPath(path) || isSvgPreviewPath(name)) return PREVIEW_DOC_SVG
  if (isMermaidPreviewPath(path) || isMermaidPreviewPath(name)) return PREVIEW_DOC_MERMAID
  if (isJsonPreviewPath(path) || isJsonPreviewPath(name)) return PREVIEW_DOC_JSON
  if (isCsvPreviewPath(path) || isCsvPreviewPath(name)) return PREVIEW_DOC_CSV
  // 无扩展名（或流式写入尚未拿到 path）时按内容兜底。
  if (!path && !name) {
    if (looksLikeHtmlContent(content)) return PREVIEW_DOC_HTML
    if (looksLikeSvgContent(content)) return PREVIEW_DOC_SVG
    if (looksLikeMermaidContent(content)) return PREVIEW_DOC_MERMAID
  }
  return PREVIEW_DOC_CODE
}

/**
 * 该文档是否值得给「预览 / 源码」切换。
 * - 二进制、读取出错：不切换
 * - 渲染即执行内容的格式（HTML / SVG / Mermaid）流式生成中不切换，固定源码，
 *   避免半截文档反复重排 iframe / 图片；Markdown、JSON、CSV 流式仍可切换。
 */
export function canToggleSource(kind, { binary = false, error = '', streaming = false } = {}) {
  if (!RENDERABLE_KINDS.has(kind)) return false
  if (binary || error) return false
  if (STREAM_SOURCE_ONLY_KINDS.has(kind) && streaming) return false
  return true
}

/**
 * 解析最终展示形态。
 * @param {PreviewDocKind} kind
 * @param {PreviewViewMode} viewMode
 * @param {{ streaming?: boolean }} [state]
 * @returns {PreviewView}
 */
export function resolvePreviewView(kind, viewMode, { streaming = false } = {}) {
  if (!RENDERABLE_KINDS.has(kind)) return 'source'
  if (STREAM_SOURCE_ONLY_KINDS.has(kind) && streaming) return 'source'
  return viewMode === 'code' ? 'source' : 'render'
}

/** 顶部「渲染 / 源码」分段按钮的文案（按格式给更贴切的词）。 */
export function previewRenderLabel(kind) {
  switch (kind) {
    case PREVIEW_DOC_MARKDOWN:
      return '预览'
    case PREVIEW_DOC_CSV:
      return '表格'
    case PREVIEW_DOC_JSON:
      return '格式化'
    case PREVIEW_DOC_MERMAID:
      return '图表'
    default:
      return '渲染'
  }
}
