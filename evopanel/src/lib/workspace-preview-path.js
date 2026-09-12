import {
  extractContentLikeFromPartialJsonString,
  getToolInputObjectFromRow,
  getToolStreamingArgumentsRaw,
  isToolRunning,
} from './chat-normalize.js'
import {
  absoluteHostPathToWorkspaceRel,
  normalizeWorkspaceRelPath,
  stripEmbeddedWorkspaceRootPrefix,
} from './workspace-api-scope.js'
import { getChatWorkspaceRoot } from './chat-workspace-context.js'
import { isGenericToolName } from './tool-display.js'
import {
  healStrippedAbsolutePath,
  isAbsoluteHostPath,
} from './workspace-file-mention-display.js'

/** @typedef {{ path: string; name: string }} WorkspacePreviewTarget */

/** @typedef {{ path: string; name: string; content: string; streaming: boolean }} StreamingWritePreview */

/**
 * 流式气泡下是否应隐藏文件卡片（由侧栏写入预览承接，避免与历史 deliver 叠加）。
 * @param {unknown[]} tools
 * @param {{ streamingWritePreview?: { streaming?: boolean; path?: string } | null; suppressForSendingWriteTurn?: boolean }} [opts]
 */
export function shouldSuppressStreamDeliveredFiles(tools, opts = {}) {
  const prev = opts.streamingWritePreview
  if (prev?.streaming || String(prev?.path || '').trim()) return true
  if (Array.isArray(tools) && tools.some((t) => isWriteToolInFlight(t))) return true
  // 本轮流式区已出现写入类工具：底部不再叠 artifacts 文件卡片（直至回合结束）
  if (opts.suppressForSendingWriteTurn && Array.isArray(tools) && tools.some((t) => isActiveWriteTool(t))) {
    return true
  }
  return false
}

const WRITE_TOOL_NAMES = new Set([
  'write',
  'replace',
  'write_to_file',
  'write_file',
  'str_replace',
  'replace_in_file',
])

/** 流式写入时右侧侧栏自动打开/预览：仅 HTML（其它扩展名可手动点文件树预览） */
const STREAM_HTML_AUTO_PANEL_EXT = /\.(html?|htm)$/i
const STREAM_TEXT_PREVIEW_EXT =
  /\.(txt|text|md|markdown|json|ya?ml|csv|log|env|ini|toml|cfg|conf|py|js|ts|tsx|jsx|css|scss|less|xml|sh|bat|ps1|rs|go|java|kt|c|cpp|h|hpp|sql|vue|svelte|docx?|doc)$/i

/** 流式写入：HTML 更早展示；Word 仍稍晚以避免二进制碎片；纯文本 1 字即可 */
const MIN_STREAM_PREVIEW_CHARS = 32
const MIN_HTML_STREAM_PREVIEW_CHARS = 4
const MIN_TEXT_STREAM_PREVIEW_CHARS = 1

/**
 * 流式参数碎片是否像工具 JSON 而非文件正文。
 * @param {string} content
 * @param {string} [path]
 */
