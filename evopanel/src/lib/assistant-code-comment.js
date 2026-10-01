/**
 * 助手正文中的行内代码评论（`::code-comment{...}`）提取与投影。
 *
 * 与 `<artifact_display>` 提示词块成对：提示词教模型按协议输出指令，本文件把指令
 * 从正文里投影成结构化评论 + 可渲染卡片，并保证：
 * - 协议原文不出现在用户可见正文里（整行则删行，否则原位留白）；
 * - 围栏/行内代码里的 `::code-comment` 是示例原文，不解析；
 * - 流式未闭合的半截指令 / 协议名前缀尾巴先隐藏，闭合后再转正。
 */

import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
  overlapsAssistantTextRanges,
} from './assistant-directive-parser.js'
import { cleanHostPath, isAbsoluteHostPath } from './workspace-abs-path.js'

/** @typedef {0 | 1 | 2 | 3} AssistantCodeCommentPriority */

/**
 * @typedef {Object} AssistantCodeComment
 * @property {string} title
 * @property {string} body
 * @property {string} file
 * @property {number} [startLine]
 * @property {number} [endLine]
 * @property {AssistantCodeCommentPriority} [priority]
 * @property {number} sourceStart
 * @property {number} sourceEnd
 */

/**
 * @typedef {AssistantCodeComment & { id: string, path: string, displayPath: string }} AssistantCodeCommentCard
 */

/**
 * @typedef {Object} AssistantCodeCommentProjection
 * @property {AssistantCodeComment[]} comments
 * @property {string} visibleText
 */

const CODE_COMMENT_DIRECTIVE_NAME = 'code-comment'

/** code-comment 的宽容面：允许反引号包值（模型常把路径包进行内反引号）；智能引号保持严格。 */
const CODE_COMMENT_SYNTAX_OPTIONS = { allowBacktickQuotes: true }

/** @param {string | undefined} value */
function parsePositiveInteger(value) {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number.parseInt(value, 10)
  return parsed > 0 ? parsed : undefined
}

/** @param {string | undefined} value */
function parsePriority(value) {
  if (!value || !/^[0-3]$/.test(value)) return undefined
  return Number.parseInt(value, 10)
}

/**
 * @param {string} content
 * @returns {AssistantCodeComment[]}
 */
function extractAssistantCodeComments(content) {
  const protectedRanges = findMarkdownCodeRanges(content)
  return extractAssistantDirectives(
    content,
    CODE_COMMENT_DIRECTIVE_NAME,
    CODE_COMMENT_SYNTAX_OPTIONS,
  ).flatMap((directive) => {
    if (
      !directive.parameters ||
      overlapsAssistantTextRanges(directive.start, directive.start + 1, protectedRanges)
    ) {
      return []
    }

    const title = directive.parameters.title?.trim()
    const body = directive.parameters.body?.trim()
    const file = directive.parameters.file?.trim()
    if (!title || !body || !file) return []

    const startLine = parsePositiveInteger(directive.parameters.start)
    const parsedEndLine = parsePositiveInteger(directive.parameters.end)
    const hasValidRange =
      startLine !== undefined && (parsedEndLine === undefined || parsedEndLine >= startLine)
    const priority = parsePriority(directive.parameters.priority)

    return [
      {
        title,
        body,
        file,
        sourceStart: directive.start,
        sourceEnd: directive.end,
        ...(hasValidRange
          ? {
              startLine,
              endLine: parsedEndLine ?? startLine,
            }
          : {}),
        ...(priority !== undefined ? { priority } : {}),
      },
    ]
  })
}

/**
 * 整行独占的指令删整行；行内夹杂的指令原位替换成单个空格，保住两侧 Markdown。
 * @param {string} content
 * @param {AssistantCodeComment} comment
 * @returns {{ start: number, end: number, replacement: string }}
 */
function replacementForComment(content, comment) {
  const lineStart = content.lastIndexOf('\n', comment.sourceStart - 1) + 1
  const nextNewline = content.indexOf('\n', comment.sourceEnd)
  const lineEnd = nextNewline < 0 ? content.length : nextNewline
  const prefix = content.slice(lineStart, comment.sourceStart)
  const suffix = content.slice(comment.sourceEnd, lineEnd)
  if (!prefix.trim() && !suffix.trim()) {
    return {
      start: lineStart,
      end: nextNewline < 0 ? lineEnd : nextNewline + 1,
      replacement: '',
    }
  }
  return {
    start: comment.sourceStart,
    end: comment.sourceEnd,
    replacement: ' ',
  }
}

