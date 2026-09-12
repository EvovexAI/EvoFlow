import { memo, type ReactNode } from 'react'

export type NodeAvatarTone = 'trigger' | 'action' | 'system'

type Props = {
  tone?: NodeAvatarTone
  children: ReactNode
  size?: 'sm' | 'md'
}

function WorkflowNodeAvatar({ tone = 'action', children, size = 'md' }: Props) {
  return (
    <span className={`wf-node-avatar wf-node-avatar--${tone} wf-node-avatar--${size}`}>{children}</span>
  )
}

export default memo(WorkflowNodeAvatar)
