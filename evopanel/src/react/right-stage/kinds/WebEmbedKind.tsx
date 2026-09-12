import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import {
  formatWebEmbedDisplayUrl,
  normalizeWebEmbedUserUrl,
  openWebEmbedExternally,
  resolveWebEmbedSrc,
} from '../web-embed-url.js'

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" strokeLinecap="round" />
      <path
        d="M12 3c2.5 2.8 3.8 6.2 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-6.2-3.8-9S9.5 5.8 12 3z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 5h5v5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 14L19 5" strokeLinecap="round" />
      <path d="M19 14v5H5V5h5" strokeLinecap="round" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const WebEmbedKind = memo(function WebEmbedKind({
  url,
  editable = false,
  onUrlChange,
  onClose,
  extensionId = '',
  extensionManifest = null,
  sandbox,
  titleLabel = '',
}: {
  url: string
  editable?: boolean
  onUrlChange?: (url: string) => void
  onClose?: () => void
  /** When set, attach EvoFlow extension postMessage bridge after iframe mounts. */
  extensionId?: string
  extensionManifest?: Record<string, unknown> | null
  /** Override iframe sandbox token list / string (extensions use manifest.ui.sandbox). */
  sandbox?: string | string[]
  /** Optional chrome label (extension name) instead of hostname. */
  titleLabel?: string
}) {
  const pageUrl = String(url || '').trim()
  const extId = String(extensionId || '').trim()
  const [draft, setDraft] = useState(pageUrl)
  const [frameKey, setFrameKey] = useState(0)
  const [loading, setLoading] = useState(!!pageUrl)
  const [blocked, setBlocked] = useState(false)
  const [localBlocked, setLocalBlocked] = useState(false)
  const [embedSrc, setEmbedSrc] = useState('')
  const [embedSrcDoc, setEmbedSrcDoc] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const editingRef = useRef(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const resolveGenRef = useRef(0)
  const bridgeCleanupRef = useRef<(() => void) | null>(null)

  const displayUrl = useMemo(() => {
    const label = String(titleLabel || '').trim()
    if (label) return label
    return formatWebEmbedDisplayUrl(pageUrl)
  }, [pageUrl, titleLabel])

  const sandboxAttr = useMemo(() => {
    if (Array.isArray(sandbox) && sandbox.length) {
      return sandbox.map((s) => String(s || '').trim()).filter(Boolean).join(' ')
    }
    const raw = String(sandbox || '').trim()
    if (raw) return raw
    return 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'
  }, [sandbox])

  // Sync store → draft only when the address bar is not being edited.
  // Otherwise paste/type can be wiped by a re-render that still has empty pageUrl.
  useEffect(() => {
    if (editingRef.current) return
    queueMicrotask(() => {
      if (!editingRef.current) setDraft(pageUrl)
    })
  }, [pageUrl])

  useEffect(() => {
    const gen = ++resolveGenRef.current
    queueMicrotask(() => {
      setLoading(!!pageUrl)
      setBlocked(false)
      setLocalBlocked(false)
      setEmbedSrc('')
      setEmbedSrcDoc(undefined)
    })
    if (!pageUrl) return

    let cancelled = false
    void (async () => {
      const resolved = await resolveWebEmbedSrc(pageUrl)
      if (cancelled || gen !== resolveGenRef.current) {
        resolved.revoke?.()
        return
      }
      if (resolved.localBlocked) {
        setLocalBlocked(true)
        setLoading(false)
        setEmbedSrc('')
        setEmbedSrcDoc(undefined)
        return
      }
      setEmbedSrc(resolved.src || '')
      setEmbedSrcDoc(resolved.srcDoc)
      setFrameKey((k) => k + 1)
      // srcDoc paints synchronously; clear loading on next frame
      if (resolved.srcDoc) {
        queueMicrotask(() => {
          if (!cancelled && gen === resolveGenRef.current) setLoading(false)
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pageUrl])

  // Avoid infinite "加载中" when iframe never fires onLoad.
  useEffect(() => {
    if (!loading || !pageUrl || localBlocked || blocked) return
    const timer = window.setTimeout(() => {
      setLoading(false)
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [loading, pageUrl, frameKey, localBlocked, blocked])

  useEffect(() => {
    if (editable && !pageUrl) {
      inputRef.current?.focus()
    }
  }, [editable, pageUrl])

  // Extension host bridge (same protocol as full-page ui-extension-shell).
  // Attach after the iframe node exists; re-run when src/key changes.
  useEffect(() => {
    bridgeCleanupRef.current?.()
    bridgeCleanupRef.current = null
    if (!extId || !pageUrl || localBlocked || blocked) return
    if (!embedSrc && !embedSrcDoc) return

    let cancelled = false
    let tries = 0

    const attach = () => {
      if (cancelled) return
      const iframe = frameRef.current
      if (!iframe) {
        if (tries++ < 20) {
          window.requestAnimationFrame(attach)
        }
        return
      }
      void import('../../../lib/ui-extension-bridge.js')
        .then(({ attachUiExtensionBridge }) => {
          if (cancelled || frameRef.current !== iframe) return
          bridgeCleanupRef.current?.()
          bridgeCleanupRef.current = attachUiExtensionBridge({
            iframe,
            extensionId: extId,
            manifest: extensionManifest || { ui: { entry: pageUrl } },
          })
        })
        .catch(() => {})
    }

    attach()
    return () => {
      cancelled = true
      bridgeCleanupRef.current?.()
      bridgeCleanupRef.current = null
    }
  }, [extId, pageUrl, frameKey, localBlocked, blocked, extensionManifest, embedSrc, embedSrcDoc])

  const refresh = useCallback(() => {
    if (!pageUrl) return
    setLoading(true)
    setBlocked(false)
    setLocalBlocked(false)
    // Re-trigger resolve by bumping via temporary clear — call resolve again
    resolveGenRef.current += 1
    const gen = resolveGenRef.current
    void (async () => {
      const resolved = await resolveWebEmbedSrc(pageUrl)
      if (gen !== resolveGenRef.current) {
        resolved.revoke?.()
        return
      }
      if (resolved.localBlocked) {
        setLocalBlocked(true)
        setLoading(false)
        return
      }
      setEmbedSrc(resolved.src || '')
      setEmbedSrcDoc(resolved.srcDoc)
      setFrameKey((k) => k + 1)
      if (resolved.srcDoc) setLoading(false)
    })()
  }, [pageUrl])

  const navigate = useCallback(
    (raw?: string) => {
      const next = normalizeWebEmbedUserUrl(raw ?? draft)
      if (!next) return
      setDraft(next)
      onUrlChange?.(next)
    },
    [draft, onUrlChange],
  )

  const onInputKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLInputElement>) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        editingRef.current = false
        navigate()
      }
    },
    [navigate],
  )

  const onInputPaste = useCallback((ev: ClipboardEvent<HTMLInputElement>) => {
    const raw = String(ev.clipboardData?.getData('text/plain') || '')
    // Browsers often paste trailing newlines / spaces with copied links; strip them.
    const cleaned = raw.replace(/^\s+|\s+$/g, '')
    if (!cleaned || cleaned === raw) return
    ev.preventDefault()
    const input = ev.currentTarget
    const start = input.selectionStart ?? draft.length
    const end = input.selectionEnd ?? draft.length
    const next = `${draft.slice(0, start)}${cleaned}${draft.slice(end)}`
    setDraft(next)
    queueMicrotask(() => {
      const pos = start + cleaned.length
      input.setSelectionRange(pos, pos)
    })
  }, [draft])

  const onOpenExternal = useCallback(
    (ev: MouseEvent) => {
      ev.preventDefault()
      void openWebEmbedExternally(pageUrl)
    },
    [pageUrl],
  )

  const canShowFrame = !!pageUrl && !blocked && !localBlocked && (!!embedSrc || !!embedSrcDoc)

  return (
    <div className="react-chat-web-embed">
      <header className="react-chat-web-embed-toolbar">
        <span className="react-chat-web-embed-globe" aria-hidden>
          <GlobeIcon />
        </span>
        {editable ? (
          <input
            ref={inputRef}
            type="text"
            inputMode="url"
            autoComplete="url"
            className="react-chat-web-embed-input"
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onFocus={() => {
              editingRef.current = true
            }}
            onBlur={() => {
              editingRef.current = false
              // Keep typed draft; only sync if store already has a URL and draft emptied.
              if (!String(draft || '').trim() && pageUrl) setDraft(pageUrl)
            }}
            onPaste={onInputPaste}
            onKeyDown={onInputKeyDown}
            placeholder="输入网址或本地文件路径，回车打开"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="网页地址"
          />
        ) : (
          <span className="react-chat-web-embed-url" title={pageUrl}>
            {displayUrl || '未指定网页地址'}
          </span>
        )}
        <button
          type="button"
          className="react-chat-web-embed-btn"
          onClick={refresh}
          disabled={!pageUrl}
          title="刷新"
          aria-label="刷新"
        >
          <RefreshIcon />
        </button>
        {pageUrl ? (
          <a
            className="react-chat-web-embed-btn"
            href={pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="在系统浏览器打开"
            aria-label="在系统浏览器打开"
            onClick={onOpenExternal}
          >
            <ExternalLinkIcon />
          </a>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className="react-chat-web-embed-btn react-chat-web-embed-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            ×
          </button>
        ) : null}
      </header>

      {!pageUrl ? (
        <div className="react-chat-web-embed-frame-wrap" aria-hidden />
      ) : localBlocked ? (
        <div className="react-chat-web-embed-blocked">
          <p>本地文件无法在网页版内嵌预览，请在桌面端打开，或用系统浏览器查看</p>
          <button type="button" className="react-chat-web-embed-hint-link" onClick={onOpenExternal}>
            在系统浏览器打开
          </button>
        </div>
      ) : blocked ? (
        <div className="react-chat-web-embed-blocked">
          <p>该网站禁止内嵌显示（X-Frame-Options / CSP）</p>
          <button type="button" className="react-chat-web-embed-hint-link" onClick={onOpenExternal}>
            在系统浏览器打开
          </button>
        </div>
      ) : (
        <div className="react-chat-web-embed-frame-wrap">
          {loading ? <div className="react-chat-web-embed-loading">加载中…</div> : null}
          {canShowFrame ? (
            <iframe
              ref={frameRef}
              key={frameKey}
              className="react-chat-web-embed-frame"
              title={displayUrl || '网页'}
              src={embedSrcDoc ? undefined : embedSrc}
              srcDoc={embedSrcDoc}
              sandbox={sandboxAttr}
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer-when-downgrade"
              onLoad={() => {
                setLoading(false)
                // Extension SPAs / bridge hosts often start with an empty body — don't mark blocked.
                if (extId) return
                try {
                  const doc = frameRef.current?.contentDocument
                  if (doc && (!doc.body || !String(doc.body.innerHTML || '').trim())) {
                    setBlocked(true)
                  }
                } catch {
                  // Cross-origin: normal for successful embeds; keep iframe.
                }
              }}
              onError={() => {
                setLoading(false)
                if (!extId) setBlocked(true)
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  )
})
