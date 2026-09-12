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
      icon={<MessageSquareText size={16} strokeWidth={2.2} />}
      title="最终答案"
      subtitle={
        sourceRef
          ? `用户看到的结果来自步骤 ${sourceRef}`
          : '把某一步连到这里 → 该步结果就是最终给用户看的答案'
      }
      showInput
      showOutput={false}
    />
  )
}

export default memo(AnswerNode)
