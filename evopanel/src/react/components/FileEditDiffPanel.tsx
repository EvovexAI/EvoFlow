import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { highlightCode } from '../../lib/markdown.js'
import {
  resolveWorkerFileDiffView,
  type FileDiffRow,
  type FileDiffSegment,
} from '../file-diff-util.js'

export type FileEditDiffPanelProps = {
  path: string
  action: string
  instruction?: string
  content?: string
  old_string?: string
  new_string?: string
  before_content?: string
  after_content?: string
  running?: boolean
  ok?: boolean
  result?: string
  deferContent?: boolean
  filled?: boolean
}

const HIGHLIGHT_CACHE_MAX = 1200
const highlightCache = new Map<string, string>()

const DIFF_LINE_HEIGHT_PX = 22
const DIFF_VIRTUALIZE_MIN_ROWS = 48
const DIFF_VIRTUAL_OVERSCAN = 10

function fileNameFromPath(path: string): string {
  const norm = String(path || '').replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : norm || path
}

function fileExtFromPath(path: string): string {
  const name = fileNameFromPath(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function actionLabelForFileEdit(action: string): string {
  const a = String(action || '').trim().toLowerCase()
  if (a === 'write') return 'Write'
  if (a === 'replace') return 'Edit'
  if (a === 'delete') return 'Delete'
  if (a === 'edit') return 'Edit'
  return a ? a.charAt(0).toUpperCase() + a.slice(1) : 'Edit'
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
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    rs: 'rust',
    go: 'go',
  }
  return map[ext] || ext || 'text'
}

function highlightLineCached(text: string, lang: string): string {
  const key = `${lang}\x00${text}`
  const hit = highlightCache.get(key)
  if (hit !== undefined) return hit
  const html = highlightCode(text.length ? text : '\u00a0', lang)
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) highlightCache.clear()
  highlightCache.set(key, html)
  return html
}

function segmentsForRow(row: FileDiffRow): FileDiffSegment[] {
  if (row.segments?.length) return row.segments
  return [{ text: row.text ?? '', changed: false }]
}

function hasInlinePatch(segments: FileDiffSegment[]): boolean {
  return segments.some((s) => s.changed) && segments.some((s) => !s.changed)
}

function rowSegmentKey(row: FileDiffRow): string {
  if (!row.segments?.length) return ''
  return row.segments.map((s) => `${s.changed ? 1 : 0}:${s.text}`).join('|')
}

