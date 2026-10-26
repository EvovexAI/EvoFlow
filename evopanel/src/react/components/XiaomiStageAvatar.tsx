/**
 * 右栏 tab / 启动项用的小V 头像：从 agents 缓存或 API 取真实 avatar，避免只显示字母。
 */
import { useEffect, useState } from 'react'
import { getAgentsDisplayCache } from '../../lib/agents-display-cache.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import AgentAvatar from './AgentAvatar.js'

function pickXiaomiFromList(list: unknown[] | null | undefined): AgentAvatarAgent | null {
  const row = (Array.isArray(list) ? list : []).find((a) => {
    const code = String((a as AgentAvatarAgent)?.agent_code || '').trim().toLowerCase()
    return code === 'xiaomi'
  }) as AgentAvatarAgent | undefined
  return row || null
}

function fallbackXiaomiAgent(): AgentAvatarAgent {
  // 内置 cutout 默认有文件；API 失败时仍尝试 /avatar，onError 再回落到字母。
  return {
    agent_code: 'xiaomi',
    agent_name: '小V',
    avatar: 'image',
    has_avatar_file: true,
  }
}

export function XiaomiStageAvatar({ size = 14, className = '' }: { size?: number; className?: string }) {
  const [agent, setAgent] = useState<AgentAvatarAgent>(
    () => pickXiaomiFromList(getAgentsDisplayCache()) || fallbackXiaomiAgent(),
  )

  useEffect(() => {
    let cancelled = false
    const cached = pickXiaomiFromList(getAgentsDisplayCache())
    if (cached?.avatar || cached?.has_avatar_file) {
      setAgent(cached)
      return () => {
        cancelled = true
      }
    }
    void import('../../lib/tauri-api.js')
      .then(async ({ api }) => {
        const agents = await api.listAgents()
        if (cancelled) return
        const row = pickXiaomiFromList(agents)
        if (row) setAgent(row)
      })
      .catch(() => {
        /* keep fallback */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return <AgentAvatar agent={agent} agentCode="xiaomi" size={size} title="小V" className={className} />
}

export default XiaomiStageAvatar
