import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatSummaryPanel } from '../src/react/components/ChatSummaryPanel.tsx'
import { saveChatSummarySections } from '../src/react/lib/chat-summary-panel-prefs.ts'

// 并行会话中间态的 tauri-api.js 可能暂时语法不完整：这里整体 mock 掉，
// 本测试只关心进程行点击 → 实时流浮层的纯前端接线。
vi.mock('../src/lib/tauri-api.js', () => {
  const apiStub = new Proxy(
    {},
    { get: () => () => Promise.resolve({}) },
  )
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'api') return apiStub
        if (prop === 'isTauri') return false
        if (prop === '__esModule') return true
        return () => Promise.resolve({})
      },
    },
  )
})

const runningTask = {
  taskId: 'sa-1',
  subagentType: '',
  phase: 'running' as const,
  description: '',
  liveOutput: '子智能体实时输出 hello',
  startedAt: Date.now() - 5000,
}

function mountPanel() {
  return render(
    <ChatSummaryPanel
      displayMode="panel"
      onDisplayModeChange={() => {}}
      sessionKey="sess-agent-detail"
      sessionTitle="测试会话"
      subagentTasks={{ 'sa-1': runningTask }}
    />,
  )
}

async function openProcessTab() {
  // 进程 tab（文本带运行数如「进程 1」；默认分区里 process 关着，测试里打开）
  const tab = await screen.findByRole('tab', { name: /进程/ })
  fireEvent.click(tab)
}

describe('状态面板进程行：子智能体点击查看实时流', () => {
  beforeEach(() => {
    localStorage.clear()
    // happy-dom 默认文档源是 localhost:3000，挂载期任何相对 fetch 会真连网络
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))),
    )
    saveChatSummarySections({ process: true, agent: true, more: true })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('点子智能体行打开实时流浮层，展示 liveOutput', async () => {
    mountPanel()
    await openProcessTab()
    // 行 label = description || subagentType || taskId，fixture 下是 sa-1；直接点行按钮
    const row = await screen.findByRole('button', { name: /进行中/ })
    fireEvent.click(row)
    const portalTitle = await screen.findByText(/子任务实时流/)
    expect(portalTitle).toBeTruthy()
    expect(screen.getByText(/子智能体实时输出 hello/)).toBeTruthy()
  })

  it('浮层关闭后回到进程列表', async () => {
    mountPanel()
    await openProcessTab()
    fireEvent.click(await screen.findByRole('button', { name: /进行中/ }))
    await screen.findByText(/子任务实时流/)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(screen.queryByText(/子任务实时流/)).toBeNull()
    expect(screen.getByRole('button', { name: /进行中/ })).toBeTruthy()
  })
})
