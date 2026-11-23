/**
 * 非主对话页的小V：复用 V4 XiaomiRightStagePane（与 right-stage 同款），
 * 固定贴在当前功能页右侧，不跳 /chat、不用旧 xm-panel。
 */
import { Component, useCallback, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { XiaomiRightStagePane } from '../../react/right-stage/kinds/XiaomiRightStagePane.js'
import { XiaomiStageAvatar } from '../../react/components/XiaomiStageAvatar.js'
import './xiaomi-v4-dock.css'

class DockErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { err: string }
> {
  state = { err: '' }
  static getDerivedStateFromError(e: Error) {
    return { err: String(e?.message || e || 'render failed') }
  }
  componentDidCatch(e: Error, info: ErrorInfo) {
    console.warn('[xiaomi-v4-dock] pane crash', e, info?.componentStack)
  }
  render() {
    if (this.state.err) {
      return (
        <div className="xm-v4-dock-error" role="alert">
          <p>小V 面板加载失败：{this.state.err}</p>
          <button type="button" className="xm-v4-dock-close" onClick={this.props.onClose}>
            关闭
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export function XiaomiV4Dock(props: { onClose: () => void }) {
  const { onClose } = props

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  return (
    <aside className="xm-v4-dock" role="dialog" aria-label="小V" data-ui-track="xiaomi-v4-dock">
      <header className="xm-v4-dock-head">
        <div className="xm-v4-dock-brand">
          <XiaomiStageAvatar size={22} />
          <span className="xm-v4-dock-title">小V</span>
          <span className="xm-v4-dock-sub">当前页协助</span>
        </div>
        <button
          type="button"
          className="xm-v4-dock-close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭小V"
          data-ui-track="xiaomi-dock-close"
        >
          ×
        </button>
      </header>
      <div className="xm-v4-dock-body">
        <DockErrorBoundary onClose={onClose}>
          <XiaomiRightStagePane />
        </DockErrorBoundary>
      </div>
    </aside>
  )
}
