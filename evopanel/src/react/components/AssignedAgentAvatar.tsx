import { useMemo } from 'react'
import AgentAvatar from './AgentAvatar'
import type { AgentAvatarAgent } from '../lib/agent-avatar'

type AssignedAgentAvatarProps = {
  agentCode?: string | null
  agents?: unknown[] | null
  size?: number
  busy?: boolean
  className?: string
}

/** Resolve `assignedAgent` (agent_code) against `/api/agents` list and render avatar. */
export function AssignedAgentAvatar({
  agentCode,
  agents,
  size = 18,
  busy,
  className,
}: AssignedAgentAvatarProps) {
  const agent = useMemo((): AgentAvatarAgent => {
    const code = String(agentCode || '').trim().toLowerCase()
    const list = Array.isArray(agents) ? agents : []
    const row = list.find((a) => {
      const r = a as AgentAvatarAgent
      return String(r?.agent_code || '').trim().toLowerCase() === code
    }) as AgentAvatarAgent | undefined
    return row ?? { agent_code: code || undefined }
  }, [agentCode, agents])

  return (
    <AgentAvatar
      agent={agent}
      agentCode={agentCode}
      size={size}
      busy={busy}
      className={className}
    />
  )
}

export default AssignedAgentAvatar
