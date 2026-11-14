/**
 * V4 主对话区 · 部门群聊宿主。
 * 由侧栏「部门」点选 ``dept:{id}:chat`` 后挂载；复用 HomeDeptGroupChat。
 */
import { useEffect, useMemo, useState } from 'react'
import { HomeDeptGroupChat } from './HomeDeptGroupChat.js'
import type { HomeCmdDept, HomeCmdPerson } from './HomeOrgCommandBoard.js'
import {
  deptIdFromSessionKey,
  getDeptChatMeta,
  loadDeptChatList,
  rememberDeptChatMeta,
  subscribeDeptChatMeta,
  type DeptChatMeta,
} from '../lib/dept-chat-session.js'
import { openShellPageInRightStage } from '../../lib/right-stage/open-shell-page-stage.js'

function metaToDept(meta: DeptChatMeta): HomeCmdDept {
  const members: HomeCmdPerson[] = (meta.members || []).map((m) => ({
    agent_code: m.agent_code,
    role_name: m.role_name,
    department: m.department || meta.name,
    reports_to: m.reports_to || '',
    status: m.status || 'active',
    busy: !!m.busy,
    summary: '',
  }))
  return {
    id: meta.id,
    name: meta.name,
    avatar: meta.avatar || '',
    head_agent_code: meta.head_agent_code || '',
    head_role_name: meta.head_role_name || '',
    members,
    busyCount: members.filter((m) => m.busy).length,
    accent: meta.accent || 'lead',
  }
}

async function loadDeptMeta(deptId: string): Promise<DeptChatMeta | null> {
  const cached = getDeptChatMeta(deptId)
  // 头像可能是后加的：缓存里没头像也回去拉一次，别把老 meta 永久钉住
  if (cached?.members?.length && cached.avatar) return cached
  try {
    const rows = await loadDeptChatList({ force: !cached?.members?.length })
    const hit = rows.find((d) => d.id === deptId)
    if (hit) {
      rememberDeptChatMeta(hit)
      return hit
    }
    return cached
  } catch {
    return cached
  }
}

export type DeptGroupChatMainProps = {
  sessionKey: string
  onClose?: () => void
}

export function DeptGroupChatMain({ sessionKey, onClose }: DeptGroupChatMainProps) {
  const deptId = deptIdFromSessionKey(sessionKey)
  const [meta, setMeta] = useState<DeptChatMeta | null>(() =>
    deptId ? getDeptChatMeta(deptId) : null,
  )
  const [loading, setLoading] = useState(!meta?.members?.length)

  useEffect(() => {
    return subscribeDeptChatMeta(() => {
      if (!deptId) return
      const next = getDeptChatMeta(deptId)
      if (next) setMeta(next)
    })
  }, [deptId])

  useEffect(() => {
    if (!deptId) {
      setMeta(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void loadDeptMeta(deptId).then((m) => {
      if (cancelled) return
      setMeta(m)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [deptId])

  const dept = useMemo(() => (meta ? metaToDept(meta) : null), [meta])

  if (!deptId) {
    return <div className="dept-chat-main__empty">无效的部门会话</div>
  }
  if (loading && !dept) {
    return <div className="dept-chat-main__empty">加载部门群聊…</div>
  }
  if (!dept) {
    return <div className="dept-chat-main__empty">找不到该部门或尚无成员</div>
  }

  return (
    <div className="dept-chat-main">
      <HomeDeptGroupChat
        dept={dept}
        variant="main"
        shellSessionKey={sessionKey}
        onClose={() => onClose?.()}
        onOpenEmployeePage={(code) => {
          const agentCode = String(code || '').trim()
          if (!agentCode) return
          const member = dept.members.find((m) => m.agent_code === agentCode)
          const name = String(member?.role_name || '').trim() || agentCode
          openShellPageInRightStage(
            {
              path: `/proactive/${encodeURIComponent(agentCode)}`,
              mountId: 'employees.detail',
              title: name,
              entityLabel: name,
              agentCode,
              layout: 'wide',
            },
            { sessionKey, layout: 'wide', forceExpand: true },
          )
        }}
      />
    </div>
  )
}
