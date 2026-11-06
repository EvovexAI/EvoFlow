import { memo, useMemo } from 'react'
import { Bot, Braces } from 'lucide-react'
import { type NodeProps } from '@xyflow/react'
import NodeCardShell from './NodeCardShell.tsx'
import { isMissingStepTaskName, type StepNodeData } from '../../lib/app-workflow-plan.ts'
import { parseCsvField } from '../../lib/workflow-step-csv.ts'
import { useWorkflowStudioOptional } from './WorkflowStudioContext.tsx'

function StepNode({ id, data, selected }: NodeProps & { data: StepNodeData }) {
  const studio = useWorkflowStudioOptional()
  const isTemplate = data.executor === 'template'

  const toolNames = useMemo(() => parseCsvField(data.tools), [data.tools])
  const skillNames = useMemo(() => parseCsvField(data.skills), [data.skills])
  const mcpNames = useMemo(() => parseCsvField(data.mcp_servers), [data.mcp_servers])
  const capTotal = toolNames.length + skillNames.length + mcpNames.length

  const execStatus = data.ref ? studio?.execByRef?.[String(data.ref)] : undefined

  const missingName = isMissingStepTaskName(data.name)
  const taskName = data.name?.trim() || ''
  const goalPreview = (data.goal?.trim() || data.description?.trim() || '').split(/\r?\n/)[0] || ''
  const title = missingName ? (isTemplate ? '填写模板名称' : '填写任务名称') : taskName
  const titleMuted = missingName

  let subtitle: string
  if (isTemplate) {
    const tplPreview = (data.template || '').split(/\r?\n/)[0] || '点击填写模板内容'
    subtitle = goalPreview ? `模板 · ${goalPreview}` : `模板 · ${tplPreview}`
  } else {
    // 有工具时直接点名，避免「能力 N」看不出绑了啥
    const toolsHint =
      toolNames.length > 0
        ? `工具 ${toolNames.slice(0, 3).join('/')}${toolNames.length > 3 ? '…' : ''}`
        : ''
    if (goalPreview) {
      subtitle = toolsHint && selected ? `${goalPreview} · ${toolsHint}` : goalPreview
      if (!toolsHint && capTotal > 0 && selected) subtitle = `${subtitle} · 能力 ${capTotal}`
    } else if (toolsHint) {
      subtitle = toolsHint
    } else if (capTotal > 0) {
      subtitle = selected ? `通用智能体 · 能力 ${capTotal}` : `能力 ${capTotal}`
    } else {
      subtitle = '通用智能体'
    }
  }

  // 主标题 = 任务短名；副行 = 目标预览。不再在节点上选员工。
  return isTemplate ? (
    <NodeCardShell
      selected={selected}
      kind="tool"
      typeLabel="模板变换"
      icon={<Braces size={15} strokeWidth={2.2} />}
      title={title}
      titleMuted={titleMuted}
      subtitle={subtitle}
      onClose={studio?.deleteNode ? () => studio.deleteNode(id) : undefined}
      execStatus={execStatus}
    />
  ) : (
    <NodeCardShell
      selected={selected}
      kind="agent"
      typeLabel={capTotal > 0 ? `智能体 · 能力 ${capTotal}` : '智能体'}
      iconVariant="agent"
      icon={<Bot size={15} strokeWidth={2.2} />}
      title={title}
      titleMuted={titleMuted}
      subtitle={subtitle}
      onClose={studio?.deleteNode ? () => studio.deleteNode(id) : undefined}
      execStatus={execStatus}
    />
  )
}

export default memo(StepNode)
export type { StepNodeData }
