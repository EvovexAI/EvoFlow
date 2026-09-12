import { memo, type ReactNode } from 'react'
import { getRightStageKind, UnknownStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'

export type RightStageShellProps = {
  surface: RightStageSurface | null
  booting?: boolean
  bootTitle?: string
  onClose: () => void
  /** Fallback when kind not in registry (legacy inline render from ChatApp). */
  renderLegacy?: (surface: RightStageSurface) => ReactNode
}

export const RightStageShell = memo(function RightStageShell({
  surface,
  booting,
  bootTitle,
  onClose,
  renderLegacy,
}: RightStageShellProps) {
  if (!surface) return null

  const def = getRightStageKind(surface.kind)
  if (def) {
    return (
      <>
        {def.render({ surface, onClose })}
      </>
    )
  }

  if (renderLegacy) {
    const legacy = renderLegacy(surface)
    if (legacy) return <>{legacy}</>
  }

  // 已迁移到侧栏的面板种类：不占用 Right Stage 布局
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
