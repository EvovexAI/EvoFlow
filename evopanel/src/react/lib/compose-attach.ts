/**
 * Shared paste / drag-drop attach for home workbench + chat composer.
 *
 * Priority (composer-style):
 * 1. Workspace / absolute paths → context_files (no re-upload)
 * 2. http(s) links → insert as text
 * 3. Opaque File blobs (browser clipboard / no path) → pending upload/base64
 */

export const EVO_WORKSPACE_PATH_MIME = 'application/x-evoflow-workspace-path'

export type ComposePathEntry = {
  path: string
  name: string
}

export type ComposeAttachResult = {
  contextFiles: ComposePathEntry[]
  blobFiles: File[]
  /** http(s) links to insert into the draft */
  urls: string[]
  /** 剪贴板 / 拖放里的纯文本（粘贴时用于回填输入框） */
  plainText: string
  /** Caller should preventDefault when true */
  handled: boolean
}

export function basenameFromPath(raw: string): string {
  const s = String(raw || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  return parts[parts.length - 1] || s || 'file'
}

/** Windows / POSIX / file:// / quoted paths that look like a single local path. */
export function looksLikeLocalPath(text: string): boolean {
  const t = String(text || '')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!t || /\n/.test(t)) return false
  // 句子 / 中文任务描述：绝不当路径（避免粘贴正文被吞）
  if (/[\u4e00-\u9fff]/.test(t)) return false
  if (/^file:\/\//i.test(t)) return true
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true
  if (/^\\\\[^\\]+\\/.test(t)) return true
  // Unix 绝对路径：不允许夹空格（否则 "/api 帮我看" 会被误判）
  if (t.startsWith('/') && t.length > 1 && !t.startsWith('//') && !/\s/.test(t)) return true
  return false
}

export function normalizeLocalPath(raw: string): string {
  const t = String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!t) return ''
  if (/^file:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      let p = decodeURIComponent(u.pathname || '')
      // file:///C:/foo → /C:/foo on Windows
      if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
      return p.replace(/\//g, t.includes('\\') ? '\\' : '/')
    } catch {
      return t.replace(/^file:\/\//i, '')
    }
  }
  return t
}

export function isHttpUrl(text: string): boolean {
  const t = String(text || '').trim()
  return /^https?:\/\/\S+$/i.test(t)
}

function uniqPathEntries(entries: ComposePathEntry[]): ComposePathEntry[] {
  const seen = new Set<string>()
  const out: ComposePathEntry[] = []
  for (const e of entries) {
    const path = String(e.path || '').trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ path, name: String(e.name || '').trim() || basenameFromPath(path) })
  }
  return out
}

function parseWorkspaceMime(raw: string): ComposePathEntry[] {
  const text = String(raw || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      return uniqPathEntries(
        parsed
          .map((item) => {
            if (typeof item === 'string') {
              const path = normalizeLocalPath(item)
              return path ? { path, name: basenameFromPath(path) } : null
            }
            if (item && typeof item === 'object') {
              const path = normalizeLocalPath(String((item as { path?: string }).path || ''))
              if (!path) return null
              const name =
                String((item as { name?: string }).name || '').trim() || basenameFromPath(path)
              return { path, name }
            }
            return null
          })
          .filter((x): x is ComposePathEntry => !!x),
      )
    }
  } catch {
    /* newline-separated fallback */
  }
  return uniqPathEntries(
    text
      .split(/\r?\n/)
      .map((line) => normalizeLocalPath(line))
      .filter(Boolean)
      .map((path) => ({ path, name: basenameFromPath(path) })),
  )
}

function parseUriList(raw: string): { paths: ComposePathEntry[]; urls: string[] } {
  const paths: ComposePathEntry[] = []
  const urls: string[] = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (/^file:\/\//i.test(t) || looksLikeLocalPath(t)) {
      const path = normalizeLocalPath(t)
      if (path) paths.push({ path, name: basenameFromPath(path) })
      continue
    }
    if (isHttpUrl(t)) urls.push(t)
  }
  return { paths: uniqPathEntries(paths), urls }
}

/** Chromium / Tauri may expose absolute path on File. */
export function fileNativePath(file: File): string {
  return String((file as File & { path?: string }).path || '').trim()
}

