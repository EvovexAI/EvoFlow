import { memo, type ReactNode } from 'react'
import { getRightStageKind, UnknownStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'

export type RightStageShellProps = {
  surface: RightStageSurface | null
  booting?: boolean
  bootTitle?: string
  onClose: () => void
  /**
   * 窗控是否由本标签条承载。tabstrip 迁入 BrowserPanel 后本参数保留为
   * API 兼容字段（旧的调用方 ChatApp 还在传），不再使用。
   */
  showWindowControls?: boolean
  /** Fallback when kind not in registry (legacy inline render from ChatApp). */
  renderLegacy?: (surface: RightStageSurface) => ReactNode
}

/**
 * 浏览器面板自带的 surface tabstrip（在 BrowserPanel 内部渲染），所以
 * RightStageShell 不再叠加外层 strip。legacy 分支只负责 panel 内容。
 */
export const RightStageShell = memo(function RightStageShell({
  surface,
  booting,
  bootTitle,
  onClose: _onClose,
  showWindowControls: _showWindowControls,
  renderLegacy,
}: RightStageShellProps) {
  if (!surface) return null

  const def = getRightStageKind(surface.kind)
  if (def) {
    return def.render({ surface, onClose: _onClose })
  }

  if (renderLegacy) {
    const legacy = renderLegacy(surface)
    if (legacy) return legacy
  }

  if (normalizeRightStageKind(surface.kind) === 'artifacts') {
    return null
  }

  if (booting && bootTitle) {
    return (
      <aside className="react-chat-right-stage-panel" role="region" aria-busy="true" aria-label={bootTitle}>
        <header className="react-chat-collab-exec-panel-header">
          <div className="react-chat-collab-exec-panel-title-wrap">
            <span className="react-chat-collab-exec-panel-title">{bootTitle}</span>
          </div>
        </header>
        <div className="react-chat-collab-exec-panel-body react-chat-side-panel-boot">
          <div className="page-loader-spinner" aria-hidden="true" />
          <span className="page-loader-text">加载中…</span>
        </div>
      </aside>
    )
  }

  return <UnknownStageKind kind={surface.kind} />
})