/**
 * @param {string} content
 * @param {{ streaming?: boolean }} [options]
 * @returns {AssistantCodeCommentProjection}
 */
export function projectAssistantCodeComments(content, options = {}) {
  const comments = extractAssistantCodeComments(content)
  const replacements = comments.map((comment) => replacementForComment(content, comment))

  if (options.streaming) {
    const protectedRanges = findMarkdownCodeRanges(content)
    const unclosedStart = findUnclosedAssistantDirectiveStart(
      content,
      CODE_COMMENT_DIRECTIVE_NAME,
      protectedRanges,
      CODE_COMMENT_SYNTAX_OPTIONS,
    )
    if (unclosedStart !== null) {
      // 流式尾部直接交给 Markdown 会在闭合前把协议原文闪给用户。
      replacements.push({ start: unclosedStart, end: content.length, replacement: '' })
    } else {
      const prefixStart = findAssistantDirectivePrefixStart(
        content,
        [CODE_COMMENT_DIRECTIVE_NAME],
        protectedRanges,
      )
      if (prefixStart !== null) {
        replacements.push({ start: prefixStart, end: content.length, replacement: '' })
      }
    }
  }

  let visibleText = content
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    visibleText =
      visibleText.slice(0, replacement.start) +
      replacement.replacement +
      visibleText.slice(replacement.end)
  }

  return { comments, visibleText }
}

/** @param {string} path */
function normalizeDisplayPath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

/** @param {string} path */
function isWindowsPath(path) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * 工作区内路径转显示用相对路径；工作区外保留归一化后的完整路径。
 * @param {string} workspaceRoot
 * @param {string} path
 */
function displayPathForWorkspace(workspaceRoot, path) {
  const normalizedRoot = normalizeDisplayPath(workspaceRoot)
  const normalizedPath = normalizeDisplayPath(path)
  if (!normalizedRoot) return normalizedPath
  const windows = isWindowsPath(normalizedRoot)
  const comparedRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot
  const comparedPath = windows ? normalizedPath.toLowerCase() : normalizedPath
  if (!comparedPath.startsWith(`${comparedRoot}/`)) return normalizedPath
  return normalizedPath.slice(normalizedRoot.length + 1)
}

/**
 * 评论里的 file 参数 → 可打开的路径：绝对路径原样；相对路径基于工作区根拼接。
 * @param {string | undefined} workspaceRoot
 * @param {string} rawFile
 */
function resolveCommentFilePath(workspaceRoot, rawFile) {
  const cleaned = cleanHostPath(rawFile)
  if (!cleaned) return ''
  if (isAbsoluteHostPath(cleaned)) return cleaned
  const root = String(workspaceRoot || '').trim()
  if (!root) return cleaned
  const sep = root.includes('\\') ? '\\' : '/'
  const relative = cleaned.replace(/^[/\\]+/, '').replace(/\//g, sep)
  return `${root.replace(/[/\\]+$/, '')}${sep}${relative}`
}

/** @param {string} path */
function basenameFromPath(path) {
  const parts = normalizeDisplayPath(path).split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

/**
 * 结构化评论 → 可渲染卡片（路径解析失败或不在工作区内的丢弃），供 UI 层消费。
 * @param {AssistantCodeComment[]} comments
 * @param {string | undefined} workspaceRoot
 * @param {number} [limit]
 * @returns {AssistantCodeCommentCard[]}
 */
export function buildAssistantCodeCommentCards(comments, workspaceRoot, limit = 50) {
  const root = String(workspaceRoot || '').trim()
  /** @type {AssistantCodeCommentCard[]} */
  const cards = []
  for (const comment of comments) {
    const path = resolveCommentFilePath(root, comment.file)
    if (!path) continue
    cards.push({
      ...comment,
      id: `code-comment:${comment.sourceStart}:${path}`,
      path,
      displayPath: displayPathForWorkspace(root, path) || basenameFromPath(path),
    })
    if (cards.length >= limit) break
  }
  return cards
}
