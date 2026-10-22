/**
 * Active proactive employee roles for @mention / composer / sidebar.
 * Extracted from ChatApp.tsx (P10).
 */
import { useCallback, useEffect, useState } from 'react'
import type { MentionEmployeeOption } from '../components/ChatComposer.js'

export function useProactiveRoles() {
  const [proactiveRoles, setProactiveRoles] = useState<MentionEmployeeOption[]>([])

  const loadProactiveRoles = useCallback(async () => {
    try {
      const { api, isGatewayWarming, waitForBackendReady } = await import('../../lib/tauri-api.js')
      if (typeof isGatewayWarming === 'function' && isGatewayWarming()) {
        await waitForBackendReady?.(90_000).catch(() => {})
      }
      const res = await api.proactiveListRoles('active')
      // 兼容 { roles: [] } 与偶发裸数组
      const raw = Array.isArray(res)
        ? res
        : Array.isArray(res?.roles)
          ? res.roles
          : []
      const roles = raw
        .map((r: any) => ({
          agent_code: String(r.agent_code || '').trim(),
          // 岗位名保持 API 原样（库里已有「代码助手」「产品经理」等）
          role_name: String(r.role_name || '').trim(),
          agent_name: String(r.agent_name || '').trim(),
          department: String(r.department || ''),
          status: String(r.status || 'active'),
        }))
        .filter((r: MentionEmployeeOption) => r.agent_code)
      setProactiveRoles(roles)
    } catch {
      /* proactive 未启用 / 网关未就绪时静默；后端就绪后再拉 */
    }
  }, [])

  useEffect(() => {
    void loadProactiveRoles()
  }, [loadProactiveRoles])

  // platform employees.hire/create 等写操作 → employees-updated（见 employees-roster-sync）
  useEffect(() => {
    const onEmployeesUpdated = () => {
      void loadProactiveRoles()
    }
    window.addEventListener('evopanel:employees-updated', onEmployeesUpdated)
    return () => window.removeEventListener('evopanel:employees-updated', onEmployeesUpdated)
  }, [loadProactiveRoles])

  // 启动时若第一次失败，后端就绪后补拉，避免侧栏员工下拉塌成英文 agent_code
  // (展示名解析统一走 evopanel/src/react/lib/employee-display.ts)
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | undefined
    void import('../../lib/tauri-api.js').then((mod) => {
      if (cancelled) return
      if (typeof mod.onBackendReadyChange === 'function') {
        unsub = mod.onBackendReadyChange((ready: boolean) => {
          if (ready) void loadProactiveRoles()
        })
      }
      try {
        if (mod.isBackendReady?.() === true) void loadProactiveRoles()
      } catch {
        /* ignore */
      }
    })
    return () => {
      cancelled = true
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [loadProactiveRoles])

  return { proactiveRoles, setProactiveRoles, loadProactiveRoles }
}
