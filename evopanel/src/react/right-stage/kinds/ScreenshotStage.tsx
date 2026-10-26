/**
 * 右侧「截图」预览：CUA / 电脑控制 / 浏览器工具产物。
 * data.uri 可为 browser-snapshots API、serve-file、http(s)、data URL。
 */
import { useEffect, useState } from 'react'
import { resolveBrowserScreenshotSrcAsync } from '../../../lib/chat-normalize.js'
import { resolveChatImageSrc } from '../../../lib/chat-image-src.js'
import type { RightStageKindRenderProps } from '../../../lib/right-stage/right-stage-registry.js'

type ShotData = {
  uri?: string
  mimeType?: string
  title?: string
}

export function ScreenshotStage({ surface }: RightStageKindRenderProps) {
  const data = (surface.data || {}) as ShotData
  const uri = String(data.uri || '').trim()
  const title = String(data.title || surface.title || '截图').trim() || '截图'
  const [src, setSrc] = useState(() => (uri ? resolveChatImageSrc(uri) || uri : ''))
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    setErr('')
    if (!uri) {
      setSrc('')
      return
    }
    const sync = resolveChatImageSrc(uri)
    if (sync) {
      setSrc(sync)
      return
    }
    setSrc(uri)
    void resolveBrowserScreenshotSrcAsync(uri)
      .then((resolved) => {
        if (cancelled) return
        if (resolved) setSrc(resolved)
      })
      .catch(() => {
        /* keep raw uri */
      })
    return () => {
      cancelled = true
    }
  }, [uri])

  return (
    <aside
      className="react-chat-right-stage-panel react-chat-screenshot-panel"
      role="region"
      aria-label={title}
    >
      <div className="xw-right-shot">
        {!uri ? (
          <div className="xw-right-shot__empty" role="status">
            暂无截图
          </div>
        ) : err ? (
          <div className="xw-right-shot__err" role="alert">
            {err}
          </div>
        ) : (
          <div className="xw-right-shot__frame">
            <img
              className="xw-right-shot__img"
              src={src || uri}
              alt={title}
              onError={() => setErr('截图加载失败')}
            />
          </div>
        )}
      </div>
    </aside>
  )
}
