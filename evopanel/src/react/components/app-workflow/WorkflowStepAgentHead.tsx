import { Bot } from 'lucide-react'
import AssignedAgentAvatar from '../AssignedAgentAvatar.tsx'
import type { AgentPickerRow } from '../../lib/agent-tags.ts'

export function resolveWorkflowAgent(agents: AgentPickerRow[], agentCode?: string | null) {
  const code = String(agentCode || '').trim()
  if (!code) {
    return { agent: null, label: '选择智能体', hasAgent: false }
  }
  const row = agents.find((a) => String(a.agent_code || '').trim() === code)
  return {
    agent: row ?? { agent_code: code },
    label: String(row?.agent_name || code),
    hasAgent: true,
  }
}

type Props = {
  agentCode?: string | null
  agents: AgentPickerRow[]
  size?: number
  showLabel?: boolean
  labelClassName?: string
  className?: string
}

export function WorkflowStepAgentHead({
  agentCode,
  agents,
  size = 24,
  showLabel = true,
  labelClassName = '',
  className = '',
}: Props) {
  const { label, hasAgent } = resolveWorkflowAgent(agents, agentCode)

  return (
    <div className={`wf-step-agent-head${className ? ` ${className}` : ''}`}>
      {hasAgent ? (
        <AssignedAgentAvatar agentCode={agentCode} agents={agents} size={size} />
      ) : (
        <span className="wf-step-agent-placeholder" style={{ width: size, height: size }}>
          <Bot size={Math.max(12, Math.floor(size * 0.52))} strokeWidth={2.2} />
        </span>
      )}
      {showLabel ? (
        <span
          className={`wf-step-agent-label${hasAgent ? '' : ' is-placeholder'}${labelClassName ? ` ${labelClassName}` : ''}`}
          title={label}
        >
          {label}
        </span>
      ) : null}
    </div>
  )
}
