import { memo, useMemo } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Play } from 'lucide-react'
import NodeCardShell from './NodeCardShell.tsx'
import { RunVarsPanel } from './RunVarsPanel.tsx'
import { useWorkflowStudioOptional } from './WorkflowStudioContext.tsx'

function StartNode({ selected }: NodeProps) {
  const studio = useWorkflowStudioOptional()
  const vars = useMemo(() => {
    const list = Array.isArray(studio?.appParameters) ? studio.appParameters : []
    return list
      .map((p) => {
        const name = String(p?.name || '').trim()
        if (!name) return null
        return {
          name,
          label: String(p?.label || name).trim() || name,
          type: String(p?.type || 'text'),
          required: p?.required !== false,
        }
      })
      .filter(Boolean) as { name: string; label: string; type: string; required: boolean }[]
  }, [studio])

  const subtitle =
    vars.length > 0
      ? `触发运行 · ${vars.length} 个全局变量`
      : '触发运行 · 可在设置中添加变量'

  return (
    <NodeCardShell
      selected={selected}
      kind="start"
      typeLabel="开始"
      icon={<Play size={16} strokeWidth={2.2} />}
      title="流程开始"
      subtitle={subtitle}
      showInput={false}
      footer={<RunVarsPanel vars={vars} compact />}
    />
  )
}

export default memo(StartNode)
