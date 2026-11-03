import { memo } from 'react'
import { type NodeProps } from '@xyflow/react'
import { MessageSquareText } from 'lucide-react'
import NodeCardShell from './NodeCardShell.tsx'

export type AnswerNodeData = {
  sourceRef?: string
}

function AnswerNode({ selected, data }: NodeProps & { data?: AnswerNodeData }) {
  const sourceRef = String((data as AnswerNodeData | undefined)?.sourceRef || '').trim()
  return (
    <NodeCardShell
      selected={selected}
      kind="answer"
      typeLabel="输出"
      icon={<MessageSquareText size={14} strokeWidth={2.2} />}
      title="最终答案"
      subtitle={
        sourceRef
          ? `输出取自步骤 ${sourceRef}`
          : '并行结果先用任务步骤汇总，再连到这里；或直接指定某一步'
      }
      showInput
      showOutput={false}
    />
  )
}

export default memo(AnswerNode)
