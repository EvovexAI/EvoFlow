import { describe, expect, it, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import {
  ToolApprovalPanel,
  TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS,
} from '../src/react/components/ToolApprovalPanel.tsx'
import * as toolApprovalSettings from '../src/lib/tool-approval-settings.js'

afterEach(() => cleanup())

describe('ToolApprovalPanel 决策态（多工具审批点击回执）', () => {
  it('默认渲染四个选项 + 新对话默认勾选 + 确认按钮；点击确认回调所选 choice', () => {
    const seen: string[] = []
    render(<ToolApprovalPanel toolName="terminal" summary="rm -rf tmp" onConfirm={(c) => seen.push(c)} />)
    expect(screen.getByText('允许')).toBeTruthy()
    expect(screen.getByText('始终允许本项目')).toBeTruthy()
    expect(screen.getByText('完全访问')).toBeTruthy()
    expect(screen.getByText('拒绝')).toBeTruthy()
    expect(screen.getByText('新对话默认完全访问')).toBeTruthy()
    expect(screen.getByText(/同名工具不再询问/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(seen).toEqual(['allow_once'])
    // 未进入决策态：面板仍可交互
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy()
  })

  it('选中完全访问后确认 → full_access', () => {
    const seen: string[] = []
    render(<ToolApprovalPanel toolName="bash" summary="ls" onConfirm={(c) => seen.push(c)} />)
    fireEvent.click(screen.getByText('完全访问'))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(seen).toEqual(['full_access'])
  })

  it('decided=approved：面板切换为「已批准，等待执行…」结果条，不再渲染选项', () => {
    render(<ToolApprovalPanel toolName="write" summary="a.txt" decided="approved" onConfirm={() => {}} />)
    expect(screen.getByText('已批准，等待执行…')).toBeTruthy()
    expect(screen.queryByText('允许')).toBeNull()
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
    expect(screen.getByText('a.txt')).toBeTruthy()
  })

  it('decided=denied：面板切换为「已拒绝」结果条', () => {
    render(<ToolApprovalPanel toolName="terminal" summary="ls" decided="denied" onConfirm={() => {}} />)
    expect(screen.getByText('已拒绝')).toBeTruthy()
    expect(screen.queryByText('允许')).toBeNull()
  })
})

describe('ToolApprovalPanel 新对话默认勾选', () => {
  it('勾选会写入全局策略并派发 session full-access 请求事件', async () => {
    const patchSpy = vi
      .spyOn(toolApprovalSettings, 'patchGlobalToolApprovalPolicy')
      .mockResolvedValue({
        defaultPolicy: toolApprovalSettings.TOOL_APPROVAL_POLICY_GRANT_ALL,
        validPolicies: [],
      })
    const seen: Event[] = []
    const onEvt = (e: Event) => seen.push(e)
    window.addEventListener(TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS, onEvt)
    try {
      render(<ToolApprovalPanel toolName="bash" summary="ls" onConfirm={() => {}} />)
      fireEvent.click(screen.getByRole('checkbox', { name: '新对话默认完全访问' }))
      await vi.waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith(toolApprovalSettings.TOOL_APPROVAL_POLICY_GRANT_ALL)
        expect(seen.length).toBeGreaterThan(0)
      })
    } finally {
      window.removeEventListener(TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS, onEvt)
      patchSpy.mockRestore()
    }
  })
})
