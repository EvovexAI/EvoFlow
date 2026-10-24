import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  title?: string
  children: ReactNode
}

type State = { error: Error | null }

/** Isolate one right-stage tab body so a Vite/lazy chunk failure cannot unmount the whole rail. */
export class RightStageTabErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      console.warn('[右栏] tab body crashed', this.props.title, error, info?.componentStack)
    } catch {
      /* ignore */
    }
  }

  render() {
    if (this.state.error) {
      const msg = String(this.state.error?.message || this.state.error || '渲染失败')
      const outdated = /outdated optimize dep|Failed to fetch dynamically imported module/i.test(msg)
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-ui-sm text-foreground-subtlest">
          <p>{this.props.title || '面板'}加载失败</p>
          <pre className="max-h-32 max-w-lg overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground-subtle">
            {msg}
          </pre>
          {outdated ? (
            <p className="text-center text-[11px] text-foreground-subtlest">
              开发服依赖缓存过期：请硬刷新页面，或重启 Vite（清 `.vite-cache`）后再打开。
            </p>
          ) : null}
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-foreground hover:bg-hover"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
