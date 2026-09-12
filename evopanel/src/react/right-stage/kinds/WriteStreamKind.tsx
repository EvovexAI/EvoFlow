import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { renderMarkdown, highlightCode } from '../../../lib/markdown.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { buildWriteAddedRows, type FileDiffRow } from '../../file-diff-util.js'
import type { RightStageStreamSession } from '../../../lib/right-stage/right-stage-types.js'

function useStreamSession(streamId: string): RightStageStreamSession | null {
  const snapshot = useSyncExternalStore(
    (onChange) => rightStageStore.subscribe(onChange),
    () => rightStageStore.getSnapshot(),
    () => rightStageStore.getSnapshot(),
  )
  const id = String(streamId || 'default').trim() || 'default'
  return snapshot.streams.get(id) ?? null
}

function chunkText(session: RightStageStreamSession | null): string {
  if (!session) return ''
  return session.chunks
    .filter((c) => !c.level || c.level === 'info')
    .map((c) => String(c.text || '') + (c.newline === false ? '' : '\n'))
    .join('')
}

function fileExtFromPath(path: string): string {
  const norm = String(path || '').replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  const name = parts.length ? parts[parts.length - 1] : norm
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

function langFromPath(path: string): string {
  const ext = fileExtFromPath(path)
  const map: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
  }
  return map[ext] || ext || 'text'
}

/** 单行 diff 渲染（流式面板不需要虚拟化，stream 已有 800 chunk / 120K char 上限） */
const WriteDiffRow = memo(function WriteDiffRow({
  row,
  lang,
}: {
  row: FileDiffRow
  lang: string
}) {
  const html = useMemo(
    () => highlightCode(row.text.length ? row.text : '\u00a0', lang),
    [row.text, lang],
  )
  return (
    <div className={`write-diff-line write-diff-line--${row.kind}`}>
      <div className="write-diff-line__code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}, (prev, next) => prev.lang === next.lang && prev.row.kind === next.row.kind && prev.row.text === next.row.text)

export const WriteStreamKind = memo(function WriteStreamKind({
  streamId = 'write_file',
  path,
  format: formatProp,
}: {
  streamId?: string
  path?: string
  format?: 'plain' | 'markdown' | 'code'
}) {
  const session = useStreamSession(streamId)
  const format = formatProp || session?.format || 'plain'
  const viewportRef = useRef<HTMLDivElement>(null)
  const source = chunkText(session)
  const filePath = path || session?.path || streamId
  const lang = useMemo(() => langFromPath(filePath), [filePath])

  // 流式内容无 before 快照，统一用 buildWriteAddedRows 渲染为新增行 diff
  const diffView = useMemo(() => {
    if (format === 'markdown' || !source) return null
    return buildWriteAddedRows(source, 200)
  }, [source, format])

  const hasDiff = Boolean(diffView && diffView.rows.length > 0)

  // 自动滚动到底部（跟随流式写入）
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [source])

  const markdownHtml = useMemo(() => {
    if (format !== 'markdown' || !source) return ''
    try {
      return renderMarkdown(source)
    } catch {
      return ''
    }
  }, [format, source])

  const title = session?.title || (path ? `Writing ${path}` : '实时写入')

  return (
    <div className="react-chat-write-stream-kind">
      <div className="react-chat-write-stream-meta">
        <span className="react-chat-write-stream-path">{filePath}</span>
        {diffView && (diffView.added || diffView.removed) ? (
          <span className="write-diff-stats">
            {diffView.added > 0 ? <span className="write-diff-stat write-diff-stat--add">+{diffView.added}</span> : null}
            {diffView.removed > 0 ? (
              <span className="write-diff-stat write-diff-stat--remove">−{diffView.removed}</span>
            ) : null}
          </span>
        ) : null}
        {session?.closed ? <span className="react-chat-write-stream-badge">closed</span> : null}
      </div>
      {format === 'markdown' ? (
        <article
          className="react-chat-write-stream-markdown markdown-body"
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      ) : hasDiff && diffView ? (
        <div className="write-diff-body" ref={viewportRef}>
          {diffView.truncated ? (
            <div className="write-diff-truncated" title={diffView.truncated}>
              {diffView.truncated}
            </div>
          ) : null}
          {diffView.rows.map((row, i) => (
            <WriteDiffRow key={`${row.kind}-${i}`} row={row} lang={lang} />
          ))}
        </div>
      ) : (
        <pre className={`react-chat-write-stream-pre is-${format}`}>
          {source || (session?.closed ? '[stream closed]' : '')}
        </pre>
      )}
      <span className="react-chat-write-stream-title-sr" aria-live="polite">
        {title}
      </span>
    </div>
  )
})
