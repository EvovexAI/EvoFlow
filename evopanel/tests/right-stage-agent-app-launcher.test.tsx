import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

afterEach(() => cleanup())

// ui-extensions 会 import tauri core；测试里 mock 成纯内存实现。
vi.mock('../src/lib/ui-extensions.js', () => ({
  listEnabledUiExtensions: vi.fn(async () => [
    {
      id: 'my-ops',
      enabled: true,
      manifest: {
        name: 'my-ops',
        nav: { title: '运营台' },
        description: '看投放数据',
        version: '1.2.0',
        ui: { entry: 'http://127.0.0.1:5173/' },
      },
    },
    {
      id: 'other-app',
      enabled: true,
      manifest: {
        name: 'other-app',
        nav: { title: '素材库' },
        description: '找素材',
        ui: { entry: 'http://127.0.0.1:5174/' },
      },
    },
  ]),
  onUiExtensionsChanged: vi.fn(() => () => {}),
  resolveUiExtensionIconSrc: vi.fn(() => ({ kind: 'none' })),
}))

import { RightStageAgentAppPickList } from '../src/react/components/RightStageAgentAppPickList.js'

describe('RightStageAgentAppPickList', () => {
  it('lists installed agent apps and picks one by id', async () => {
    const onPick = vi.fn()
    render(<RightStageAgentAppPickList onPick={onPick} />)

    expect(await screen.findByText('运营台')).toBeTruthy()
    expect(screen.getByText('看投放数据')).toBeTruthy()
    expect(screen.getByText('素材库')).toBeTruthy()

    const btn = screen.getByText('运营台').closest('button')
    expect(btn).toBeTruthy()
    btn!.click()
    expect(onPick).toHaveBeenCalledWith('my-ops')
  })

  it('filters by name / description / id', async () => {
    render(<RightStageAgentAppPickList onPick={vi.fn()} />)
    expect(await screen.findByText('运营台')).toBeTruthy()

    const search = document.querySelector(
      '.react-chat-stage-app-search',
    ) as HTMLInputElement
    expect(search).toBeTruthy()
    fireEvent.input(search, { target: { value: '素材' } })
    fireEvent.change(search, { target: { value: '素材' } })

    expect(screen.queryByText('运营台')).toBeNull()
    expect(screen.getByText('素材库')).toBeTruthy()
  })
})

/**
 * 启动器语义守卫：「Agent 应用」必须与「工作流」一样先进选择器，
 * 而不是直接开一个空页面；且每个应用开自己的标签（多签共存）。
 */
describe('agent app launcher wiring', () => {
  const panelSrc = readFileSync(
    resolve(__dirname, '../src/react/components/RightStagePanel.tsx'),
    'utf8',
  )
  const launcherSrc = readFileSync(
    resolve(__dirname, '../src/react/chat-app/right-stage/build-right-stage-launcher-items.ts'),
    'utf8',
  )
  const openSrc = readFileSync(
    resolve(__dirname, '../src/react/chat-app/right-stage/open-ui-extension-in-stage.ts'),
    'utf8',
  )

  it('exposes an agent-app launcher item', () => {
    expect(panelSrc).toContain("| 'agent-app'")
    expect(panelSrc).toContain("label: 'Agent 应用'")
    // 入口出现的前置：有 onPickAgentApp 才挂（避免空面板）
    expect(panelSrc).toMatch(/if \(handlers\.onOpenAgentApp\)/)
  })

  it('opens the picker instead of opening a blank page directly', () => {
    expect(panelSrc).toContain("item.id === 'agent-app'")
    expect(panelSrc).toContain('setPickAgentAppOpen(true)')
    expect(panelSrc).toContain('选择 Agent 应用')
  })

  it('passes the picked app id to onPickAgentApp', () => {
    expect(panelSrc).toContain('onPickAgentApp?.(appId)')
  })

  it('injects the launcher handler from the chat controller', () => {
    expect(launcherSrc).toContain('onOpenAgentApp')
  })

  it('gives each agent app its own right-stage tab', () => {
    expect(openSrc).toContain('uiExtensionStageTabId')
    // 同 kind 多签共存：切换/关闭只针对该应用的签，不整 kind 清场。
    expect(openSrc).not.toContain("hideRightStageIfKind('web-embed')")
  })
})
