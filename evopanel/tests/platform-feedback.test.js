import { describe, expect, it, vi } from 'vitest'
import { EventType } from '@ag-ui/core'
import {
  parsePlatformUiFeedback,
  syncPlatformFeedbackFromTools,
  canOpenPlatformFeedbackFromTool,
  mergePlatformRunEntries,
  platformRunEntriesFromChatArtifacts,
  platformUiToRunEntry,
} from '../src/lib/right-stage/platform-feedback.ts'
import { publishPlatformFromAgUiResult } from '../src/react/chat-app/stream/publish-platform-from-agui-result.ts'

describe('parsePlatformUiFeedback', () => {
  it('uses backend ui payload when present', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'items.create',
      ui: {
        kind: 'success',
        title: '创建「测试」待办事项成功',
        domain: 'items',
      },
    })
    const ui = parsePlatformUiFeedback(raw)
    expect(ui?.title).toBe('创建「测试」待办事项成功')
  })

  it('falls back when ui missing but write action succeeded', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'items.create',
      item: { id: 'item_1', title: '周五交报告' },
    })
    const ui = parsePlatformUiFeedback(raw)
    expect(ui?.title).toContain('周五交报告')
    expect(ui?.title).toContain('待办事项')
  })

  it('skips preview / read actions', () => {
    const preview = JSON.stringify({
      ok: true,
      pending_confirm: true,
      action: 'items.create',
    })
    expect(parsePlatformUiFeedback(preview)).toBeNull()

    const listed = JSON.stringify({
      ok: true,
      action: 'items.list',
      items: [],
    })
    expect(parsePlatformUiFeedback(listed)).toBeNull()
  })

  it('reads preserved appearance settings after output slimming', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'appearance.patch',
      client_effect: 'panel_settings',
      settings: { accentPalette: 'blue', theme: 'dark' },
      ui: {
        kind: 'success',
        title: '界面外观已更新',
        domain: 'appearance',
      },
    })
    const tool = {
      id: 'call_appearance',
      name: 'platform',
      output: '',
      output_truncated: true,
      platform_ui: JSON.parse(raw).ui,
      platform_action: 'appearance.patch',
      platform_settings: JSON.parse(raw).settings,
      platform_client_effect: 'panel_settings',
      platform_ok: true,
    }
    const { shown } = syncPlatformFeedbackFromTools([tool], new Set())
    expect(shown[0]?.title).toBe('界面外观已更新')
  })

  it('parses bind-channel QR fields from ui payload', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'employees.bind_channel_begin',
      agent_code: 'duty-ops',
      qr_url: 'https://example.com/qr',
      session_id: 'sess_1',
      channel: 'feishu',
      ui: {
        kind: 'success',
        title: '已为「运维值班」生成渠道绑定二维码',
        domain: 'employees',
        qrUrl: 'https://example.com/qr',
        sessionId: 'sess_1',
        channel: 'feishu',
        agentCode: 'duty-ops',
        bindStatus: 'pending',
        action: 'employees.bind_channel_begin',
      },
    })
    const ui = parsePlatformUiFeedback(raw)
    expect(ui?.qrUrl).toBe('https://example.com/qr')
    expect(ui?.sessionId).toBe('sess_1')
    expect(ui?.channel).toBe('feishu')
    expect(ui?.agentCode).toBe('duty-ops')
    expect(ui?.bindStatus).toBe('pending')
  })

  it('collects bind QR card from preserved platform_ui when output is empty', async () => {
    const { collectPlatformResultTools, parsePlatformUiFeedbackFromTool } = await import(
      '../src/lib/right-stage/platform-feedback.js'
    )
    const tool = {
      id: 'call_bind',
      name: 'platform',
      output: '',
      truncated: true,
      platform_ui: {
        kind: 'success',
        title: '扫码绑定本岗 AI 员工',
        domain: 'employees',
        action: 'employees.bind_channel_begin',
        qrUrl: 'https://open.feishu.cn/page/launcher?user_code=TEST',
        sessionId: 'sess_bind',
        channel: 'feishu',
        agentCode: 'emp-test',
        bindStatus: 'pending',
        entityLabel: '智能辅导员',
      },
      platform_ok: true,
      platform_action: 'employees.bind_channel_begin',
    }
    const ui = parsePlatformUiFeedbackFromTool(tool)
    expect(ui?.qrUrl).toContain('open.feishu.cn')
    expect(ui?.bindStatus).toBe('pending')
    expect(collectPlatformResultTools([tool])).toHaveLength(1)
  })

  it('reads preserved platform_ui after output slimming', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'items.update',
      item: { id: 'item_1', title: '测试待办事项 - 已修改' },
      ui: {
        kind: 'success',
        title: '修改「测试待办事项 - 已修改」待办事项成功',
      },
    })
    const tool = {
      id: 'call_1',
      name: 'platform',
      output: '',
      output_truncated: true,
      platform_ui: JSON.parse(raw).ui,
      platform_action: 'items.update',
      platform_item: JSON.parse(raw).item,
      platform_ok: true,
    }
    const { shown, entries } = syncPlatformFeedbackFromTools([tool], new Set())
    expect(shown[0]?.title).toContain('测试待办事项 - 已修改')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.action).toBe('items.update')
  })

  it('collectPlatformResultTools respects filter ids and running state', async () => {
    const { collectPlatformResultTools } = await import('../src/lib/right-stage/platform-feedback.js')
    const done = {
      id: 'call_done',
      name: 'platform',
      output: '',
      platform_ui: { kind: 'success', title: '已创建待办' },
      platform_ok: true,
    }
    const running = {
      id: 'call_run',
      name: 'platform',
      status: 'running',
      output: JSON.stringify({ ok: true, ui: { kind: 'success', title: '运行中' } }),
    }
    const other = {
      id: 'call_other',
      name: 'platform',
      output: JSON.stringify({ ok: true, ui: { kind: 'success', title: '其它' } }),
    }
    expect(collectPlatformResultTools([done, running, other], ['call_done'])).toHaveLength(1)
    expect(collectPlatformResultTools([done, other])).toHaveLength(2)
  })

  it('detects reopenable slimmed platform tool rows', () => {
    const tool = {
      name: 'platform',
      output: '',
      platform_ui: { kind: 'success', title: '修改成功' },
      platform_action: 'items.update',
      platform_ok: true,
    }
    expect(canOpenPlatformFeedbackFromTool(tool)).toBe(true)
  })

  it('accumulates multiple platform entries newest first', () => {
    const first = platformUiToRunEntry(
      { kind: 'success', title: '创建 A', action: 'items.create' },
      'call_1',
    )
    first.appliedAt = 1000
    const second = platformUiToRunEntry(
      { kind: 'success', title: '修改 B', action: 'items.update' },
      'call_2',
    )
    second.appliedAt = 2000
    const merged = mergePlatformRunEntries(mergePlatformRunEntries([], first), second)
    expect(merged).toHaveLength(2)
    expect(merged.map((e) => e.title)).toEqual(['修改 B', '创建 A'])
  })

  it('restores persisted platform artifacts newest first', () => {
    const entries = platformRunEntriesFromChatArtifacts([
      {
        id: 'platform:call_1',
        type: 'platform',
        label: '创建 A',
        platformAction: 'items.create',
        platformDomain: 'items',
        createdAt: '2026-08-22T07:00:00.000Z',
      },
      {
        id: 'platform:call_2',
        type: 'platform',
        label: '修改 B',
        platformAction: 'items.update',
        platformDomain: 'items',
        updatedAt: '2026-08-22T08:00:00.000Z',
        platformActions: [{ label: '查看事项', route: '/tasks?tab=items' }],
      },
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0]?.title).toBe('修改 B')
    expect(entries[0]?.actions?.[0]?.label).toBe('查看事项')
    expect(entries[1]?.title).toBe('创建 A')
  })
})

