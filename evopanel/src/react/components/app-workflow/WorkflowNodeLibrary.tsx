import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { MessageSquareText, Play, Search, Trash2, Workflow } from 'lucide-react'
import WorkflowNodeAvatar from './WorkflowNodeAvatar.tsx'

type PaletteNode = {
  id: string
  title: string
  tone: 'trigger' | 'action' | 'system'
  icon: ReactNode
  static?: boolean
  onClick?: () => void
}

type Props = {
  onAddStep: () => void
  onAddAnswer?: () => void
  onDeleteSelected: () => void
  hasSelection: boolean
}

function PaletteRow({
  title,
  tone,
  icon,
  static: isStatic,
  onClick,
  draggable,
  onDragStart,
}: Omit<PaletteNode, 'id'> & {
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
}) {
  const Tag = isStatic ? 'div' : 'button'
  return (
    <Tag
      type={isStatic ? undefined : 'button'}
      className={`wf-palette-row${isStatic ? ' wf-palette-row--static' : ''}`}
      onClick={onClick}
      title={title}
      draggable={!!draggable}
      onDragStart={onDragStart}
    >
      <WorkflowNodeAvatar tone={tone} size="sm">
        {icon}
      </WorkflowNodeAvatar>
      <span className="wf-palette-row-title">{title}</span>
    </Tag>
  )
}

export function WorkflowNodeLibrary({
  onAddStep,
  onAddAnswer,
  onDeleteSelected,
  hasSelection,
}: Props) {
  const [search, setSearch] = useState('')
  const dndType = 'application/evoflow-wf-node'

  const nodes = useMemo<PaletteNode[]>(
    () => [
      {
        id: 'start',
        title: '流程开始',
        tone: 'trigger',
        icon: <Play size={15} strokeWidth={2.2} />,
        static: true,
      },
      {
        id: 'answer',
        title: '最终答案',
        tone: 'trigger',
        icon: <MessageSquareText size={15} strokeWidth={2.2} />,
        onClick: onAddAnswer,
      },
      {
        id: 'agent-step',
        title: '智能体步骤',
        tone: 'action',
        icon: <Workflow size={15} strokeWidth={2.2} />,
        onClick: onAddStep,
      },
    ],
    [onAddStep, onAddAnswer],
  )

  const q = search.trim().toLowerCase()
  const systemNodes = nodes.filter((n) => n.tone === 'trigger' && (!q || n.title.toLowerCase().includes(q)))
  const agentNodes = nodes.filter((n) => n.tone === 'action' && (!q || n.title.toLowerCase().includes(q)))

  return (
    <aside className="app-wf-sidebar app-wf-sidebar--left">
      <div className="app-wf-sidebar-head app-wf-sidebar-head--stack">
        <h3>选择节点</h3>
        <p className="app-wf-sidebar-desc">点击或拖拽到画布</p>
      </div>

      <div className="wf-palette-search-wrap">
        <Search size={15} className="wf-palette-search-icon" aria-hidden />
        <input
          type="search"
          className="wf-palette-search"
          placeholder="搜索节点"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="app-wf-node-palette">
        {systemNodes.length > 0 ? (
          <section className="wf-palette-group">
            <h4 className="wf-palette-group-title">系统节点</h4>
            <div className="wf-palette-grid wf-palette-grid--1">
              {systemNodes.map((node) => (
                <PaletteRow
                  key={node.id}
                  {...node}
                  draggable={node.id === 'answer'}
                  onDragStart={
                    node.id === 'answer'
                      ? (e) => {
                          e.dataTransfer.setData(dndType, 'answer')
                          e.dataTransfer.effectAllowed = 'copy'
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        ) : null}

        {agentNodes.length > 0 ? (
          <section className="wf-palette-group">
            <h4 className="wf-palette-group-title">Agent</h4>
            <div className="wf-palette-grid">
              {agentNodes.map((node) => (
                <PaletteRow
                  key={node.id}
                  {...node}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(dndType, 'agent-step')
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {systemNodes.length === 0 && agentNodes.length === 0 ? (
          <div className="wf-palette-empty">没有匹配的节点</div>
        ) : null}
      </div>

      <div className="app-wf-sidebar-foot">
        <button
          type="button"
          className="wf-palette-delete"
          disabled={!hasSelection}
          onClick={onDeleteSelected}
        >
          <Trash2 size={14} />
          删除选中
        </button>
      </div>
    </aside>
  )
}
