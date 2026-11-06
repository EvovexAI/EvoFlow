import { memo, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react'
import { X } from 'lucide-react'
import { START_NODE_ID } from '../../lib/app-workflow-flow.ts'
import { useWorkflowStudioOptional } from './WorkflowStudioContext.tsx'

const EDGE_IDLE = '#B8BDCA'
const EDGE_ACTIVE = '#5B5FEF'

/** 带中点操作的折线：选中后可拖两端改接；双击选下游节点；× 删线 */
function DeletableSmoothStepEdge({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const studio = useWorkflowStudioOptional()
  const [hovered, setHovered] = useState(false)
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  })
  const canDelete = source !== START_NODE_ID
  const active = !!(selected || hovered)
  const showChrome = active
  const stroke = active ? EDGE_ACTIVE : EDGE_IDLE
  const strokeWidth = active ? 2.25 : 2
  const mergedStyle = {
    ...style,
    stroke,
    strokeWidth,
  }
  // React Flow 会把 defaultEdgeOptions.markerEnd 解析成 url(#…) 字符串
  const resolvedMarker = typeof markerEnd === 'string' ? markerEnd : undefined

  return (
    <>
      <BaseEdge id={id} path={path} style={mergedStyle} markerEnd={resolvedMarker} />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={28}
        className="react-flow__edge-interaction"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {showChrome ? (
        <EdgeLabelRenderer>
          <div
            className={`wf-edge-chrome nodrag nopan${selected ? ' is-selected' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            {selected ? (
              <span className="wf-edge-hint" title="拖线两端圆点改接到其他节点；双击选中下游节点以便拖走">
                拖两端改接 · 双击选节点
              </span>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                className="wf-edge-close is-visible"
                title="删除连线"
                aria-label="删除连线"
                onClick={(e) => {
                  e.stopPropagation()
                  studio?.deleteEdge?.(id)
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export default memo(DeletableSmoothStepEdge)
