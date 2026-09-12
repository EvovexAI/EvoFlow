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

/** 带中点删除按钮的折线连线（开始节点引出的边不显示 ×，避免删了又被自动补回） */
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
  const showClose = canDelete && (selected || hovered)
  const active = !!(selected || hovered)
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
      {canDelete ? (
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={24}
          className="react-flow__edge-interaction"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        />
      ) : null}
      {canDelete ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={`wf-edge-close nodrag nopan${showClose ? ' is-visible' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
            title="删除连线"
            aria-label="删除连线"
            onClick={(e) => {
              e.stopPropagation()
              studio?.deleteEdge?.(id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export default memo(DeletableSmoothStepEdge)
