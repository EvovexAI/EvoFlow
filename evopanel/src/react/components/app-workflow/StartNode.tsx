import { memo, useMemo } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Play } from 'lucide-react'
import NodeCardShell from './NodeCardShell.tsx'
import { RunVarsPanel } from './RunVarsPanel.tsx'
import { useWorkflowStudioOptional } from './WorkflowStudioContext.tsx'

/** 画布入口锚点：非可添加节点；仅展示触发与全局变量，体量刻意压小 */
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
    vars.length > 0 ? `${vars.length} 个入参` : '入参在设置里加'

  return (
    <NodeCardShell
      selected={selected}
      kind="start"
      typeLabel="触发"
      icon={<Play size={14} strokeWidth={2.2} />}
      title="入口"
      subtitle={subtitle}
      showInput={false}
      footer={vars.length > 0 ? <RunVarsPanel vars={vars} compact /> : undefined}
    />
  )
}

export default memo(StartNode)
