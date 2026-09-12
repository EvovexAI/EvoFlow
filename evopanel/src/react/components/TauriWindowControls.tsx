import { useCallback, useEffect, useState } from 'react'

function isTauriRuntime(): boolean {
  return !!(typeof window !== 'undefined' && ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI__?: unknown }).__TAURI__))
}

export function TauriWindowControls() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    queueMicrotask(() => setShow(isTauriRuntime()))
  }, [])

  const minimize = useCallback(() => {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => void getCurrentWindow().minimize())
  }, [])
  const toggleMaximize = useCallback(() => {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => void getCurrentWindow().toggleMaximize())
  }, [])
  const close = useCallback(() => {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => void getCurrentWindow().close())
  }, [])

  if (!show) return null

  return (
    <div className="ep-window-controls">
      <button
        type="button"
        className="ep-window-controls-btn ep-window-controls-btn--min"
        data-tauri-no-drag
        onClick={minimize}
        title="最小化"
        aria-label="最小化"
      >
        −
      </button>
      <button
        type="button"
        className="ep-window-controls-btn ep-window-controls-btn--max"
        data-tauri-no-drag
        onClick={toggleMaximize}
        title="最大化"
        aria-label="最大化"
      >
        □
      </button>
      <button
        type="button"
        className="ep-window-controls-btn ep-window-controls-btn--close"
        data-tauri-no-drag
        onClick={close}
        title="关闭"
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}
