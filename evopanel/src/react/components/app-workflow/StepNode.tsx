import { memo, useMemo } from 'react'
import { type NodeProps } from '@xyflow/react'
import NodeCardShell from './NodeCardShell.tsx'
import { WorkflowStepAgentHead, resolveWorkflowAgent } from './WorkflowStepAgentHead.tsx'
import type { StepNodeData } from '../../lib/app-workflow-plan.ts'
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

  const goalText = data.goal?.trim() || data.description?.trim() || ''
  let subtitle = !hasAgent
    ? '点击选择智能体'
    : goalText || (selected ? '在右侧面板写本步要做什么' : '待写步骤说明')
  if (hasAgent && stepOverrideTotal > 0 && selected) {
    subtitle = `${subtitle} · 另挂 ${stepOverrideTotal}`
  }

  // 画布节点只保留「谁 + 做什么」摘要；技能/工具统一在右侧配置面板展示
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
      title={agentLabel}
      titleMuted={!hasAgent}
      subtitle={subtitle}
      onClose={studio?.deleteNode ? () => studio.deleteNode(id) : undefined}
      onAgentPick={execStatus ? undefined : openAgentPicker}
      agentPickMode={hasAgent ? 'avatar' : 'row'}
      execStatus={execStatus}
    />
  )
}

export default memo(StepNode)
export type { StepNodeData }
