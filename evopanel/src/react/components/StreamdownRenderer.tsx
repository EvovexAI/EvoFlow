import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Download, Maximize2, X } from 'lucide-react'
import { Streamdown, defaultRemarkPlugins, defaultUrlTransform } from 'streamdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { harden } from 'rehype-harden'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { cjk } from '@streamdown/cjk'
import { mermaid } from '@streamdown/mermaid'
import type { Components } from 'streamdown'
import 'katex/dist/katex.min.css'
import 'streamdown/styles.css'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import {
  isImagePathLike,
  normalizeLocalImagePath,
  resolveChatImageSrc,
  stripBrowserSnapshotFileMentions,
} from '../../lib/chat-image-src.js'
import { linkifyWorkspaceAtMentions } from '../../lib/workspace-file-mention-display.js'

/**
 * Streamdown wrapper for evopanel markdown rendering.
 *
 * 提供以下"点击 → 弹窗"行为，让 AI 回复的 Markdown 仍然可交互：
 * - 表格：右上角「复制 MD / 复制 CSV / 放大」三个按钮 + 放大后的全屏 Dialog
 * - 代码块：右上角「放大」按钮，弹层显示原文与语言标签
 * - 图片：点击触发 lightbox；`@@path@@` / 相对路径会先经 resolveChatImageSrc 归一化
 * - 链接：本地 `@@...@@` 文件链接点击走 onOpenWorkspaceFile，http(s) 走新窗口
 * - Mermaid：流式结束后允许点击 SVG 区域打开放大弹层
 *
 * 这些是 chat-redesign.css 时代就有、streamdown 接管后丢掉的交互。
 * 边框的视觉接管在 `style/streamdown.css` 完成，本文件不再调样式。
 */

interface StreamdownRendererProps {
  text: string
  className?: string
  isStreaming?: boolean
  onOpenWorkspaceFile?: (
    rawPath: string,
    displayName?: string,
    opts?: {
      line?: number
      endLine?: number
      annotation?: { title?: string; body?: string; priority?: number }
    },
  ) => void
}

// ─────────────────────── Mermaid 渲染缓存 ───────────────────────

const MERMAID_SVG_CACHE_MAX = 32
const MERMAID_SVG_CACHE_MAX_CHARS = 1_000_000

const mermaidSvgCache = new Map<string, string>()

function mermaidSvgCacheGet(code: string): string | undefined {
  const key = String(code)
  if (mermaidSvgCache.has(key)) {
    const svg = mermaidSvgCache.get(key) as string
    mermaidSvgCache.delete(key)
    mermaidSvgCache.set(key, svg) // LRU touch
    return svg
  }
  return undefined
}

function mermaidSvgCacheSet(code: string, svg: string): void {
  const key = String(code)
  const val = String(svg)
  if (val.length > MERMAID_SVG_CACHE_MAX_CHARS) return
  if (mermaidSvgCache.has(key)) mermaidSvgCache.delete(key)
  mermaidSvgCache.set(key, val)
  if (mermaidSvgCache.size > MERMAID_SVG_CACHE_MAX) {
    const oldest = mermaidSvgCache.keys().next().value
    if (oldest !== undefined) mermaidSvgCache.delete(oldest)
  }
}

// ─────────────────────── 路径解析 ───────────────────────

