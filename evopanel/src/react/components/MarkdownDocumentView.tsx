/**
 * Shared Markdown document viewer: rendered preview by default,
 * optional Edit / Preview mode switch (same UX as knowledge vault notes).
 */
import { useCallback, useEffect, useState } from 'react'
import { MarkdownHtml } from './MarkdownHtml.js'
import '../../style/markdown-document-view.css'

export type MarkdownDocMode = 'preview' | 'edit'

export type MarkdownDocumentViewProps = {
  text: string
  /** Controlled mode. When omitted, uses defaultMode. */
  mode?: MarkdownDocMode
  /** Uncontrolled initial mode. Default: preview. */
  defaultMode?: MarkdownDocMode
  onModeChange?: (mode: MarkdownDocMode) => void
  /**
   * When true, show Edit / Preview switch and allow editing source.
   * When false, preview-only (no edit button).
   */
  allowEdit?: boolean
  /** Source change while in edit mode. */
  onChange?: (text: string) => void
  /** Disable textarea even when allowEdit (e.g. saving). */
  readOnly?: boolean
  className?: string
  /** Extra class on MarkdownHtml preview. */
  previewClassName?: string
  placeholder?: string
  /** Prefix for data-testid attributes (default: md-doc). */
  testIdPrefix?: string
  /** Hide the mode switch chrome (parent owns tabs). */
  hideModeSwitch?: boolean
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

export function MarkdownDocumentView({
  text,
  mode: controlledMode,
  defaultMode = 'preview',
  onModeChange,
  allowEdit = false,
  onChange,
  readOnly = false,
  className = '',
  previewClassName = '',
  placeholder = '在此编辑 Markdown 原文…',
  testIdPrefix = 'md-doc',
  hideModeSwitch = false,
}: MarkdownDocumentViewProps) {
  const [innerMode, setInnerMode] = useState<MarkdownDocMode>(defaultMode)
  const isControlled = controlledMode !== undefined
  const mode: MarkdownDocMode = !allowEdit
    ? 'preview'
    : isControlled
      ? controlledMode
      : innerMode

  useEffect(() => {
    if (!allowEdit && isControlled && controlledMode !== 'preview') {
      onModeChange?.('preview')
    }
  }, [allowEdit, isControlled, controlledMode, onModeChange])

  const setMode = useCallback(
    (next: MarkdownDocMode) => {
      if (!allowEdit && next === 'edit') return
      if (!isControlled) setInnerMode(next)
      onModeChange?.(next)
    },
    [allowEdit, isControlled, onModeChange],
  )

  const showSwitch = allowEdit && !hideModeSwitch
  const body =
    mode === 'edit' && allowEdit ? (
      <textarea
        className="md-doc-source"
        data-testid={`${testIdPrefix}-source`}
        disabled={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        value={text}
      />
    ) : (
      <div className="md-doc-preview-wrap" data-testid={`${testIdPrefix}-preview`}>
        <MarkdownHtml
          className={`md-doc-preview markdown-body msg-text${previewClassName ? ` ${previewClassName}` : ''}`}
          text={text}
        />
      </div>
    )

  return (
    <div className={`md-doc-view${className ? ` ${className}` : ''}${showSwitch ? ' has-mode-switch' : ''}`}>
      {showSwitch ? (
        <div className="md-doc-toolbar">
          <div className="md-doc-segment" role="tablist" aria-label="视图模式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'preview'}
              className={mode === 'preview' ? 'is-active' : ''}
              data-testid={`${testIdPrefix}-tab-preview`}
              onClick={() => setMode('preview')}
            >
              <EyeIcon />
              <span>预览</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'edit'}
              className={mode === 'edit' ? 'is-active' : ''}
              data-testid={`${testIdPrefix}-tab-edit`}
              onClick={() => setMode('edit')}
            >
              <EditIcon />
              <span>编辑</span>
            </button>
          </div>
        </div>
      ) : null}
      <div className="md-doc-body">{body}</div>
    </div>
  )
}

/** True when path/name looks like Markdown. */
export function isMarkdownDocumentPath(pathOrName: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(String(pathOrName || '').trim())
}
