/**
 * 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增「该面板在当前嵌入宿主里不支持」的终态提示组件，替换原先用
 *   <SidePanelBootShell>（渲染出来是「加载中…」转圈）当兜底的写法。
 * 为什么：用户实测反馈「右侧有一个任务，里面一直显示加载中」。根因是
 *   TaskDetailRightStageHost / ProactiveRosterRightStageHost 的 renderContent 只认固定
 *   几个 kind，没命中就 return <SidePanelBootShell>。而 BootShell 的语义是「首个 rAF 之后
 *   就会换成真面板」的瞬时占位——放在永不 resolve 的兜底分支上，就等于永久转圈，
 *   用户永远等不到结果、也看不出是哪里不支持。
 *   正确语义：不支持 → 立刻说明「这个面板不能在当前嵌入视图打开」，并给一个
 *   「关闭」出路，绝不能再给转圈假象。
 */
export function RightStageUnavailableShell({
  title,
  kind,
  className = 'react-chat-collab-exec-panel',
  bodyClassName = 'react-chat-collab-exec-panel-body',
  onClose,
}: {
  title: string
  kind?: string
  className?: string
  bodyClassName?: string
  onClose?: () => void
}) {
  const k = String(kind || '').trim()
  return (
    <aside className={className} role="region" aria-label={title}>
      <header className="react-chat-collab-exec-panel-header">
        <div className="react-chat-collab-exec-panel-title-wrap">
          <span className="react-chat-collab-exec-panel-title">{title}</span>
        </div>
      </header>
      <div className={bodyClassName}>
        <div className="react-chat-stage-unavailable">
          <p className="react-chat-stage-unavailable-title">这个面板不能在当前视图里打开</p>
          <p className="react-chat-stage-unavailable-desc">
            {k ? `「${k}」类型的面板只在对话右侧或主区提供。` : '当前嵌入视图不支持该面板类型。'}
          </p>
          {onClose ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-tauri-no-drag
              onClick={onClose}
            >
              关闭
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