describe('publishPlatformFromAgUiResult — 流式右上角平台通知', () => {
  it('平台 TOOL_CALL_RESULT 立刻 publish', () => {
    const publish = vi.fn()
    const toast = vi.fn()
    const seen = new Set()
    const ok = publishPlatformFromAgUiResult({
      isBackground: false,
      aguiEvent: {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: 'tc-hire-1',
        toolCallName: 'platform',
        content: JSON.stringify({
          ok: true,
          action: 'employees.hire',
          ui: {
            kind: 'success',
            title: '已添加智能体员工「小助手」',
            domain: 'employees',
            action: 'employees.hire',
          },
        }),
      },
      platformFeedbackSeenRef: { current: seen },
      turnPlatformEntriesRef: { current: [] },
      publishPlatformEntries: publish,
      toast,
    })
    expect(ok).toBe(true)
    expect(seen.has('tc-hire-1')).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('已添加智能体员工「小助手」', 'success')
  })

  it('wire platform_ui + 空 content 也能发布（truncated 场景）', () => {
    const publish = vi.fn()
    const toast = vi.fn()
    const ok = publishPlatformFromAgUiResult({
      isBackground: false,
      aguiEvent: {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: 'tc-bind-wire',
        toolCallName: 'platform',
        content: '',
        truncated: true,
        platform_ui: {
          kind: 'success',
          title: '扫码绑定本岗 AI 员工',
          domain: 'employees',
          action: 'employees.bind_channel_begin',
          qrUrl: 'https://open.feishu.cn/page/launcher?user_code=WIRE',
          sessionId: 'sess_w',
          channel: 'feishu',
          bindStatus: 'pending',
        },
      },
      platformFeedbackSeenRef: { current: new Set() },
      turnPlatformEntriesRef: { current: [] },
      publishPlatformEntries: publish,
      toast,
    })
    expect(ok).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('扫码绑定本岗 AI 员工', 'success')
  })

  it('后台会话不发布；同 id 不重复', () => {
    expect(
      publishPlatformFromAgUiResult({
        isBackground: true,
        aguiEvent: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'tc1',
          toolCallName: 'platform',
          content: JSON.stringify({ ok: true, ui: { kind: 'success', title: 'x' } }),
        },
        platformFeedbackSeenRef: { current: new Set() },
        turnPlatformEntriesRef: { current: [] },
        publishPlatformEntries: vi.fn(),
        toast: vi.fn(),
      }),
    ).toBe(false)

    const publish = vi.fn()
    expect(
      publishPlatformFromAgUiResult({
        isBackground: false,
        aguiEvent: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'tc3',
          toolCallName: 'platform',
          content: JSON.stringify({ ok: true, ui: { kind: 'success', title: '重复' } }),
        },
        platformFeedbackSeenRef: { current: new Set(['tc3']) },
        turnPlatformEntriesRef: { current: [] },
        publishPlatformEntries: publish,
        toast: vi.fn(),
      }),
    ).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })
})
