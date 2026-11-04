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
  rememberDeptChatMeta,
  subscribeDeptChatMeta,
  type DeptChatMeta,
} from '../lib/dept-chat-session.js'
import { api } from '../../lib/tauri-api.js'

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
    head_agent_code: meta.head_agent_code || '',
    head_role_name: meta.head_role_name || '',
    members,
    busyCount: members.filter((m) => m.busy).length,
    accent: meta.accent || 'lead',
  }
}

async function loadDeptMeta(deptId: string): Promise<DeptChatMeta | null> {
  const cached = getDeptChatMeta(deptId)
  if (cached?.members?.length) return cached
  try {
    const [deptRes, roleRes] = await Promise.all([
      api.proactiveListDepartments(),
      api.proactiveListRoles('active'),
    ])
    const departments = Array.isArray(deptRes?.departments)
      ? deptRes.departments
      : Array.isArray(deptRes)
        ? deptRes
        : []
    const roles = Array.isArray(roleRes?.roles)
      ? roleRes.roles
      : Array.isArray(roleRes)
        ? roleRes
        : []
    const d = departments.find((x: any) => String(x?.id || '').trim() === deptId)
    if (!d) return cached
    const name = String(d.name || '').trim()
    const members = roles
      .filter((r: any) => {
        const code = String(r?.agent_code || r?.code || '').trim()
        if (!code || code === 'main') return false
        return String(r?.department || r?.config?.department || '').trim() === name
      })
      .map((r: any) => ({
        agent_code: String(r.agent_code || r.code || '').trim(),
        role_name: String(r.role_name || r.display_name || r.agent_code || '').trim(),
        department: name,
        reports_to: String(r.reports_to || r?.config?.reports_to || '').trim(),
        status: String(r.status || 'active').trim() || 'active',
        busy: false,
      }))
    const meta: DeptChatMeta = {
      id: deptId,
      name,
      head_agent_code: String(d.head_agent_code || '').trim(),
      head_role_name: String(d.head_role_name || '').trim(),
      accent: cached?.accent || 'lead',
      members,
    }
    rememberDeptChatMeta(meta)
    return meta
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
          window.location.hash = `#/proactive/${encodeURIComponent(code)}`
        }}
      />
    </div>
  )
}
