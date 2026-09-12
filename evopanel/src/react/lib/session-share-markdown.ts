/** Build Markdown for session share / local export. */

export type ShareMarkdownMessage = {
  role?: string
  type?: string
  name?: string
  content?: string
  content_json?: unknown
}

function extractText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        const t = block.trim()
        if (t) parts.push(t)
      } else if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        const t = String(b.text || b.content || '').trim()
        if (t) parts.push(t)
      }
    }
    return parts.join('\n').trim()
  }
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>
    if (typeof o.text === 'string') return o.text.trim()
    if (o.content != null) return extractText(o.content)
  }
  return ''
}

function roleLabel(msg: ShareMarkdownMessage): string {
  const role = String(msg.role || '').toLowerCase()
  const type = String(msg.type || '').toLowerCase()
  if (role === 'tool' || type === 'tool') {
    const name = String(msg.name || 'tool').trim() || 'tool'
    return `工具（${name}）`
  }
  if (role === 'user' || role === 'human' || type === 'human') return '用户'
  if (role === 'assistant' || role === 'ai' || type === 'ai') return '助手'
  return role || type || '消息'
}

export function messagesToShareMarkdown(
  title: string,
  messages: ShareMarkdownMessage[],
  opts?: { includeTools?: boolean },
): string {
  const includeTools = Boolean(opts?.includeTools)
  const lines: string[] = [`# ${String(title || '未命名会话').trim() || '未命名会话'}`, '']
  for (const msg of messages || []) {
    if (!msg || typeof msg !== 'object') continue
    const role = String(msg.role || '').toLowerCase()
    const type = String(msg.type || '').toLowerCase()
    const isTool = role === 'tool' || type === 'tool'
    if (isTool && !includeTools) continue
    const text =
      extractText(msg.content) ||
      extractText(msg.content_json)
    if (!text) continue
    lines.push(`## ${roleLabel(msg)}`, '', text, '')
  }
  return lines.join('\n').trim() + '\n'
}

export function downloadTextFile(filename: string, text: string, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function safeMdFilename(title: string): string {
  const base = String(title || 'session')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48)
  return `${base || 'session'}.md`
}

export type SaveMarkdownResult =
  | { ok: true; mode: 'path'; path: string }
  | { ok: true; mode: 'downloads'; filename: string }
  | { ok: false; cancelled: true }

function isDesktopTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

/** Prefer save dialog (desktop / File System Access); fallback to browser Downloads. */
export async function saveMarkdownExport(
  filename: string,
  text: string,
): Promise<SaveMarkdownResult> {
  const name = safeMdFilename(filename.replace(/\.md$/i, '') || 'session')

  if (isDesktopTauri()) {
    try {
      const dlg = await import('@tauri-apps/plugin-dialog')
      const picked = await dlg.save({
        title: '保存 Markdown',
        defaultPath: name,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!picked) return { ok: false, cancelled: true }
      const path = String(picked)
      const { api } = await import('../../lib/tauri-api.js')
      await api.assistantWriteFile(path, text)
      return { ok: true, mode: 'path', path }
    } catch (err) {
      // Fall through to browser download if dialog/write unavailable
      console.warn('[share] tauri save failed, fallback download', err)
    }
  }

  const w = typeof window !== 'undefined' ? (window as Window & {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
  }) : null
  if (w?.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: 'Markdown',
            accept: { 'text/markdown': ['.md'] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      const path = String(handle.name || name)
      return { ok: true, mode: 'path', path }
    } catch (err) {
      const nameMsg = String((err as Error)?.name || '')
      if (nameMsg === 'AbortError') return { ok: false, cancelled: true }
      console.warn('[share] showSaveFilePicker failed, fallback download', err)
    }
  }

  downloadTextFile(name, text)
  return { ok: true, mode: 'downloads', filename: name }
}