/** 剪贴板里的空壳 / 占位文件，不应抢走文本粘贴。 */
function isSpuriousClipboardFile(file: File): boolean {
  if (!file) return true
  if (file.size <= 0) return true
  const name = String(file.name || '').trim()
  if (!name || name === 'undefined' || name === 'null') return true
  return false
}

/**
 * Parse a DataTransfer from paste or HTML5 drop.
 * Does not read Tauri OS drag-drop paths (use subscribeOsFileDrop).
 */
export function parseComposeDataTransfer(
  dt: DataTransfer | null | undefined,
  opts?: { fromPaste?: boolean },
): ComposeAttachResult {
  if (!dt) return { contextFiles: [], blobFiles: [], urls: [], plainText: '', handled: false }

  const contextFiles: ComposePathEntry[] = []
  const blobFiles: File[] = []
  const urls: string[] = []

  const workspaceRaw = dt.getData(EVO_WORKSPACE_PATH_MIME)
  if (workspaceRaw) contextFiles.push(...parseWorkspaceMime(workspaceRaw))

  const uriList = dt.getData('text/uri-list')
  if (uriList) {
    const parsed = parseUriList(uriList)
    contextFiles.push(...parsed.paths)
    urls.push(...parsed.urls)
  }

  const pathFromFiles = new Set(contextFiles.map((f) => f.path))
  const seenBlobKeys = new Set<string>()
  const pushBlob = (file: File) => {
    if (opts?.fromPaste && isSpuriousClipboardFile(file)) return
    const key = `${file.name}:${file.size}:${file.lastModified}`
    if (seenBlobKeys.has(key)) return
    seenBlobKeys.add(key)
    blobFiles.push(file)
  }
  const visitFile = (file: File | null | undefined) => {
    if (!file) return
    const native = fileNativePath(file)
    if (native) {
      const path = normalizeLocalPath(native)
      if (path && !pathFromFiles.has(path)) {
        pathFromFiles.add(path)
        contextFiles.push({ path, name: file.name || basenameFromPath(path) })
      }
      return
    }
    pushBlob(file)
  }

  // Some WebViews populate only files, only items, or both — merge instead of else-if.
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) visitFile(dt.files[i])
  }
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i]
      if (!item || item.kind !== 'file') continue
      visitFile(item.getAsFile())
    }
  }

  const plain = String(dt.getData('text/plain') || '')
  const plainTrim = plain.trim()
  if (plainTrim) {
    if (looksLikeLocalPath(plainTrim)) {
      const path = normalizeLocalPath(plainTrim)
      if (path && !pathFromFiles.has(path)) {
        contextFiles.push({ path, name: basenameFromPath(path) })
      }
    } else if (isHttpUrl(plainTrim)) {
      if (!opts?.fromPaste) urls.push(plainTrim)
    } else {
      const lines = plain
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      if (lines.length > 1 && lines.every((l) => looksLikeLocalPath(l) || isHttpUrl(l))) {
        for (const line of lines) {
          if (looksLikeLocalPath(line)) {
            const path = normalizeLocalPath(line)
            if (path && !pathFromFiles.has(path)) {
              pathFromFiles.add(path)
              contextFiles.push({ path, name: basenameFromPath(path) })
            }
          } else if (isHttpUrl(line) && !opts?.fromPaste) {
            urls.push(line)
          }
        }
      }
    }
  }

  const uniqCtx = uniqPathEntries(contextFiles)
  const uniqUrls = [...new Set(urls)]
  // 粘贴：仅当确有路径/文件附件时才拦截；纯文本交给浏览器默认插入
  const handled =
    uniqCtx.length > 0 || blobFiles.length > 0 || (!opts?.fromPaste && uniqUrls.length > 0)

  return {
    contextFiles: uniqCtx,
    blobFiles,
    urls: uniqUrls,
    plainText: plain,
    handled,
  }
}