function parseFilePathFromMarkdown(href: string): { path: string; line?: number; endLine?: number } | null {
  if (!href) return null

  const atsMatch = href.match(/^@@([^@]+)@@(?:#L(\d+)(?:-L(\d+))?)?$/)
  if (atsMatch) {
    return {
      path: atsMatch[1],
      line: atsMatch[2] ? Number(atsMatch[2]) : undefined,
      endLine: atsMatch[3] ? Number(atsMatch[3]) : undefined,
    }
  }

  // linkifyWorkspaceAtMentions 把正文里的 @@路径@@ 转成 evoflow-file: 链接
  // （与旧 renderMarkdown 的 chip 同一协议），这里负责还原回路径。
  const evfFileMatch = href.match(/^evoflow-file:(.+)$/i)
  if (evfFileMatch) {
    let path = evfFileMatch[1]
    try {
      path = decodeURIComponent(path)
    } catch {
      // 未编码或编码残缺时按原文处理
    }
    return { path }
  }

  const hashMatch = href.match(/^([^#]+)#L(\d+)(?:-L(\d+))?$/)
  if (hashMatch) {
    return {
      path: hashMatch[1],
      line: Number(hashMatch[2]),
      endLine: hashMatch[3] ? Number(hashMatch[3]) : undefined,
    }
  }

  return null
}

// ─────────────────────── 文件链接 URL 白名单 ───────────────────────

/**
 * react-markdown 的默认 urlTransform 只放行 http/https/mailto 等安全协议，
 * linkifyWorkspaceAtMentions 生成的 `evoflow-file:` 链接会被剥成无 href，
 * 文件 chip 就此失效。这里对自家协议放行，其余仍走默认清洗。
 */
const evoflowUrlTransform: NonNullable<
  ComponentProps<typeof Streamdown>['urlTransform']
> = (url, key, node) => {
  if (/^evoflow-file:/i.test(String(url || '').trim())) return url
  return defaultUrlTransform(url, key, node)
}

// rehype 层同样会拦：rehype-sanitize 的协议白名单没有扩展点，必须在自定义管线里
// 放行 evoflow-file。此配置镜像 streamdown 内部默认值（clobberPrefix、tel/streamdown
// 协议、code[metastring]、harden 全放行 + data 图片），仅额外加 evoflow-file，
// streamdown 升级若调整默认 schema 需同步。
const evoflowSanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: '',
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'tel', 'streamdown', 'evoflow-file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'streamdown'],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'metastring'],
  },
}

const evoflowRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, evoflowSanitizeSchema],
  [
    harden,
    {
      allowedImagePrefixes: ['*'],
      allowedLinkPrefixes: ['*'],
      allowedProtocols: ['*'],
      allowDataImages: true,
    },
  ],
] as unknown as ComponentProps<typeof Streamdown>['rehypePlugins']

// ─────────────────────── 表格序列化 ───────────────────────

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value
  if (!/[",\r\n]/.test(safe)) return safe
  return `"${safe.replace(/"/g, '""')}"`
}

function buildMarkdownTableText(rows: string[][]): string {
  if (rows.length === 0) return ''
  const colCount = Math.max(...rows.map((r) => r.length), 1)
  const padded = rows.map((r) =>
    Array.from({ length: colCount }, (_, i) => escapeMarkdownTableCell(r[i] ?? '')),
  )
  const [header, ...body] = padded
  const sep = Array.from({ length: colCount }, () => '---')
  return [
    (header ?? []).map((c) => ` ${c} `).join('|'),
    sep.map((c) => ` ${c} `).join('|'),
    ...body.map((r) => r.map((c) => ` ${c} `).join('|')),
  ].join('\n')
}

function buildCsvTableText(rows: string[][]): string {
  const csv = rows.map((r) => r.map((c) => escapeCsvCell(c)).join(',')).join('\r\n')
  // 加 BOM 避免 Excel 把 UTF-8 CSV 按本地代码页解析导致中文乱码
  return `\uFEFF${csv}`
}

function readRowsFromTable(table: HTMLTableElement | null): string[][] {
  if (!table) return []
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th,td')).map((cell) =>
        (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    )
    .filter((r) => r.length > 0)
}

// ─────────────────────── 表格放大 Dialog ───────────────────────

function MarkdownTableDialog({
  tableRef,
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
  onClose,
  onWheel,
}: {
  tableRef: React.RefObject<HTMLTableElement | null>
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  onClose: () => void
  onWheel: React.WheelEventHandler<HTMLDivElement>
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  const sourceTable = tableRef.current

  return createPortal(
    <div
      className="msg-md-table-modal"
      role="dialog"
      aria-modal="true"
      aria-label="表格放大预览"
      onClick={onClose}
    >
      <div className="msg-md-table-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="msg-md-table-modal-toolbar">
          <button type="button" onClick={onZoomOut} aria-label="缩小">−</button>
          <span className="msg-md-table-modal-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={onZoomIn} aria-label="放大">+</button>
          <button type="button" onClick={onReset} aria-label="重置">100%</button>
          <span className="msg-md-table-modal-spacer" />
          <button type="button" onClick={onClose} aria-label="关闭">关闭</button>
        </div>
        <div className="msg-md-table-modal-canvas" onWheel={onWheel}>
          <div
            className="msg-md-table-modal-stage"
            style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
          >
            {sourceTable ? (
              <ClonedTableHost table={sourceTable} />
            ) : (
              <div className="msg-md-table-modal-empty">表格未渲染</div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function cloneTableWithStreaming(source: HTMLTableElement) {
  const clone = source.cloneNode(true) as HTMLTableElement
  clone.removeAttribute('data-streamdown')
  clone.classList.add('msg-md-table-modal-table')
  return clone
}

/**
 * React 不能把原生 DOM 节点当子元素渲染（会抛 "Objects are not valid as a React
 * child"，弹层直接空白），克隆表格必须挂到 ref 容器上。
 */
function ClonedTableHost({ table }: { table: HTMLTableElement }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const clone = cloneTableWithStreaming(table)
    host.appendChild(clone)
    return () => {
      clone.remove()
    }
  }, [table])
  return <div ref={hostRef} />
}

export function MarkdownTableShell({ children, ...rest }: React.ComponentProps<'table'>) {
  const tableRef = useRef<HTMLTableElement | null>(null)
  const [open, setOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [copied, setCopied] = useState<'md' | 'csv' | null>(null)
  const copyTimer = useRef(0)

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
  }, [])

  const handleCopy = useCallback((kind: 'md' | 'csv') => {
    const rows = readRowsFromTable(tableRef.current)
    const text = kind === 'md' ? buildMarkdownTableText(rows) : buildCsvTableText(rows)
    if (!text) return
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind)
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(null), 1500)
    })
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    setScale((s) => {
      const next = s + (e.deltaY < 0 ? 0.12 : -0.12)
      if (next < 0.4) return 0.4
      if (next > 3) return 3
      return Number(next.toFixed(2))
    })
  }, [])

  const openLabel = open ? '关闭预览' : '放大预览'
  const copyMdLabel = copied === 'md' ? '已复制 Markdown' : '复制 Markdown'
  const copyCsvLabel = copied === 'csv' ? '已复制 CSV' : '下载 CSV'

  return (
    <div className="msg-md-table">
      <div className="msg-md-table-actions" role="toolbar" aria-label="表格操作">
        <button
          type="button"
          className={`msg-md-table-action${copied === 'md' ? ' is-copied' : ''}`}
          onClick={() => handleCopy('md')}
          title={copyMdLabel}
          aria-label={copyMdLabel}
        >
          {copied === 'md' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span>MD</span>
        </button>
        <button
          type="button"
          className={`msg-md-table-action${copied === 'csv' ? ' is-copied' : ''}`}
          onClick={() => handleCopy('csv')}
          title={copyCsvLabel}
          aria-label={copyCsvLabel}
        >
          {copied === 'csv' ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
          <span>CSV</span>
        </button>
        <button
          type="button"
          className="msg-md-table-action"
          onClick={() => {
            setOpen((v) => !v)
            setScale(1)
          }}
          title={openLabel}
          aria-label={openLabel}
        >
          {open ? <X aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </div>
      <div className="msg-md-table-frame">
        <table {...rest} ref={tableRef} data-streamdown="table">
          {children}
        </table>
      </div>
      {open && (
        <MarkdownTableDialog
          tableRef={tableRef}
          scale={scale}
          onZoomIn={() => setScale((s) => Math.min(3, Number((s + 0.15).toFixed(2))))}
          onZoomOut={() => setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))))}
          onReset={() => setScale(1)}
          onClose={() => setOpen(false)}
          onWheel={handleWheel}
        />
      )}
    </div>
  )
}

