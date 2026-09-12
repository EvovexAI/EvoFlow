type Props = {
  stepCount: number
  edgeCount: number
  dirty?: boolean
  selectedLabel?: string | null
}

/** 底栏：节点/连线计数 + 保存状态（无常驻教学文案） */
export function WorkflowStatusBar({ stepCount, edgeCount, dirty }: Props) {
  const nodeTotal = Math.max(0, stepCount)
  return (
    <div className="wf-status-bar" role="status" aria-live="polite">
      <div className="wf-status-bar-left">
        <span className="wf-status-summary">
          {nodeTotal} 个节点 · {edgeCount} 条连接
        </span>
      </div>
      <div className="wf-status-bar-right">
        {dirty ? (
          <span className="wf-status-dirty">有未保存更改</span>
        ) : (
          <span className="wf-status-saved">已保存</span>
        )}
      </div>
    </div>
  )
}