export function setWorkspacePathDragData(
  dt: DataTransfer,
  entries: ComposePathEntry | ComposePathEntry[],
): void {
  const list = Array.isArray(entries) ? entries : [entries]
  const cleaned = uniqPathEntries(list)
  if (!cleaned.length) return
  dt.setData(EVO_WORKSPACE_PATH_MIME, JSON.stringify(cleaned))
  dt.setData('text/plain', cleaned.map((e) => e.path).join('\n'))
  dt.setData(
    'text/uri-list',
    cleaned
      .map((e) => {
        const p = e.path.replace(/\\/g, '/')
        if (/^[a-zA-Z]:\//.test(p)) return `file:///${p}`
        if (p.startsWith('/')) return `file://${p}`
        return e.path
      })
      .join('\n'),
  )
  dt.effectAllowed = 'copy'
}

/** Append URLs into textarea value (dedupe against existing text). */
export function appendUrlsToDraft(draft: string, urls: string[]): string {
  const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))]
  if (!list.length) return draft
  let next = String(draft || '')
  for (const u of list) {
    if (next.includes(u)) continue
    next = next.trim() ? `${next.trimEnd()}\n${u}` : u
  }
  return next
}

export type OsFileDropUnlisten = () => void

/** dragover helper for paste/drop attach targets (textarea, composer, conversation col). */
export function composeAttachDragOver(
  e: Pick<DragEvent, 'preventDefault' | 'dataTransfer'>,
): void {
  const types = Array.from(e.dataTransfer?.types || [])
  if (
    types.includes('Files') ||
    types.includes(EVO_WORKSPACE_PATH_MIME) ||
    types.includes('text/uri-list')
  ) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
}

export async function subscribeOsFileDrop(
  onPaths: (paths: string[]) => void,
): Promise<OsFileDropUnlisten> {
  try {
    const { isTauri } = await import('../../lib/panel-login.js')
    if (!isTauri) return () => {}

    const onEvent = (event: { payload: { type: string; paths?: string[] } }) => {
      if (event.payload.type !== 'drop') return
      const paths = (event.payload.paths || [])
        .map((p) => normalizeLocalPath(String(p || '')))
        .filter(Boolean)
      if (paths.length) onPaths(paths)
    }

    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      return await getCurrentWebview().onDragDropEvent(onEvent)
    } catch {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return await getCurrentWindow().onDragDropEvent(onEvent)
    }
  } catch {
    return () => {}
  }
}

/**
 * Desktop: native file picker → local paths (context_files, no upload).
 * Returns [] on web or when cancelled.
 */
export async function pickLocalContextFiles(): Promise<ComposePathEntry[]> {
  try {
    const { isTauri } = await import('../../lib/panel-login.js')
    if (!isTauri) return []
    const dlg = await import('@tauri-apps/plugin-dialog')
    const picked = await dlg.open({
      multiple: true,
      title: '选择要附加的文件',
    })
    if (!picked) return []
    const list = Array.isArray(picked) ? picked : [picked]
    return uniqPathEntries(
      list
        .map((p) => normalizeLocalPath(String(p || '')))
        .filter(Boolean)
        .map((path) => ({ path, name: basenameFromPath(path) })),
    )
  } catch {
    return []
  }
}

/**
 * 统一的「解析 → 分发」入口：让主聊天输入框与首页工作台输入框共用同一套
 * 粘贴/拖放处理逻辑，仅 UI 渲染各自实现。避免两处逻辑漂移（如 isTauri 拦截）。
 *
 * 返回的 handlePaste/handleDrop/handleDragOver 可直接绑到 textarea 或容器上。
 * 事件类型用最小结构，避免依赖 React 类型（React 事件与原生事件结构兼容）。
 */
export type ComposeAttachCallbacks = {
  /** 解析出的工作区/本地路径（引用，不重新上传） */
  onContextFiles: (files: ComposePathEntry[]) => void
  /** 解析出的无路径 File blob（粘贴/拖入的图片等） */
  onBlobFiles: (files: File[]) => void
  /** 解析出的 http(s) 链接（拖放时插入草稿） */
  onUrls?: (urls: string[]) => void
  /** 有附件时把纯文本回填输入框（追加语义，避免发送键判空） */
  onPlainText?: (text: string) => void
  /** 纯文本粘贴（未命中附件）时，把 textarea DOM 值同步进受控 state（替换语义） */
  onUnhandledPasteSync?: (value: string) => void
}

