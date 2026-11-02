import { memo, useMemo } from 'react'
import { type NodeProps } from '@xyflow/react'
import NodeCardShell from './NodeCardShell.tsx'
import { WorkflowStepAgentHead, resolveWorkflowAgent } from './WorkflowStepAgentHead.tsx'
import { isMissingStepTaskName, type StepNodeData } from '../../lib/app-workflow-plan.ts'
import { parseCsvField } from '../../lib/workflow-step-csv.ts'
import { useWorkflowStudioOptional } from './WorkflowStudioContext.tsx'

function StepNode({ id, data, selected }: NodeProps & { data: StepNodeData }) {
  const studio = useWorkflowStudioOptional()
  const agents = studio?.agents ?? []
  const { label: agentLabel, hasAgent } = resolveWorkflowAgent(agents, data.assigned_agent)

  const stepOverrideTotal = useMemo(() => {
    return (
      parseCsvField(data.skills).length +
      parseCsvField(data.tools).length +
      parseCsvField(data.mcp_servers).length
    )
  }, [data.skills, data.tools, data.mcp_servers])

  const openAgentPicker = studio?.openAgentPicker
    ? () => studio.openAgentPicker?.(id)
    : undefined
  const execStatus = data.ref ? studio?.execByRef?.[String(data.ref)] : undefined

  const missingName = isMissingStepTaskName(data.name)
  const taskName = data.name?.trim() || ''
  const goalPreview = (data.goal?.trim() || data.description?.trim() || '').split(/\r?\n/)[0] || ''
  const title = missingName ? '填写任务名称' : taskName
  const titleMuted = missingName

  let subtitle = hasAgent ? agentLabel : '点击头像选择执行者'
  if (hasAgent && goalPreview) {
    subtitle = `${agentLabel} · ${goalPreview}`
  }
  if (hasAgent && stepOverrideTotal > 0 && selected) {
    subtitle = `${subtitle} · 另挂 ${stepOverrideTotal}`
  }

  // 主标题 = 任务短名；执行者 / 说明缩在副行。技能工具仍在右侧面板。
  return (
    <NodeCardShell
      selected={selected}
      kind="agent"
      typeLabel={stepOverrideTotal > 0 ? `智能体 · 另挂 ${stepOverrideTotal}` : '智能体'}
      iconVariant="agent"
      icon={
        <WorkflowStepAgentHead
          agentCode={data.assigned_agent}
          agents={agents}
          size={24}
          showLabel={false}
        />
      }
      title={title}
      titleMuted={titleMuted}
      subtitle={subtitle}
      onClose={studio?.deleteNode ? () => studio.deleteNode(id) : undefined}
      onAgentPick={execStatus ? undefined : openAgentPicker}
      agentPickMode="avatar"
      execStatus={execStatus}
    />
  )
}

export default memo(StepNode)
export type { StepNodeData }
