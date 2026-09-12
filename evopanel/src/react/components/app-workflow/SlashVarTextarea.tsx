import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

export type SlashVarItem = {
  id: string
  /** Shown in menu */
  label: string
  /** Inserted text, e.g. {{topic}} */
  insert: string
  group?: string
  hint?: string
}

type Props = {
  id?: string
  className?: string
  rows?: number
  value: string
  placeholder?: string
  items: SlashVarItem[]
  onChange: (value: string) => void
  onPointerDown?: (e: React.PointerEvent) => void
}

type ActiveSlash = { start: number; query: string }

const VAR_TOKEN_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g

function findActiveSlash(text: string, caret: number): ActiveSlash | null {
  if (caret < 0 || caret > text.length) return null
  const before = text.slice(0, caret)
  const m = before.match(/(?:^|[\s，。；、\n（({[])\/([a-zA-Z0-9_一-鿿]*)$/)
  if (!m) return null
  const query = m[1] || ''
  const start = caret - query.length - 1
  if (start < 0 || text[start] !== '/') return null
  return { start, query }
}

/** Build {{name}} → display label map from picker items (insert is `{{name}}`). */
function buildLabelMap(items: SlashVarItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const it of items) {
    const m = String(it.insert || '').match(/^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/)
    if (m) map.set(m[1], it.label || m[1])
  }
  return map
}

/** Escape HTML special chars to prevent XSS in the render layer. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Render text with {{var}} tokens replaced by chip HTML.
 * Preserves whitespace and newlines.
 */
function renderWithChips(text: string, labels: Map<string, string>): string {
  if (!text) return ''
  const parts: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  VAR_TOKEN_RE.lastIndex = 0
  while ((match = VAR_TOKEN_RE.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(escapeHtml(text.slice(lastIndex, match.index)))
    }
    // Add the chip
    const name = match[1]
    const label = labels.get(name) || name
    parts.push(`<span class="wf-var-inline-chip" data-var="${escapeHtml(name)}">${escapeHtml(label)}</span>`)
    lastIndex = match.index + match[0].length
  }
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.slice(lastIndex)))
  }
  return parts.join('')
}

/**
 * Textarea with inline variable chips — {{topic}} renders as a styled chip
 * inside the text area itself, not as raw "{{topic}}" text.
 *
 * Uses the classic "textarea + transparent overlay" pattern:
 * - textarea: editable, but text is transparent (only caret visible)
 * - overlay: renders text with {{var}} replaced by chips
 * - both layers scroll in sync
 */
export function SlashVarTextarea({
  id,
  className,
  rows = 6,
  value,
  placeholder,
  items,
  onChange,
  onPointerDown,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [slash, setSlash] = useState<ActiveSlash | null>(null)
  const [hi, setHi] = useState(0)

  const labelMap = useMemo(() => buildLabelMap(items), [items])
  const renderedHtml = useMemo(() => renderWithChips(String(value || ''), labelMap), [value, labelMap])

  const filtered = useMemo(() => {
    const q = String(slash?.query || '')
      .trim()
      .toLowerCase()
    if (!q) return items
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q) ||
        it.insert.toLowerCase().includes(q),
    )
  }, [items, slash?.query])

  const groups = useMemo(() => {
    const map = new Map<string, SlashVarItem[]>()
    for (const it of filtered) {
      const g = it.group || '变量'
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(it)
    }
    return [...map.entries()]
  }, [filtered])

  const syncFromCaret = useCallback(() => {
    const el = taRef.current
    if (!el) return
    const next = findActiveSlash(el.value, el.selectionStart ?? 0)
    if (next && items.length) {
      setSlash(next)
      setOpen(true)
      setHi(0)
    } else {
      setSlash(null)
      setOpen(false)
    }
  }, [items.length])

  /** Sync scroll between textarea and overlay. */
  const syncScroll = useCallback(() => {
    if (taRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = taRef.current.scrollTop
      overlayRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }, [])

  const pick = useCallback(
    (item: SlashVarItem) => {
      const el = taRef.current
      if (!el || !slash) return
      const caret = el.selectionStart ?? value.length
      const before = value.slice(0, slash.start)
      const after = value.slice(caret)
      const next = `${before}${item.insert}${after}`
      onChange(next)
      setOpen(false)
      setSlash(null)
      requestAnimationFrame(() => {
        const pos = before.length + item.insert.length
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    },
    [onChange, slash, value],
  )

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => setHi((h) => Math.min(h, Math.max(0, filtered.length - 1))))
  }, [filtered.length, open])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || !filtered.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((h) => (h + 1) % filtered.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((h) => (h - 1 + filtered.length) % filtered.length)
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(filtered[hi] || filtered[0])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setSlash(null)
    }
  }

  return (
    <div className={`wf-slash-var${className ? ` ${className}` : ''}`}>
      <div className="wf-slash-var-stack">
        {/* Render layer: shows text with chips */}
        <div
          ref={overlayRef}
          className="wf-slash-var-overlay"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: renderedHtml || '&nbsp;' }}
        />
        {/* Editable textarea: text is transparent, only caret visible */}
        <textarea
          ref={taRef}
          id={id}
          className="wf-slash-var-textarea"
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value)
            requestAnimationFrame(syncFromCaret)
          }}
          onScroll={syncScroll}
          onKeyUp={syncFromCaret}
          onClick={syncFromCaret}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            // 如果焦点移到了菜单项内，不关闭（比 setTimeout 更可靠）
            const related = e.relatedTarget as HTMLElement | null
            if (related && related.closest('.wf-slash-var-menu')) return
            // 兜底延迟：防止 mousedown 时序竞争导致选择失败
            window.setTimeout(() => setOpen(false), 100)
          }}
          onPointerDown={onPointerDown}
        />
      </div>
      {items.length ? (
        <div className="wf-slash-var-hint">输入 <kbd>/</kbd> 快速引用变量</div>
      ) : null}
      {open && filtered.length ? (
        <div className="wf-slash-var-menu" role="listbox">
          {groups.map(([group, list]) => (
            <div key={group} className="wf-slash-var-group">
              <div className="wf-slash-var-group-title">{group}</div>
              {list.map((it) => {
                const idx = filtered.indexOf(it)
                return (
                  <button
                    key={it.id}
                    type="button"
                    role="option"
                    aria-selected={idx === hi}
                    className={`wf-slash-var-item${idx === hi ? ' is-active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(it)
                    }}
                    onMouseEnter={() => setHi(idx)}
                  >
                    <span className="wf-slash-var-item-label">{it.label}</span>
                    <code className="wf-slash-var-item-key">{it.insert}</code>
                    {it.hint ? <span className="wf-slash-var-item-hint">{it.hint}</span> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
      {open && slash && !filtered.length ? (
        <div className="wf-slash-var-menu wf-slash-var-menu--empty">无匹配变量</div>
      ) : null}
    </div>
  )
}
