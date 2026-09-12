import { useEffect, useMemo, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { formatJsonText, stripObservabilityDebugNoise } from '../lib/obs-payload-parse'

type JsonViewerProps = {
  title: string
  value: unknown
  emptyHint?: string
  mode?: 'json' | 'text'
  maxHeight?: number
  /** preview：缩略 + 弹窗放大；panel：内嵌树形 JSON 面板（占满父容器） */
  layout?: 'preview' | 'panel'
}

const MODAL_FONT_MIN = 12
const MODAL_FONT_MAX = 32
const MODAL_FONT_DEFAULT = 15

function obsPortalTarget(): HTMLElement {
  return document.getElementById('obs-fullscreen-root') ?? document.body
}

/** Try to parse a string as JSON; return the parsed value or the original string. */
function tryParseJson(value: unknown): { mode: 'json' | 'text'; parsed: unknown } {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return { mode: 'json', parsed: JSON.parse(t) }
      } catch {
        /* plain text */
      }
    }
    return { mode: 'text', parsed: value }
  }
  if (value !== null && typeof value === 'object') {
    return { mode: 'json', parsed: value }
  }
  return { mode: 'json', parsed: value }
}

function valueTypeClass(v: unknown): string {
  if (v === null) return 'jv-null'
  if (typeof v === 'string') return 'jv-string'
  if (typeof v === 'number') return 'jv-number'
  if (typeof v === 'boolean') return 'jv-bool'
  return 'jv-other'
}

function formatPrimitive(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function formatKeyLabel(k: string): string {
  if (k.startsWith('[')) return k
  return JSON.stringify(k)
}

function countItems(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value !== null && typeof value === 'object') return Object.keys(value).length
  return 0
}

// ── Tree Node Component ──

interface TreeNodeProps {
  value: unknown
  keyLabel: string | null
  depth: number
  defaultExpanded: boolean
}