type PasteLikeEvent = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  currentTarget: { value?: string }
}

type DropLikeEvent = {
  dataTransfer: DataTransfer | null
  preventDefault: () => void
  stopPropagation: () => void
}

type DragOverLikeEvent = {
  dataTransfer: DataTransfer | null
  preventDefault: () => void
}

export type ComposeAttachHandlers = {
  handlePaste: (e: PasteLikeEvent) => void
  handleDrop: (e: DropLikeEvent) => void
  handleDragOver: (e: DragOverLikeEvent) => void
}

/** data URI → File（供剪贴板图片等场景把 base64 转回可预览/可上传的 File） */
export function dataUriToFile(dataUri: string, filename = 'clipboard-image.png'): File | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUri || '').trim())
  if (!m) return null
  try {
    const byteStr = atob(m[2])
    const bytes = new Uint8Array(byteStr.length)
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i)
    return new File([bytes], filename, { type: m[1] || 'image/png' })
  } catch {
    return null
  }
}

function insertPlainAtSelection(
  ta: { value?: string; selectionStart?: number | null; selectionEnd?: number | null },
  plain: string,
): string {
  const v = String(ta.value || '')
  const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : v.length
  const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start
  return `${v.slice(0, start)}${plain}${v.slice(end)}`
}

export function createComposeAttachHandlers(
  cb: ComposeAttachCallbacks,
  opts?: {
    /** 拖放时把解析出的链接写回草稿（默认 false） */
    insertUrlsOnDrop?: boolean
    /**
     * Tauri/原生场景：粘贴事件不暴露剪贴板图片为 DataTransfer.files。
     * 提供此函数后，粘贴未命中文件时会异步读取剪贴板图片（返回 data URI，无图返回 null）。
     */
    readClipboardImage?: () => Promise<string | null>
    /** 剪贴板图片转 File 时的文件名（默认 clipboard-image.png） */
    clipboardImageFilename?: string
  },
): ComposeAttachHandlers {
  const { onContextFiles, onBlobFiles, onUrls, onPlainText, onUnhandledPasteSync } = cb
  const readClipboard = opts?.readClipboardImage

  const handlePaste = (e: PasteLikeEvent) => {
    const result = parseComposeDataTransfer(e.clipboardData, { fromPaste: true })
    if (result.handled) {
      const plain = result.plainText || String(e.clipboardData?.getData('text/plain') || '')
      e.preventDefault()
      if (result.contextFiles.length) onContextFiles(result.contextFiles)
      if (result.blobFiles.length) onBlobFiles(result.blobFiles)
      if (plain && !looksLikeLocalPath(plain.trim())) onPlainText?.(plain)
      return
    }

    const plain = String(e.clipboardData?.getData('text/plain') || '')
    // 受控 textarea：有 text/plain 时直接写 state，不能依赖默认粘贴 + rAF（会被 value 立刻抹掉）
    if (plain) {
      e.preventDefault()
      const next = insertPlainAtSelection(e.currentTarget, plain)
      if (onUnhandledPasteSync) onUnhandledPasteSync(next)
      else onPlainText?.(plain)
      return
    }

    // 无文本：可能是纯图片剪贴板（Tauri WebView 不暴露 File）
    if (readClipboard) {
      e.preventDefault()
      void readClipboard().then((dataUri) => {
        if (!dataUri) return
        const file = dataUriToFile(dataUri, opts?.clipboardImageFilename || 'clipboard-image.png')
        if (file) onBlobFiles([file])
      })
      return
    }
  }

  const handleDrop = (e: DropLikeEvent) => {
    const result = parseComposeDataTransfer(e.dataTransfer, { fromPaste: false })
    if (!result.handled) return
    e.preventDefault()
    e.stopPropagation()
    if (result.contextFiles.length) onContextFiles(result.contextFiles)
    if (result.blobFiles.length) onBlobFiles(result.blobFiles)
    if (opts?.insertUrlsOnDrop && result.urls.length) onUrls?.(result.urls)
  }

  const handleDragOver = (e: DragOverLikeEvent) => {
    composeAttachDragOver(e)
  }

  return { handlePaste, handleDrop, handleDragOver }
}
