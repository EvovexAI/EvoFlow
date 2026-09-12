import { useEffect, useState, type SyntheticEvent } from 'react'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import {
  parseBrowserScreenshotToolOutput,
  resolveBrowserScreenshotSrc,
  resolveBrowserScreenshotSrcAsync,
} from '../../lib/chat-normalize.js'

const isTauri =
  typeof window !== 'undefined' &&
  // @ts-ignore
  !!(window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__)

export type BrowserScreenshotPreviewProps = {
  /** Raw tool output (JSON string or object), not formatToolOutputForUserDisplay text */
  output: unknown
}

export function BrowserScreenshotPreview({ output }: BrowserScreenshotPreviewProps) {
  const shot = parseBrowserScreenshotToolOutput(output)
  const [src, setSrc] = useState('')
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    if (!shot?.src) {
      queueMicrotask(() => {
        setSrc('')
        setBroken(false)
      })
      return
    }
    let cancelled = false
    queueMicrotask(() => setBroken(false))
    ;(async () => {
      try {
        const resolved = isTauri
          ? await resolveBrowserScreenshotSrcAsync(shot.src)
          : resolveBrowserScreenshotSrc(shot.src)
        if (!cancelled) setSrc(resolved)
      } catch {
        if (!cancelled) {
          setSrc('')
          setBroken(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [shot?.src])

  if (!shot?.src) return null

  const onImgError = (_e: SyntheticEvent<HTMLImageElement>) => {
    setBroken(true)
  }

  return (
    <div className="msg-tool-block msg-tool-block--screenshot">
      <span className="msg-tool-title">截图</span>
      {shot.summary ? (
        <p className="msg-tool-screenshot-summary">{shot.summary}</p>
      ) : null}
      {shot.pageUrl ? (
        <p className="msg-tool-screenshot-page">
          <a href={shot.pageUrl} target="_blank" rel="noopener noreferrer">
            {shot.pageUrl}
          </a>
        </p>
      ) : null}
      {broken ? (
        <p className="msg-tool-screenshot-error">
          截图加载失败。请确认服务已启动，或{' '}
          {src ? (
            <a href={src} target="_blank" rel="noopener noreferrer">
              在新标签页打开
            </a>
          ) : (
            <span>稍后重试</span>
          )}
        </p>
      ) : src ? (
        <button
          type="button"
          className="msg-tool-screenshot-btn"
          title="放大"
          aria-label="打开截图预览"
          onClick={() => showChatLightbox(src)}
        >
          <img
            className="msg-tool-screenshot-img"
            src={src}
            alt="浏览器截图"
            loading="lazy"
            onError={onImgError}
          />
          <span className="msg-tool-screenshot-hint">点击放大</span>
        </button>
      ) : (
        <p className="msg-tool-screenshot-loading">正在加载截图…</p>
      )}
    </div>
  )
}