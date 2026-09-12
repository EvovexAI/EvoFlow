export function SidePanelBootShell({
  title,
  className = 'react-chat-collab-exec-panel',
  bodyClassName = 'react-chat-collab-exec-panel-body',
}: {
  title: string
  className?: string
  bodyClassName?: string
}) {
  return (
    <aside className={className} role="region" aria-busy="true" aria-label={title}>
      <header className="react-chat-collab-exec-panel-header">
        <div className="react-chat-collab-exec-panel-title-wrap">
          <span className="react-chat-collab-exec-panel-title">{title}</span>
        </div>
      </header>
      <div className={`${bodyClassName} react-chat-side-panel-boot`}>
        <div className="page-loader-spinner" aria-hidden="true" />
        <span className="page-loader-text">加载中…</span>
      </div>
    </aside>
  )
}
