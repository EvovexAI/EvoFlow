import { describe, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { RightStageUnavailableShell } from '../src/react/components/RightStageUnavailableShell.tsx'

/**
 * 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：给「不可用终态提示」补一条真实 DOM 渲染用例（不是源码字符串 grep）。
 * 为什么：源码级门禁只能证明「没写 SidePanelBootShell」，不能证明「渲染出来真的
 *   没有『加载中』」。用户看到的转圈来自实际 DOM，所以判据必须落在 DOM 文本上。
 * 判据（可反证）：把组件里任意一段文案改回「加载中…」，本用例必须红。
 */

describe('RightStageUnavailableShell renders a terminal message, never a spinner', () => {
  it('shows the reason and a close action, with no loading text in the DOM', () => {
    const onClose = vi.fn()
    const { container } = render(
      <RightStageUnavailableShell title="工作区文件" kind="workspace-browse" onClose={onClose} />,
    )
    const text = container.textContent || ''
    expect(text).not.toContain('加载中')
    expect(text).toContain('这个面板不能在当前视图里打开')
    expect(text).toContain('workspace-browse')
    expect(text).toContain('工作区文件')

    const btn = container.querySelector('button')
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).textContent).toBe('关闭')
    ;(btn as HTMLButtonElement).click()
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('still explains itself when the kind is unknown', () => {
    const { container } = render(<RightStageUnavailableShell title="面板" />)
    const text = container.textContent || ''
    expect(text).not.toContain('加载中')
    expect(text).toContain('当前嵌入视图不支持该面板类型')
    cleanup()
  })
})
