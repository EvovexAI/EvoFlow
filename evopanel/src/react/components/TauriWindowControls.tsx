import { useCallback, useEffect, useState } from 'react'
// 本仓库锁定的 lucide-react 版本没有 WindowRestore，用 Copy 承担「最大化↔还原」切换，
// AppWindow 表示未最大化态（与 Restore 的双层方框语义相反但同样可辨）。
import { AppWindow, Copy, Minus, X } from 'lucide-react'

function isTauriRuntime(): boolean {
  return !!(typeof window !== 'undefined' && ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI__?: unknown }).__TAURI__))
}

export function TauriWindowControls() {
  const [show, setShow] = useState(false)
  /** 最大化状态：决定最大化/还原按钮用哪个图标（ZCode 同款行为）。 */
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    queueMicrotask(() => setShow(isTauriRuntime()))
  }, [])

  useEffect(() => {
    if (!show) return
    let cancelled = false
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow()
      const sync = async () => {
        try {
          const next = await appWindow.isMaximized()
          if (!cancelled) setMaximized(next)
        } catch {
          // 平台不支持 isMaximized（如部分 Linux WM）时保持默认非最大化态。
        }
      }
      await sync()
      try {
        await appWindow.onResized(() => void sync())
      } catch {
        // 监听失败不影响最小化/关闭等其它按钮。
      }
    })
    return () => {
      cancelled = true
    }
  }, [show])

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
        data-testid="window-control-minimize"
        onClick={minimize}
        title="最小化窗口"
        aria-label="最小化窗口"
      >
        <Minus className="ep-window-controls-icon" aria-hidden />
      </button>
      <button
        type="button"
        className="ep-window-controls-btn ep-window-controls-btn--max"
        data-tauri-no-drag
        data-testid="window-control-maximize"
        data-maximized={maximized ? 'true' : undefined}
        onClick={toggleMaximize}
        title="最大化或还原窗口"
        aria-label="最大化或还原窗口"
      >
        {maximized ? (
          <Copy className="ep-window-controls-icon" aria-hidden />
        ) : (
          <AppWindow className="ep-window-controls-icon" aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="ep-window-controls-btn ep-window-controls-btn--close"
        data-tauri-no-drag
        data-testid="window-control-close"
        onClick={close}
        title="关闭窗口"
        aria-label="关闭窗口"
      >
        <X className="ep-window-controls-icon" aria-hidden />
      </button>
    </div>
  )
}
