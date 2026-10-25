/**
 * 【DISABLED · 勿改 · 勿 import】
 *
 * 旧员工「执行过程」对话面板（SubtaskExecutionDrawer + messagesToSubtaskModalRows 行列表）。
 * 已整体停用：任何员工过程 UI 请走
 *   V4EmployeeProcessPane → V4SessionPaneBridge → V4ZCodeTimeline
 *
 * 本文件仅作考古备份，**没有任何地方 import**。改对话观感不要动这里。
 * 现行入口：`ProactiveLiveProcessHost.tsx`（已改成薄封装转 V4）。
 *
 * --- 以下为停用前实现快照（2026-10）---
 */

/*
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { messagesToSubtaskModalRows } from '../../lib/subtask-modal-rows.js'
import { fetchProactiveTranscript } from '../../lib/proactive-session-messages.js'
import { SubtaskExecutionDrawer } from './SubtaskExecutionDrawer.js'

export type ProactiveLiveProcessHostProps = {
  open: boolean
  agentCode: string
  roleName?: string
  busy?: boolean
  title?: string
  roundId?: string
  taskId?: string
  pollMs?: number
  mode?: 'modal' | 'drawer' | 'panel'
  portalTarget?: HTMLElement | null
  onClose: () => void
}

function rowsToPlainText(rows: any[]): string {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const role = String(r?.role || '').trim()
      const text = String(r?.text || r?.reasoningPreview || '').trim()
      const tools = Array.isArray(r?.tools) ? r.tools : []
      const toolLine = tools
        .map((t: any) => {
          const name = String(t?.name || t?.tool || '工具').trim()
          const out = String(t?.output || t?.result || '').trim()
          return out ? `[工具 ${name}]\n${out}` : `[工具 ${name}]`
        })
        .join('\\n')
      const parts = [role ? `[${role}]` : '', text, toolLine].filter(Boolean)
      return parts.join('\\n')
    })
    .filter(Boolean)
    .join('\\n\\n')
}

export function ProactiveLiveProcessHostLegacy(/* props *\/) {
  // 旧路径：fetchProactiveTranscript → messagesToSubtaskModalRows → SubtaskExecutionDrawer(rows=…)
  // 已废弃。见 V4EmployeeProcessPane。
  return null
}
*/

export {}