// ─────────────────────── 主组件 ───────────────────────

function StreamdownRendererInner({
  text,
  className = 'msg-text',
  isStreaming = false,
  onOpenWorkspaceFile,
}: StreamdownRendererProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [mermaidOpen, setMermaidOpen] = useState<{ svg: string } | null>(null)

  // @@路径@@ → evoflow-file: 链接。旧 renderMarkdown 在渲染前做这一步，产出
  // 可点击的文件 chip（产物/文件预览弹层靠 data-evf-file-path 事件委托触发）；
  // 迁到 Streamdown 后漏掉了，@@路径@@ 退化成纯文本/粗体。
  // 截图已在工具卡上。模型若仍把 browser_snapshots 的 png 写进正文，
  // 会变成 [Image blocked]，这里先拿掉这类引用。
  const linkifiedText = useMemo(
    () => linkifyWorkspaceAtMentions(stripBrowserSnapshotFileMentions(text)),
    [text],
  )

  // Mermaid 放大：流式结束后扫描 root 内的 [data-streamdown="mermaid"]，
  // 把 svg.outerHTML 缓存并挂点击事件。流式阶段不挂。
  useEffect(() => {
    if (isStreaming) return
    const root = rootRef.current
    if (!root) return
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>('[data-streamdown="mermaid"]'),
    )
    const cleanups: Array<() => void> = []
    for (const node of nodes) {
      const svg = node.querySelector('svg')
      if (!svg) continue
      const cacheKey = svg.outerHTML.slice(0, 256)
      let cached = mermaidSvgCacheGet(cacheKey)
      if (!cached) {
        cached = svg.outerHTML
        mermaidSvgCacheSet(cacheKey, cached)
      }
      const onClick = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setMermaidOpen({ svg: cached! })
      }
      node.style.cursor = 'zoom-in'
      node.addEventListener('click', onClick)
      cleanups.push(() => node.removeEventListener('click', onClick))
    }
    return () => {
      for (const fn of cleanups) fn()
    }
  }, [text, isStreaming])

  const components = useMemo<Partial<Components>>(() => ({
    a: ({ href, children, node: _node, ...rest }) => {
      const fileInfo = href ? parseFilePathFromMarkdown(href) : null

      if (fileInfo) {
        return (
          <button
            type="button"
            data-evf-file-path={fileInfo.path}
            title={fileInfo.path}
            onClick={(e) => {
              e.preventDefault()
              if (onOpenWorkspaceFile) {
                const label = (typeof children === 'string'
                  ? children
                  : String(children ?? '')
                ).replace(/^\s*📄\s*/, '').trim()
                onOpenWorkspaceFile(fileInfo.path, label || undefined, {
                  line: fileInfo.line,
                  endLine: fileInfo.endLine,
                })
              }
            }}
            className="msg-md-file-link"
          >
            {children}
          </button>
        )
      }

      if (href?.startsWith('http')) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            {children}
          </a>
        )
      }

      if (href && isImagePathLike(href)) {
        const resolved = resolveChatImageSrc(href) || href
        return (
          <a
            href={resolved}
            onClick={(e) => {
              e.preventDefault()
              showChatLightbox(resolved)
            }}
            className="msg-md-image-link"
          >
            {children}
          </a>
        )
      }

      return <span {...rest}>{children}</span>
    },

    img: ({ src, alt, node: _node, ...rest }) => {
      if (!src) return null
      // 路径归一化：@@...@@ / 相对路径 / Windows 反斜杠 → serve-file URL
      const resolved = resolveChatImageSrc(src) || normalizeLocalImagePath(src) || src
      return (
        <img
          {...rest}
          src={resolved}
          alt={alt ?? ''}
          loading="lazy"
          className="msg-img"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            showChatLightbox(resolved)
          }}
        />
      )
    },

    // 表格：自渲染外壳（复制 MD / 复制 CSV / 放大），关闭 streamdown 默认控件避免重复
    table: ({ children, node: _node, ...rest }) => (
      <MarkdownTableShell {...rest}>{children}</MarkdownTableShell>
    ),
  }), [onOpenWorkspaceFile])

  return (
    <>
      <div ref={rootRef} className={className}>
        <Streamdown
          plugins={{ code, math, cjk, mermaid }}
          remarkPlugins={Object.values(defaultRemarkPlugins)}
          rehypePlugins={evoflowRehypePlugins}
          components={components}
          urlTransform={evoflowUrlTransform}
          // evoflow-file: 文件链接会被 linkSafety 判成不安全链接渲染成 [blocked]
          // （zcode-ui 的 message.tsx 同款处理），本窗口内链接只来自模型正文，关掉
          linkSafety={{ enabled: false }}
          controls={{
            // 表格自己渲染工具栏，关掉默认 dropdown
            table: false,
            // 代码块：保留复制按钮（streamdown 拿得到 raw code），关掉下载（没意义）
            code: { copy: true, download: false },
            // Mermaid：放开大与复制（点 svg 区域用我们的 effect，复制走默认）
            mermaid: { fullscreen: true, copy: true, download: false },
            // 图片：保持 streamdown 默认无控件即可
            image: false,
          }}
          isAnimating={isStreaming}
          parseIncompleteMarkdown
        >
          {linkifiedText}
        </Streamdown>
      </div>
      {mermaidOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="msg-md-mermaid-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Mermaid 放大预览"
          onClick={() => setMermaidOpen(null)}
        >
          <div className="msg-md-mermaid-modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="msg-md-mermaid-modal-toolbar">
              <button type="button" onClick={() => setMermaidOpen(null)} aria-label="关闭">关闭</button>
            </div>
            <div className="msg-md-mermaid-modal-canvas">
              <div
                className="msg-md-mermaid-modal-stage"
                dangerouslySetInnerHTML={{ __html: mermaidOpen.svg }}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export const StreamdownRenderer = memo(StreamdownRendererInner)
