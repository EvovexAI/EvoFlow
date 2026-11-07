import { workspaceDisplayName } from '../../lib/app-workflow-plan.ts'

type Props = {
  stepCount: number
  edgeCount: number
  dirty?: boolean
  selectedLabel?: string | null
  /** 工作流默认工作空间完整路径 */
  workspacePath?: string
}

/** 底栏：节点/连线计数 + 工作空间 + 保存状态 */
export function WorkflowStatusBar({ stepCount, edgeCount, dirty, workspacePath }: Props) {
  const nodeTotal = Math.max(0, stepCount)
  const ws = String(workspacePath || '').trim()
  const wsName = workspaceDisplayName(ws)
  return (
    <div className="wf-status-bar" role="status" aria-live="polite">
      <div className="wf-status-bar-left">
        <span className="wf-status-summary">
          {nodeTotal} 个节点 · {edgeCount} 条连接
        </span>
        {ws ? (
          <span className="wf-status-workspace" title={ws}>
            工作空间 · {wsName}
          </span>
        ) : null}
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
