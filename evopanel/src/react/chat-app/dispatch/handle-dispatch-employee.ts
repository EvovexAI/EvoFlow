/**
 * @员工名 dispatch → proactive employee + chat trail rows.
 * Extracted from ChatApp.tsx (P18).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { updateSessionRuntimeRows } from '../../lib/session-runtime-store.js'
import type { DisplayRow } from '../../chat-types.js'

export type DispatchEmployeeRole = {
  agent_code?: string
  role_name?: string
}

export type HandleDispatchEmployeeCtx = {
  proactiveRolesDisplay: DispatchEmployeeRole[]
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  rowsRef: MutableRefObject<DisplayRow[]>
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
}

export async function handleDispatchEmployee(
  ctx: HandleDispatchEmployeeCtx,
  agentCode: string,
  goal: string,
): Promise<void> {
  const { api } = await import('../../../lib/tauri-api.js')
  const role = ctx.proactiveRolesDisplay.find((r) => r.agent_code === agentCode)
  const name = role?.role_name || agentCode
  const watchHash = `#/proactive/${encodeURIComponent(agentCode)}?live=1&goal=${encodeURIComponent(goal.slice(0, 120))}`
  const goWatch = () => {
    try {
      window.location.hash = watchHash
    } catch {
      /* ignore */
    }
  }
  try {
    await api.proactiveDispatchTask(agentCode, { goal, source: 'chat_mention' })

    const sk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
    if (sk) {
      const now = Date.now()
      const next = updateSessionRuntimeRows(sk, (r: DisplayRow[]) => [
        ...r,
        {
          role: 'system' as const,
          text: `📋 已派发给「${name}」：${goal}`,
          timestamp: now,
        },
        {
          role: 'assistant' as const,
          text: `已派发给「${name}」，正在后台处理。\n\n已打开该员工工作页与工作轨迹，可直接查看进度与工作汇报。`,
          timestamp: now + 1,
        },
      ])
      if (next) {
        ctx.setRows([...next])
        ctx.rowsRef.current = next
      }
    }

    toast(`已派发给「${name}」，正在打开工作轨迹`, 'success')
    goWatch()
  } catch (e: unknown) {
    const msg = String((e as { message?: string })?.message || e || '')
    if (/already running|正在巡检|正在工作|busy|执行任务/i.test(msg)) {
      toast(msg || `「${name}」正在执行任务，已打开工作轨迹`, 'warning')
      const sk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
      if (sk) {
        const now = Date.now()
        const next = updateSessionRuntimeRows(sk, (r: DisplayRow[]) => [
          ...r,
          {
            role: 'system' as const,
            text: `⚠️ 「${name}」正忙，派发未受理：${goal}`,
            timestamp: now,
          },
          {
            role: 'assistant' as const,
            text: `「${name}」当前有任务在执行，无法同时接新派发。\n\n已打开其工作轨迹，请等本轮结束后再派发。`,
            timestamp: now + 1,
          },
        ])
        if (next) {
          ctx.setRows([...next])
          ctx.rowsRef.current = next
        }
      }
      goWatch()
    } else {
      toast(`派发失败：${msg}`, 'error')
    }
  }
}
