/**
 * 右栏员工过程页签 / 顶栏：按 agentCode 取真实头像（agents 缓存 → listAgents → 字母兜底）。
 */
import { useEffect, useState } from 'react'
import { getAgentsDisplayCache } from '../../lib/agents-display-cache.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import AgentAvatar from './AgentAvatar.js'

function pickAgentFromList(
  list: unknown[] | null | undefined,
  agentCode: string,
): AgentAvatarAgent | null {
  const want = String(agentCode || '')
    .trim()
    .toLowerCase()
  if (!want) return null
  const row = (Array.isArray(list) ? list : []).find((a) => {
    const code = String((a as AgentAvatarAgent)?.agent_code || '')
      .trim()
      .toLowerCase()
    return code === want
  }) as AgentAvatarAgent | undefined
  return row || null
}

export function EmployeeStageAvatar({
  agentCode,
  title,
  size = 14,
  busy = false,
  className = '',
}: {
  agentCode: string
  title?: string
  size?: number
  busy?: boolean
  className?: string
}) {
  const code = String(agentCode || '').trim()
  const [agent, setAgent] = useState<AgentAvatarAgent>(() => {
    const cached = pickAgentFromList(getAgentsDisplayCache(), code)
    return (
      cached || {
        agent_code: code || undefined,
        agent_name: String(title || '').trim() || code || undefined,
      }
    )
  })

  useEffect(() => {
    let cancelled = false
    const niceName = () => String(title || '').trim() || undefined
    const cached = pickAgentFromList(getAgentsDisplayCache(), code)
    if (cached) {
      setAgent({
        ...cached,
        agent_name: niceName() || cached.agent_name || code || undefined,
      })
      if (cached.avatar || cached.has_avatar_file) {
        return () => {
          cancelled = true
        }
      }
    }
    void import('../../lib/tauri-api.js')
      .then(async ({ api }) => {
        let row = pickAgentFromList(await api.listAgents?.(), code)
        if (!row && typeof api.getAgent === 'function') {
          try {
            const one = await api.getAgent(code)
            if (one && typeof one === 'object') {
              row = (one as { agent?: AgentAvatarAgent }).agent || (one as AgentAvatarAgent)
            }
          } catch {
            /* optional */
          }
        }
        if (cancelled) return
        if (row && (row.agent_code || row.agent_name || row.avatar || row.has_avatar_file)) {
          setAgent({
            ...row,
            agent_code: String(row.agent_code || code).trim() || code,
            agent_name: niceName() || row.agent_name || code || undefined,
          })
          return
        }
        // 员工岗可能不在 /api/agents；仍用 code 画字母头，title 用岗位名
        setAgent({
          agent_code: code || undefined,
          agent_name: niceName() || code || undefined,
        })
      })
      .catch(() => {
        if (cancelled) return
        setAgent({
          agent_code: code || undefined,
          agent_name: niceName() || code || undefined,
        })
      })
    return () => {
      cancelled = true
    }
  }, [code, title])

  if (!code) return null
  return (
    <AgentAvatar
      agent={agent}
      agentCode={code}
      size={size}
      busy={busy}
      title={String(title || agent.agent_name || code)}
      className={className}
    />
  )
}

export default EmployeeStageAvatar