export function looksLikeStreamingToolArgsGarbage(content, path) {
  const s = String(content || '').trim()
  if (!s) return true
  if (isHtmlPreviewPath(path)) {
    if (s.startsWith('<') || /<!DOCTYPE|<html/i.test(s)) return false
    if (s.includes('<') && s.length >= MIN_HTML_STREAM_PREVIEW_CHARS) return false
  }
  if (!s.startsWith('{') && !s.startsWith('["') && !/^\\?"?(path|content|target_file)/i.test(s)) {
    return false
  }
  if (/^[\s{\\[\]":,]+$/.test(s)) return true
  if (/"path"\s*:|"target_file"\s*:|"file_path"\s*:|"content"\s*:/i.test(s)) {
    const stripped = s
      .replace(/"(path|target_file|file_path|content|new_string|filePath)"\s*:\s*"/gi, '')
      .replace(/[{}"\\:,]/g, '')
      .trim()
    if (stripped.length < 12) return true
  }
  return false
}

/** @param {{ path: string; content: string; streaming: boolean }} hit */
export function isStreamWritePreviewReady(hit) {
  if (!hit?.streaming) return true
  const content = String(hit.content || '')
  const path = hit.path || ''
  const n = content.length
  if (looksLikeStreamingToolArgsGarbage(content, path)) return false
  const htmlLike = isHtmlPreviewPath(path) || (!path && isHtmlLikeStreamContent(content))
  if (htmlLike) {
    return n >= MIN_HTML_STREAM_PREVIEW_CHARS && content.includes('<')
  }
  if (isWordPreviewPath(path)) {
    return n >= MIN_STREAM_PREVIEW_CHARS
  }
  if (isPlainTextStreamPreviewPath(path) || (!path && isStreamPreviewableWithoutPath(content))) {
    return n >= MIN_TEXT_STREAM_PREVIEW_CHARS && !looksLikeStreamingToolArgsGarbage(content, path)
  }
  return false
}

/**
 * 侧栏流式区是否应展示正文（否则仅显示等待态）。
 * @param {{ path?: string; content?: string; streaming?: boolean }} hit
 */
export function isStreamWriteContentDisplayable(hit) {
  if (!hit?.streaming) return true
  const path = hit.path || ''
  const content = String(hit.content || '')
  const htmlLike = isHtmlPreviewPath(path) || (!path && isHtmlLikeStreamContent(content))
  if (htmlLike) {
    if (!content.trim()) return false
    if (looksLikeStreamingToolArgsGarbage(content, path)) return false
    return content.includes('<') || content.length >= 8
  }
  if (isPlainTextStreamPreviewPath(path) || (!path && isStreamPreviewableWithoutPath(content))) {
    if (!content.trim()) return false
    return !looksLikeStreamingToolArgsGarbage(content, path)
  }
  return isStreamWritePreviewReady({
    path,
    content,
    streaming: true,
  })
}

/**
 * Map artifact / file-card URLs to workspace-relative paths (outputs/..., uploads/..., or root-relative).
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function artifactUrlToWorkspaceRelPath(rawUrl) {
  const u = String(rawUrl || '').trim()
  if (!u) return null
  if (/^https?:\/\//i.test(u)) return null

  const rootHint = getChatWorkspaceRoot() || ''
  // Host absolute paths: do NOT convert to relative here. Employee/task previews often
  // use a nested role root; relativizing against the chat root causes double-join.
  if (/^[a-zA-Z]:[\\/]/.test(u)) return null
  if (u.startsWith('/') && !u.startsWith('//') && !u.startsWith('/mnt/') && !u.startsWith('/workspace')) {
    return null
  }

  let v = stripEmbeddedWorkspaceRootPrefix(u.replace(/^\/+/, ''), rootHint)
  if (v.startsWith('mnt/user-data/')) {
    v = v.slice('mnt/user-data/'.length)
  }
  const parts = v.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg)
    } catch {
      return seg
    }
  })
  const head = parts[0]
  if (head === 'outputs') {
    const tail = parts.slice(1).filter(Boolean).join('/')
    return tail ? `outputs/${tail}` : 'outputs'
  }
  if (head === 'uploads') {
    const tail = parts.slice(1).filter(Boolean).join('/')
    return tail ? `uploads/${tail}` : 'uploads'
  }
  if (v.startsWith('outputs/') || v === 'outputs') {
    return v
  }
  if (v.startsWith('uploads/') || v === 'uploads') {
    return v
  }
  if (v.startsWith('workspace/') || v === 'workspace') {
    return normalizeWorkspaceRelPath(v)
  }
  return null
}

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isHtmlPreviewPath(p) {
  return /\.(html?|htm)$/i.test(String(p || '').trim())
}

/** @param {string} p */
export function isWordPreviewPath(p) {
  return /\.(docx?|doc)$/i.test(String(p || '').trim())
}

/**
 * User-facing hint when workspace preview API returns ``binary: true`` (non-UTF-8 files).
 * @param {string} name
 * @param {string} path
 */
export function getBinaryFilePreviewHint(name, path) {
  const n = String(name || path || '').trim()
  if (/\.pptx?$/i.test(n)) {
    return '演示文稿（PPT/PPTX）为 Office 二进制格式，面板内暂不支持幻灯片预览。请在本机用 PowerPoint、WPS 等打开工作区中的该文件；也可让 Agent 用 pptx 技能提取文字或生成缩略图。'
  }
  if (/\.docx?$/i.test(n)) {
    return 'Word 文档为二进制格式，面板内暂不支持版式预览。请用 Word / WPS 打开；或让 Agent 读取/转换内容。'
  }
  if (/\.pdf$/i.test(n)) {
    return 'PDF 为二进制格式，面板内暂不支持内嵌阅读。请用系统 PDF 阅读器打开，或让 Agent 提取文本。'
  }
  if (/\.xlsx?$/i.test(n)) {
    return 'Excel 工作簿为二进制格式，面板内暂不支持表格预览。请用 Excel / WPS 打开。'
  }
  return '该文件为二进制，无法在面板内预览。请在本机工作区目录中用对应应用打开，或让 Agent 处理。'
}

/** @param {string} p */
export function isPlainTextStreamPreviewPath(p) {
  return STREAM_TEXT_PREVIEW_EXT.test(String(p || '').trim())
}

/** 流式侧栏自动打开：仅 HTML（.html / .htm） */
export function isStreamAutoPreviewPath(p) {
  const s = String(p || '').trim()
  return STREAM_HTML_AUTO_PANEL_EXT.test(s)
}

/** 流式 JSON 尚未露出 path 时，从正文片段推断是否为 HTML */
export function isHtmlLikeStreamContent(content) {
  const s = String(content || '').trim()
  if (!s) return false
  return s.startsWith('<') || /<!DOCTYPE|<html/i.test(s)
}

/** path 未到时是否仍应侧栏流式预览（content 先于 path 的 write_to_file 常见） */
function isStreamPreviewableWithoutPath(content) {
  const c = String(content || '')
  if (!c.trim()) return false
  if (isHtmlLikeStreamContent(c)) return true
  if (looksLikeStreamingToolArgsGarbage(c, '')) return false
  return c.length >= MIN_TEXT_STREAM_PREVIEW_CHARS
}

/** @deprecated 使用 isStreamAutoPreviewPath */
export function isStreamPreviewablePath(p) {
  return isStreamAutoPreviewPath(p)
}

/**
 * @param {string} rawUrl
 * @returns {WorkspacePreviewTarget | null}
 */
export function workspacePreviewTargetFromUrl(rawUrl) {
  const path = artifactUrlToWorkspaceRelPath(rawUrl)
  if (!path) return null
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '文件'
  return { path, name }
}

/**
 * 解析预览目标：支持绝对本机路径、outputs/…、/mnt/user-data/…，以及工作区相对路径。
 * @param {string} rawUrl
 * @param {{ name?: string }} [opts]
 * @returns {WorkspacePreviewTarget | null}
 */
export function resolveWorkspacePreviewTarget(rawUrl, opts = {}) {
  const fromUrl = workspacePreviewTargetFromUrl(rawUrl)
  let path = fromUrl?.path || resolveWritePreviewPath(rawUrl) || normalizeWorkspaceRelPath(rawUrl)
  if (!path) return null
  // 先修复剥盘符的 Windows 绝对路径，再决定是否保留绝对形式（禁止拼 root）
  path = healStrippedAbsolutePath(path)
  if (isAbsoluteHostPath(path)) {
    path = String(path).replace(/\\/g, '/')
  } else {
    path = normalizeWorkspaceRelPath(path) || path
  }
  const customName = opts.name != null ? String(opts.name).trim() : ''
  const name =
    customName ||
    fromUrl?.name ||
    path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
    '文件'
  return { path, name }
}

/** Prefer index / report markdown when a @@dir/@@ cite is opened for preview. */
export function pickPrimaryDeliverableEntry(entries) {
  const files = (Array.isArray(entries) ? entries : []).filter((e) => e && !e.is_dir)
  if (!files.length) return null
  const score = (name) => {
    const n = String(name || '').toLowerCase()
    if (/交付物索引|index\.md$|readme/i.test(n)) return 100
    if (/测试报告|报告|report/i.test(n)) return 90
    if (/测试方案|方案|plan/i.test(n)) return 70
    if (/\.md$/i.test(n)) return 50
    if (/\.html?$/i.test(n)) return 40
    if (/\.(txt|json)$/i.test(n)) return 20
    return 5
  }
  return [...files].sort(
    (a, b) => score(b.name) - score(a.name) || String(a.name).localeCompare(String(b.name)),
  )[0]
}

/**
 * If ``path`` is a directory, browse and pick a primary file to preview (same as
 * historical "click cite → show file" UX). Otherwise return the path unchanged.
 * @param {{
 *   workspaceRoot: string
 *   path: string
 *   threadId?: string
 *   workspaceScopeOpts?: { configuredRoot?: string, useVirtualPaths?: boolean }
 *   name?: string
 * }} opts
 * @returns {Promise<WorkspacePreviewTarget>}
 */
export async function resolveOpenableWorkspaceFile(opts = {}) {
  const root = String(opts.workspaceRoot || '').trim()
  let path = String(opts.path || '').trim().replace(/\\/g, '/')
  const nameHint = opts.name != null ? String(opts.name).trim() : ''
  if (!path) return { path: '', name: nameHint || '文件' }

  const looksDir = /\/$/.test(path)
  path = path.replace(/\/+$/, '') || path

  const basename = path.split('/').filter(Boolean).pop() || nameHint || '文件'
  let isDir = looksDir
  try {
    const { api } = await import('./tauri-api.js')
    const info = await api.resolveWorkspaceTarget(
      root,
      path,
      opts.threadId,
      opts.workspaceScopeOpts,
    )
    if (info?.resolved) path = String(info.resolved).replace(/\\/g, '/')
    if (info?.is_dir) isDir = true
    else if (info && info.is_dir === false) isDir = false
  } catch {
    /* keep looksDir heuristic */
  }

  if (!isDir) {
    return { path, name: nameHint || basename }
  }

  try {
    const { api } = await import('./tauri-api.js')
    const data = await api.browseWorkspace(root, path, opts.threadId, opts.workspaceScopeOpts)
    const pick = pickPrimaryDeliverableEntry(data?.entries)
    if (!pick) {
      return { path, name: nameHint || basename }
    }
    const fileName = String(pick.name || '').trim() || '文件'
    // browse returns path relative to workspace root (posix)
    let openPath = String(pick.path || '').trim().replace(/\\/g, '/')
    if (!openPath) {
      openPath = `${path.replace(/\/+$/, '')}/${fileName}`
    } else if (
      root &&
      !/^[a-zA-Z]:\//.test(openPath) &&
      !(openPath.startsWith('/') && !openPath.startsWith('//'))
    ) {
      openPath = `${root.replace(/\/+$/, '')}/${openPath.replace(/^\/+/, '')}`
    }
    return { path: openPath, name: nameHint || fileName }
  } catch {
    return { path, name: nameHint || basename }
  }
}

/** @param {unknown} tool */
export function getDeclaredToolName(tool) {
  if (typeof tool === 'string') return String(tool).trim()
  const rawName = tool?.name ?? tool?.tool_name ?? tool?.toolName
  const fnName =
    tool?.function && typeof tool.function === 'object' ? tool.function.name : null
  const name = rawName != null ? String(rawName).trim() : ''
  const fn = fnName != null ? String(fnName).trim() : ''
  if (fn && (!name || isGenericToolName(name))) return fn
  return name || fn
}

/** 流式阶段：tool_name / name / function.name 为写入工具 */
export function isActiveWriteTool(tool) {
  const n = getDeclaredToolName(tool).toLowerCase()
  if (!n || isGenericToolName(n)) return false
  return WRITE_TOOL_NAMES.has(n)
}

function toolHasCompletedOutput(tool) {
  if (!tool || typeof tool !== 'object') return false
  const out = tool.output ?? tool.output_text ?? tool.content
  if (out == null) return false
  if (typeof out === 'string') {
    const t = out.trim()
    return t !== '' && t !== '{}' && t !== '[]'
  }
  if (typeof out === 'object' && !Array.isArray(out)) {
    return Object.keys(out).length > 0
  }
  return true
}

/** write_to_file 是否仍在执行（含流式拼参数阶段；output_text 视为已结束） */
export function isWriteToolInFlight(tool) {
  if (!isActiveWriteTool(tool)) return false
  if (toolHasCompletedOutput(tool)) return false
  const st = String(tool?.status || '').toLowerCase()
  if (st === 'ok' || st === 'completed' || st === 'done' || st === 'success') return false
  if (st === 'error' || st === 'failed' || st === 'cancelled') return false
  if (isToolRunning(tool) || st === 'pending') return true
  const fields = extractWriteFieldsFromTool(tool, { streamingPreview: true })
  return !!(fields?.path || fields?.content)
}

/** @deprecated */
export function isWriteToolEligibleForPreview(tool) {
  return isWriteToolInFlight(tool) || (isActiveWriteTool(tool) && toolHasCompletedOutput(tool))
}

/** @deprecated 使用 isActiveWriteTool */
export function isDeclaredWriteTool(tool) {
  return isActiveWriteTool(tool)
}

/** @param {{ name?: string; input?: unknown; function?: { name?: string } }} entry */
export function isWriteToolCallEntry(entry) {
  const names = [entry?.name, entry?.function?.name, entry?.tool_name]
    .filter((x) => x != null && String(x).trim())
    .map((x) => String(x).trim().toLowerCase())
  return names.some((n) => !isGenericToolName(n) && WRITE_TOOL_NAMES.has(n))
}

/** @param {{ input?: unknown }} entry */
export function extractWritePathFromEntry(entry) {
  const input = entry?.input
  if (typeof input === 'string' && input.trim()) {
    const m = input.match(/"(path|target_file|file_path)"\s*:\s*"((?:[^"\\]|\\.)*)/i)
    if (m?.[2]) return resolveWritePreviewPath(m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim())
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const rawPath =
    (typeof input.path === 'string' && input.path.trim()) ||
    (typeof input.target_file === 'string' && input.target_file.trim()) ||
    ''
  if (!rawPath) return null
  return resolveWritePreviewPath(rawPath)
}

/**
 * @param {unknown} tool
 * @returns {{ path: string; content: string } | null}
 */
function extractWriteFieldsFromTool(tool, opts = {}) {
  const streamingPreview = opts.streamingPreview === true
  const input = getToolInputObjectFromRow(tool) || {}
  const raw = getToolStreamingArgumentsRaw(tool)
  const partial = raw ? extractContentLikeFromPartialJsonString(raw) : null
  const writeProgress =
    tool && typeof tool === 'object' && tool._writeProgress && typeof tool._writeProgress === 'object'
      ? tool._writeProgress
      : null
  const wpPath =
    writeProgress && typeof writeProgress.path === 'string' ? writeProgress.path.trim() : ''
  const wpContent =
    writeProgress && typeof writeProgress.content === 'string' ? writeProgress.content : ''
  let rawPath =
    wpPath ||
    (typeof input.path === 'string' && input.path.trim()) ||
    (typeof input.target_file === 'string' && input.target_file.trim()) ||
    ''
  if (!rawPath && raw) rawPath = extractPathFromPartial(raw) || ''
  let content = pickWriteContent(input, partial, raw, streamingPreview)
  // Prefer progress-streamed body (tool_call args are path-only on the wire).
  if (wpContent && (!content || wpContent.length >= String(content).length)) {
    content = wpContent
  }
  const contentStr = content != null ? content : ''
  if (!rawPath) {
    if (!streamingPreview) return null
    if (!contentStr && (!raw || /^[\s{]*$/.test(String(raw).trim()))) return null
    return { path: '', content: contentStr }
  }
  const previewPath = resolveWritePreviewPath(rawPath)
  if (!previewPath) return null
  return { path: previewPath, content: contentStr }
}

function extractPathFromPartial(raw) {
  const m = String(raw || '').match(
    /"(path|target_file|file_path|filepath|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)/i,
  )
  if (!m || !m[2]) return null
  return m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
}

function pickWriteContent(input, partial, raw, streamingPreview = false) {
  let fromPartial = partial && typeof partial.content === 'string' ? partial.content : ''
  if (!fromPartial && raw) {
    const p = extractContentLikeFromPartialJsonString(raw)
    if (p && typeof p.content === 'string') fromPartial = p.content
  }
  /** 流式预览：只用 function.arguments 分片，勿用 values 快照灌满的 input.content */
  if (streamingPreview) {
    return fromPartial ?? ''
  }
  const fromInput =
    (typeof input.content === 'string' && input.content) ||
    (typeof input.new_string === 'string' && input.new_string) ||
    (typeof input.text === 'string' && input.text) ||
    ''
  if (fromPartial.length > fromInput.length) return fromPartial
  if (fromInput) return fromInput
  return fromPartial || null
}

/**
 * 写入预览路径：工具参数为本机绝对路径时保留绝对路径；否则用 outputs/uploads 或根下相对路径。
 * @param {string} rawPath
 * @returns {string | null}
 */
export function resolveWritePreviewPath(rawPath) {
  const raw = String(rawPath || '').trim()
  if (!raw) return null
  const rootHint = getChatWorkspaceRoot() || ''
  const healed = healStrippedAbsolutePath(raw, rootHint)
  const norm = healed.replace(/\\/g, '/')
  // Prefer host absolute as-is (employee roots often nest under …/outputs/…)
  if (/^[a-zA-Z]:\//.test(norm)) return norm
  if (
    norm.startsWith('/') &&
    !norm.startsWith('//') &&
    !norm.startsWith('/workspace') &&
    !norm.startsWith('/mnt/')
  ) {
    return norm
  }
  const fromWin = absoluteHostPathToWorkspaceRel(healed, rootHint)
  if (fromWin != null && fromWin !== '') return fromWin
  const fromVirtual = artifactUrlToWorkspaceRelPath(healed)
  if (fromVirtual) return fromVirtual
  if (norm.startsWith('/')) {
    const mapped = artifactUrlToWorkspaceRelPath(norm)
    if (mapped) return mapped
    return norm
  }
  let rel = stripEmbeddedWorkspaceRootPrefix(norm.replace(/^\.\//, '').replace(/^\/+/, ''), rootHint)
  if (rel.startsWith('outputs/') || rel === 'outputs' || rel.startsWith('uploads/') || rel === 'uploads') {
    return rel
  }
  const mapped = artifactUrlToWorkspaceRelPath(rel)
  if (mapped) return mapped
  return normalizeWorkspaceRelPath(rel, rootHint) || rel
}

/**
 * 从工具列表解析最近一次 write 预览（默认含已完成、仍有 arguments 的工具）。
 * @param {unknown[]} tools
 * @param {{ inFlightOnly?: boolean }} [opts]
 * @returns {StreamingWritePreview | null}
 */
export function detectLatestWritePreviewFromTools(tools, opts = {}) {
  const inFlightOnly = opts.inFlightOnly === true
  if (!Array.isArray(tools)) return null
  let last = null
  for (const t of tools) {
    if (!isActiveWriteTool(t)) continue
    const inFlight = isWriteToolInFlight(t)
    if (inFlightOnly && !inFlight) continue
    if (!inFlightOnly && !inFlight && !toolHasCompletedOutput(t)) continue
    const fields = extractWriteFieldsFromTool(t, { streamingPreview: true })
    if (!fields) continue
    const hasPath = !!fields.path
    if (
      hasPath &&
      !isStreamAutoPreviewPath(fields.path) &&
      !isPlainTextStreamPreviewPath(fields.path)
    ) {
      continue
    }
    if (!hasPath && !isStreamPreviewableWithoutPath(fields.content)) continue
    const base = hasPath
      ? fields.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '文件'
      : isHtmlLikeStreamContent(fields.content)
        ? '生成 HTML…'
        : '写入中…'
    last = {
      path: fields.path,
      name: base,
      content: fields.content,
      streaming: inFlight,
    }
  }
  return last
}

/**
 * 从流式工具列表解析正在写入的文件（含未落盘的 content 片段）。
 * @param {unknown[]} tools
 * @param {{ requireReady?: boolean }} [opts]
 * @returns {StreamingWritePreview | null}
 */
export function detectStreamingWritePreview(tools, opts = {}) {
  const requireReady = opts.requireReady !== false
  const hit = detectLatestWritePreviewFromTools(tools, { inFlightOnly: true })
  if (!hit) return null
  if (requireReady && !isStreamWritePreviewReady(hit)) return null
  return hit
}

/** 写入工具刚出现、path 已从流式 JSON 露出时即可返回（不要求 content 达标） */
export function detectStreamingWritePreviewEarly(tools) {
  return detectStreamingWritePreview(tools, { requireReady: false })
}

/** @deprecated 使用 detectStreamingWritePreview */
export function detectStreamingHtmlWritePreview(tools) {
  const hit = detectStreamingWritePreview(tools)
  if (!hit) return null
  if (!isHtmlPreviewPath(hit.path)) return hit.streaming ? { path: hit.path, poll: true } : null
  return { path: hit.path, poll: hit.streaming }
}

