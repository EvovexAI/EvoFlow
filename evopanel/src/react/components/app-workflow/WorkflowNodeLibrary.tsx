import { useMemo, type DragEvent, type ReactNode } from 'react'
import { Bot, MessageSquareText, Trash2 } from 'lucide-react'
import WorkflowNodeAvatar from './WorkflowNodeAvatar.tsx'

type PaletteNode = {
  id: string
  title: string
  tone: 'trigger' | 'action' | 'system'
  icon: ReactNode
  onClick?: () => void
  dragKind: string
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
  onClick,
  onDragStart,
}: Omit<PaletteNode, 'id' | 'dragKind'> & {
  onDragStart?: (e: DragEvent) => void
}) {
  return (
    <button
      type="button"
      className="wf-palette-row"
      onClick={onClick}
      title={title}
      draggable
      onDragStart={onDragStart}
    >
      <WorkflowNodeAvatar tone={tone} size="sm">
        {icon}
      </WorkflowNodeAvatar>
      <span className="wf-palette-row-title">{title}</span>
    </button>
  )
}

/** 遗留侧栏调色板；主路径已改用 WorkflowDrawer 节点库 */
export function WorkflowNodeLibrary({
  onAddStep,
  onAddAnswer,
  onDeleteSelected,
  hasSelection,
}: Props) {
  const dndType = 'application/evoflow-wf-node'

  const nodes = useMemo<PaletteNode[]>(
    () => [
      {
        id: 'agent-step',
        title: 'Agent 节点',
        tone: 'action',
        icon: <Bot size={14} strokeWidth={2.2} />,
        onClick: onAddStep,
        dragKind: 'agent-step',
      },
      {
        id: 'answer',
        title: '最终答案',
        tone: 'trigger',
        icon: <MessageSquareText size={14} strokeWidth={2.2} />,
        onClick: onAddAnswer,
        dragKind: 'answer',
      },
    ],
    [onAddStep, onAddAnswer],
  )

  return (
    <aside className="app-wf-sidebar app-wf-sidebar--left">
      <div className="app-wf-sidebar-head app-wf-sidebar-head--stack">
        <h3>添加节点</h3>
        <p className="app-wf-sidebar-desc">拖到画布 · 执行者在节点上选</p>
      </div>

      <div className="app-wf-node-palette">
        <section className="wf-palette-group">
          <div className="wf-palette-grid wf-palette-grid--1">
            {nodes.map((node) => (
              <PaletteRow
                key={node.id}
                {...node}
                onDragStart={(e) => {
                  e.dataTransfer.setData(dndType, node.dragKind)
                  e.dataTransfer.setData('text/plain', `evoflow-wf:${node.dragKind}`)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              />
            ))}
          </div>
        </section>
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