function TreeNode({ value, keyLabel, depth, defaultExpanded }: TreeNodeProps) {
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === 'object' && !isArr
  const isContainer = isArr || isObj
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (!isContainer) {
    return (
      <div className="jv-node" data-depth={depth}>
        <div className="jv-line">
          <span className="jv-toggle-spacer" aria-hidden="true" />
          {keyLabel != null && (
            <>
              <span className="jv-key">{formatKeyLabel(keyLabel)}</span>
              <span className="jv-punct">: </span>
            </>
          )}
          <span className={`jv-val ${valueTypeClass(value)}`}>{formatPrimitive(value)}</span>
        </div>
      </div>
    )
  }

  const count = countItems(value)
  const openBracket = isArr ? '[' : '{'
  const closeBracket = isArr ? ']' : '}'

  return (
    <div className="jv-node" data-depth={depth}>
      <div className="jv-line">
        <button
          type="button"
          className="jv-toggle"
          aria-expanded={expanded ? 'true' : 'false'}
          aria-label={expanded ? '折叠' : '展开'}
          onClick={() => setExpanded((e) => !e)}
        >
          <span className={`jv-toggle-icon ${expanded ? 'jv-toggle-icon--open' : ''}`} aria-hidden="true" />
        </button>
        {keyLabel != null && (
          <>
            <span className="jv-key">{formatKeyLabel(keyLabel)}</span>
            <span className="jv-punct">: </span>
          </>
        )}
        <span className="jv-punct">{openBracket}</span>
        {!expanded && (
          <span className="jv-summary"> {count} {isArr ? 'items' : 'keys'} </span>
        )}
        {!expanded && <span className="jv-punct">{closeBracket}</span>}
      </div>
      {expanded && (
        <div className="jv-children">
          {isArr
            ? value.map((item: unknown, i: number) => (
                <TreeNode key={i} value={item} keyLabel={`[${i}]`} depth={depth + 1} defaultExpanded={depth + 1 < 3} />
              ))
            : Object.entries(value as Record<string, unknown>).map(([k, v]) => (
                <TreeNode key={k} value={v} keyLabel={k} depth={depth + 1} defaultExpanded={depth + 1 < 3} />
              ))}
          <div className="jv-line jv-line--close">
            <span className="jv-punct">{closeBracket}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── JsonTree Component ──

function JsonTree({ value }: { value: unknown }) {
  const isContainer = value !== null && typeof value === 'object'
  return (
    <div className="jv-tree">
      {isContainer ? (
        <TreeNode value={value} keyLabel={null} depth={0} defaultExpanded={true} />
      ) : (
        <div className="jv-line jv-line--root-primitive">
          <span className={`jv-val ${valueTypeClass(value)}`}>{formatPrimitive(value)}</span>
        </div>
      )}
    </div>
  )
}

// ── Main JsonViewer ──

export function JsonViewer({
  title,
  value,
  emptyHint = '暂无数据',
  mode = 'json',
  maxHeight = 270,
  layout = 'preview',
}: JsonViewerProps) {
  const [open, setOpen] = useState(false)
  const [fontSize, setFontSize] = useState(MODAL_FONT_DEFAULT)
  const [allExpanded, setAllExpanded] = useState(true)

  const { normalized, text } = useMemo(() => {
    if (value == null || value === '') return { normalized: null, text: '' }
    if (mode === 'text') return { normalized: null, text: String(value) }
    const result = tryParseJson(value)
    const parsed =
      result.mode === 'json' ? stripObservabilityDebugNoise(result.parsed) : result.parsed
    return {
      normalized: { ...result, parsed },
      text: result.mode === 'json' ? formatJsonText(parsed) : String(parsed),
    }
  }, [mode, value])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setFontSize(MODAL_FONT_DEFAULT)
        setAllExpanded(true)
      })
    }
  }, [open])

  const copy = useCallback(async () => {
    const copyText = text || (normalized?.parsed != null ? JSON.stringify(normalized.parsed, null, 2) : '')
    if (!copyText) return
    try {
      await navigator.clipboard.writeText(copyText)
    } catch {
      /* ignore */
    }
  }, [text, normalized])

  if (!text && !normalized) {
    return <div className="drawer-empty-hint">{emptyHint}</div>
  }

  const isJsonMode = mode !== 'text' && normalized?.mode === 'json'

  if (layout === 'panel') {
    return (
      <div className="json-viewer json-viewer--panel">
        <div className="json-viewer-head">
          {title.trim() ? <strong>{title}</strong> : <span />}
          <div className="json-viewer-actions">
            {isJsonMode ? (
              <>
                <button type="button" onClick={() => setAllExpanded(true)}>全部展开</button>
                <button type="button" onClick={() => setAllExpanded(false)}>全部折叠</button>
              </>
            ) : null}
            <button type="button" onClick={() => void copy()}>复制</button>
          </div>
        </div>
        <div className="json-viewer-panel-body" style={{ fontSize }}>
          {isJsonMode ? (
            <JsonTreeWrapper value={normalized!.parsed} allExpanded={allExpanded} />
          ) : (
            <pre className="json-block json-block--panel">{text}</pre>
          )}
        </div>
      </div>
    )
  }

  const modalLabel = title.trim() || '内容预览'

  const modal =
    open &&
    createPortal(
      <div className="obs-json-modal" role="dialog" aria-modal="true" aria-label={modalLabel}>
        <div className="obs-json-modal-backdrop" onClick={() => setOpen(false)} />
        <div className="obs-json-modal-panel">
          <div className="obs-json-modal-head">
            <strong>{modalLabel}</strong>
            <div className="json-viewer-actions">
              <button type="button" onClick={() => setFontSize((n) => Math.max(MODAL_FONT_MIN, n - 1))}>
                A−
              </button>
              <button type="button" onClick={() => setFontSize((n) => Math.min(MODAL_FONT_MAX, n + 1))}>
                A+
              </button>
              {isJsonMode && (
                <>
                  <button type="button" onClick={() => setAllExpanded(true)}>
                    全部展开
                  </button>
                  <button type="button" onClick={() => setAllExpanded(false)}>
                    全部折叠
                  </button>
                </>
              )}
              <button type="button" onClick={() => void copy()}>
                复制
              </button>
              <button type="button" className="obs-json-modal-close" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
          <div className="obs-json-modal-body" style={{ fontSize }}>
            {isJsonMode ? (
              <JsonTreeWrapper value={normalized!.parsed} allExpanded={allExpanded} />
            ) : (
              <pre className="json-block" style={{ fontSize, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {text}
              </pre>
            )}
          </div>
        </div>
      </div>,
      obsPortalTarget(),
    )

  return (
      <div className="json-viewer">
      {title.trim() ? (
        <div className="json-viewer-head">
          <strong>{title}</strong>
          <div className="json-viewer-actions">
            <button type="button" onClick={() => void copy()}>
              复制
            </button>
            <button type="button" onClick={() => setOpen(true)}>
              弹窗放大
            </button>
          </div>
        </div>
      ) : (
        <div className="json-viewer-head json-viewer-head--actions-only">
          <div className="json-viewer-actions">
            <button type="button" onClick={() => void copy()}>
              复制
            </button>
            <button type="button" onClick={() => setOpen(true)}>
              弹窗放大
            </button>
          </div>
        </div>
      )}
      <pre
        className="json-block json-block--preview"
        style={{ maxHeight, '--json-max-height': `${maxHeight}px` } as React.CSSProperties}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
        role="button"
        tabIndex={0}
        title="点击在全屏弹窗中查看"
      >
        {text}
      </pre>
      {modal}
    </div>
  )
}

// ── JsonTreeWrapper: re-renders tree when allExpanded changes ─

function JsonTreeWrapper({ value, allExpanded }: { value: unknown; allExpanded: boolean }) {
  // Force re-mount when allExpanded changes to reset expansion state
  const [key, setKey] = useState(0)
  useEffect(() => {
    queueMicrotask(() => setKey((k) => k + 1))
  }, [allExpanded])
  return <JsonTree key={key} value={value} />
}