const DiffLineCode = memo(function DiffLineCode({ row, lang }: { row: FileDiffRow; lang: string }) {
  const segKey = rowSegmentKey(row)
  const segments = segmentsForRow(row)
  const inline = hasInlinePatch(segments)
  const plainHtml = useMemo(
    () => (inline ? '' : highlightLineCached(row.text, lang)),
    [inline, row.text, lang, segKey],
  )
  if (!inline) {
    return <div className="file-diff-line__code" dangerouslySetInnerHTML={{ __html: plainHtml }} />
  }
  return (
    <div className="file-diff-line__code">
      {segments.map((seg, i) => {
        const html = highlightLineCached(seg.text, lang)
        if (seg.changed) {
          return (
            <mark
              key={i}
              className="file-diff-chunk"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )
        }
        return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </div>
  )
}, (prev, next) => {
  return (
    prev.lang === next.lang &&
    prev.row.kind === next.row.kind &&
    prev.row.text === next.row.text &&
    rowSegmentKey(prev.row) === rowSegmentKey(next.row)
  )
})

function rowExtraClass(prev: FileDiffRow | undefined, row: FileDiffRow): string {
  if (!prev) return ''
  if (prev.kind === 'remove' && row.kind === 'add') return ' file-diff-line--after-remove'
  if (row.text.startsWith('… 还有 ') && row.text.includes('行未显示')) return ' file-diff-line--truncated'
  return ''
}

function DiffLineRow({
  row,
  lang,
  prev,
}: {
  row: FileDiffRow
  lang: string
  prev?: FileDiffRow
}) {
  return (
    <div
      className={`file-diff-line file-diff-line--${row.kind}${rowExtraClass(prev, row)}${!row.text ? ' file-diff-line--blank' : ''}`.trim()}
    >
      <DiffLineCode row={row} lang={lang} />
    </div>
  )
}

const UnifiedDiffBody = memo(function UnifiedDiffBody({ rows, lang }: { rows: FileDiffRow[]; lang: string }) {
  const preRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(() => ({
    start: 0,
    end: Math.min(rows.length, DIFF_VIRTUALIZE_MIN_ROWS + DIFF_VIRTUAL_OVERSCAN),
  }))

  const updateVisible = useCallback(() => {
    const scroller = preRef.current?.closest('.file-diff-body') as HTMLElement | null
    if (!scroller || rows.length <= DIFF_VIRTUALIZE_MIN_ROWS) {
      setVisible({ start: 0, end: rows.length })
      return
    }
    const scrollTop = scroller.scrollTop
    const viewH = scroller.clientHeight || 320
    const start = Math.max(0, Math.floor(scrollTop / DIFF_LINE_HEIGHT_PX) - DIFF_VIRTUAL_OVERSCAN)
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewH) / DIFF_LINE_HEIGHT_PX) + DIFF_VIRTUAL_OVERSCAN,
    )
    setVisible((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [rows.length])

  useEffect(() => {
    queueMicrotask(() => setVisible({ start: 0, end: Math.min(rows.length, DIFF_VIRTUALIZE_MIN_ROWS + DIFF_VIRTUAL_OVERSCAN) }))
  }, [rows])

  useEffect(() => {
    const scroller = preRef.current?.closest('.file-diff-body') as HTMLElement | null
    if (!scroller || rows.length <= DIFF_VIRTUALIZE_MIN_ROWS) return
    updateVisible()
    scroller.addEventListener('scroll', updateVisible, { passive: true })
    return () => scroller.removeEventListener('scroll', updateVisible)
  }, [rows.length, updateVisible])

  if (!rows.length) return null

  const virtualized = rows.length > DIFF_VIRTUALIZE_MIN_ROWS
  const sliceStart = virtualized ? visible.start : 0
  const sliceEnd = virtualized ? visible.end : rows.length
  const topPad = virtualized ? visible.start * DIFF_LINE_HEIGHT_PX : 0
  const bottomPad = virtualized ? (rows.length - visible.end) * DIFF_LINE_HEIGHT_PX : 0

  return (
    <div className="file-diff-pre" ref={preRef}>
      {topPad > 0 ? <div className="file-diff-virtual-pad" style={{ height: topPad }} aria-hidden /> : null}
      {rows.slice(sliceStart, sliceEnd).map((row, offset) => {
        const i = sliceStart + offset
        return <DiffLineRow key={`${row.kind}-${i}-${row.text}`} row={row} lang={lang} prev={rows[i - 1]} />
      })}
      {bottomPad > 0 ? (
        <div className="file-diff-virtual-pad" style={{ height: bottomPad }} aria-hidden />
      ) : null}
    </div>
  )
})

export function FileEditDiffStat({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null
  return (
    <span className="file-diff-card__stats">
      {added > 0 ? <span className="file-diff-stat file-diff-stat--add">+{added}</span> : null}
      {removed > 0 ? (
        <span className="file-diff-stat file-diff-stat--remove">−{removed}</span>
      ) : null}
    </span>
  )
}

/** Inline +/- stats for tool summary rows (green add, red remove). */
export function FileEditDiffStatBrief({
  stats,
  action,
}: {
  stats: { added: number; removed: number }
  action?: string
}) {
  const act = String(action || '').trim().toLowerCase()
  if (act === 'delete') return null
  if (!stats.added && !stats.removed) return null
  return (
    <span className="file-diff-stat-brief">
      {stats.added > 0 ? <span className="file-diff-stat file-diff-stat--add">+{stats.added}</span> : null}
      {stats.removed > 0 ? (
        <span className="file-diff-stat file-diff-stat--remove">−{stats.removed}</span>
      ) : null}
    </span>
  )
}

function FileTypeIcon({ path }: { path: string }) {
  const ext = fileExtFromPath(path)
  const mod = ext ? ` file-diff-card__icon--${ext}` : ' file-diff-card__icon--file'
  return (
    <span className={`file-diff-card__icon${mod}`.trim()} aria-hidden="true">
      {ext ? ext.slice(0, 3).toUpperCase() : 'FILE'}
    </span>
  )
}

function ReservedPanel({
  pending,
  error,
  children,
}: {
  pending: boolean
  error?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={`file-diff-body${pending ? ' file-diff-body--pending' : ''}${error ? ' file-diff-body--error' : ''}`.trim()}
    >
      {children ?? (pending ? <div className="file-diff-placeholder" aria-hidden="true" /> : null)}
    </div>
  )
}

function FileEditDiffPanelInner({
  path,
  action,
  content,
  old_string,
  new_string,
  before_content,
  after_content,
  running = false,
  ok,
  result,
  deferContent = false,
  filled = false,
}: FileEditDiffPanelProps) {
  const act = String(action || '').trim().toLowerCase()
  const isDelete = act === 'delete'
  const fileName = fileNameFromPath(path)
  const lang = langFromPath(path)

  const pending = deferContent && !filled
  const showDeleteDone = isDelete && filled

  const diffView = useMemo(() => {
    // 流式写入中也要渲染已收到的 content，否则弹窗会一直空白
    return resolveWorkerFileDiffView({
      action: act,
      content,
      old_string,
      new_string,
      before_content,
      after_content,
    })
  }, [act, after_content, before_content, content, new_string, old_string])

  const statusClass =
    ok === true ? 'file-diff-card--ok' : ok === false ? 'file-diff-card--err' : running ? 'file-diff-card--running' : ''

  const hasDiffBody = Boolean(diffView?.rows.length)
  const showStats = Boolean(diffView && (filled || !deferContent || running) && (diffView.added || diffView.removed))
  const canShowDiff =
    hasDiffBody && diffView && (running || !deferContent || (filled && !pending))

  const streamingHint =
    running && !hasDiffBody ? <div className="file-diff-streaming-hint">正在写入…</div> : null
  const streamingFooter =
    running && hasDiffBody ? <div className="file-diff-streaming-hint">正在写入…</div> : null

  const diffBody =
    canShowDiff && diffView ? (
      <>
        {diffView.truncated ? (
          <div className="file-diff-truncated-hint" title={diffView.truncated}>
            {diffView.truncated}
          </div>
        ) : null}
        <UnifiedDiffBody rows={diffView.rows} lang={lang} />
        {streamingFooter}
      </>
    ) : ok === false ? (
      <pre className="file-diff-fallback">{result || 'Failed'}</pre>
    ) : isDelete && showDeleteDone ? (
      ok ? (
        <div className="file-diff-delete">Deleted</div>
      ) : (
        <pre className="file-diff-fallback">{result || 'Delete failed'}</pre>
      )
    ) : (
      streamingHint
    )

  return (
    <div className={`file-diff-card file-diff-card--ide ${statusClass}`.trim()}>
      <div className="file-diff-card__head">
        <FileTypeIcon path={path} />
        <span className="file-diff-card__path" title={path}>
          {fileName}
        </span>
        {showStats && diffView ? (
          <FileEditDiffStat added={diffView.added} removed={diffView.removed} />
        ) : null}
        {running ? <span className="file-diff-card__spinner" aria-label="Running" /> : null}
      </div>

      {deferContent ? (
        <ReservedPanel pending={pending} error={ok === false}>
          {pending ? null : diffBody}
        </ReservedPanel>
      ) : (
        diffBody ? <div className="file-diff-body">{diffBody}</div> : null
      )}
    </div>
  )
}

export const FileEditDiffPanel = memo(FileEditDiffPanelInner)
