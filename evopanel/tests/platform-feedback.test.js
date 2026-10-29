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

  it('skips preview / confirm; list reads open shell-page feedback', () => {
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
    const ui = parsePlatformUiFeedback(listed)
    expect(ui).not.toBeNull()
    expect(ui?.actions?.[0]?.openStage?.kind).toBe('shell-page')
    expect(ui?.actions?.[0]?.openStage?.data?.path).toBe('/tasks/items')
    expect(ui?.actions?.[0]?.autoOpen).toBe(true)
  })

  it('items.create enriches shell-page autoOpen for V4 right stage', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'items.create',
      item: { id: 'item_1', title: '周五交报告' },
      ui: {
        kind: 'success',
        title: '创建「周五交报告」待办事项成功',
        domain: 'items',
        entityId: 'item_1',
        entityLabel: '周五交报告',
        action: 'items.create',
        actions: [{ label: '查看事项', route: '/tasks?tab=items&focus=item_1' }],
      },
    })
    const ui = parsePlatformUiFeedback(raw)
    expect(ui?.actions?.[0]?.autoOpen).toBe(true)
    expect(ui?.actions?.[0]?.openStage?.kind).toBe('shell-page')
    expect(ui?.actions?.[0]?.openStage?.data?.path).toBe('/tasks/items')
    expect(ui?.actions?.[0]?.openStage?.data?.mountId).toBe('items.board')
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

  it('infers bind QR from top-level qr_url when ui block is missing', () => {
    const raw = JSON.stringify({
      ok: true,
      action: 'employees.bind_channel_begin',
      agent_code: 'tutor',
      role_name: '智能辅导',
      channel: 'feishu',
      session_id: 'sess_top',
      qr_url: 'https://open.feishu.cn/page/launcher?user_code=TOP',
    })
    const ui = parsePlatformUiFeedback(raw)
    expect(ui?.action).toBe('employees.bind_channel_begin')
    expect(ui?.qrUrl).toContain('user_code=TOP')
    expect(ui?.sessionId).toBe('sess_top')
    expect(ui?.bindStatus).toBe('pending')
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

describe('publishArtifacts — panel_set artifacts 必须能强制打开状态卡', () => {
  it('force=true 时展开 panel + 切到产物 tab（不跟自动预览设置）', async () => {
    const { publishArtifacts } = await import('../src/react/chat-app/right-stage/publish-artifacts.ts')
    const { vi } = await import('vitest')
    const ctx = {
      turnRunArtifactsRef: {
        current: [
          {
            id: 'path:outputs/tutor-feishu-bind-qr.png',
            type: 'image',
            name: 'tutor-feishu-bind-qr.png',
            path: 'outputs/tutor-feishu-bind-qr.png',
          },
        ],
      },
      setTurnArtifacts: vi.fn(),
      isAutoWorkPreviewEnabled: () => false,
      writeStreamModeRef: { current: 'off' },
      rightStageHintTimerRef: { current: 0 },
      hideRightStageIfKind: vi.fn(),
      setChatPanelDisplayMode: vi.fn(),
      setInfoRailOpen: vi.fn(),
      setInfoRailTab: vi.fn(),
      setArtifactFocusId: vi.fn(),
      toast: vi.fn(),
    }
    publishArtifacts(ctx)
    expect(ctx.setChatPanelDisplayMode).not.toHaveBeenCalled()

    publishArtifacts(ctx, {
      force: true,
      focusId: 'path:outputs/tutor-feishu-bind-qr.png',
    })
    expect(ctx.setChatPanelDisplayMode).toHaveBeenCalledWith('panel')
    expect(ctx.setInfoRailOpen).toHaveBeenCalledWith(true)
    expect(ctx.setInfoRailTab).toHaveBeenCalledWith('artifacts')
    expect(ctx.setArtifactFocusId).toHaveBeenCalledWith('path:outputs/tutor-feishu-bind-qr.png')
  })
})

describe('V4 platform_ui progress display', () => {
  it('readToolResultDisplay 接受无二维码的 openStage actions', async () => {
    const { readToolResultDisplay } = await import(
      '../src/zcode-ui/ToolCallBlocks/toolResultDisplay.ts'
    )
    const { readPlatformProgressFeedback } = await import(
      '../src/zcode-ui/ToolCallBlocks/renderers/platform.tsx'
    )
    const display = {
      kind: 'platform_ui',
      schemaVersion: 1,
      action: 'workflow.run',
      title: '已启动工作流',
      actions: [
        {
          label: '查看进度',
          autoOpen: true,
          openStage: { kind: 'collab-workflow', data: { mainTaskId: 'mt-v4-1' } },
        },
      ],
    }
    expect(readToolResultDisplay({ display })?.kind).toBe('platform_ui')
    const feedback = readPlatformProgressFeedback({ display })
    expect(feedback?.actions?.[0]?.autoOpen).toBe(true)
    expect(feedback?.actions?.[0]?.openStage?.data?.mainTaskId).toBe('mt-v4-1')
  })
})

describe('tryEagerAutoOpenPlatformFromArgs', () => {
  it('employees.list args 即可拉开员工名册，不必等 RESULT', async () => {
    const { tryEagerAutoOpenPlatformFromArgs } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.hideAll()
    const diag = tryEagerAutoOpenPlatformFromArgs(
      JSON.stringify({ action: 'employees.list' }),
      { toolCallId: 'eager-emp-list-1', toolName: 'platform' },
    )
    expect(diag.opened).toBe(true)
    expect(diag.action).toBe('employees.list')
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs.some((t) => t.kind === 'shell-page')).toBe(true)
    // 同 toolCallId 不重复开
    expect(
      tryEagerAutoOpenPlatformFromArgs(JSON.stringify({ action: 'employees.list' }), {
        toolCallId: 'eager-emp-list-1',
        toolName: 'platform',
      }).reason,
    ).toBe('already-eager')
  })

  it('employees.wake args 拉开 employeeProcess', async () => {
    const { tryEagerAutoOpenPlatformFromArgs } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.hideAll()
    const diag = tryEagerAutoOpenPlatformFromArgs(
      JSON.stringify({ action: 'employees.wake', agent_code: 'clerk' }),
      { toolCallId: 'eager-wake-1', toolName: 'platform' },
    )
    expect(diag.opened).toBe(true)
    expect(rightStageStore.getSnapshot().tabs.some((t) => t.kind === 'employeeProcess')).toBe(
      true,
    )
  })

  it('incomplete JSON / 无关 action 不开栏', async () => {
    const { tryEagerAutoOpenPlatformFromArgs } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    expect(tryEagerAutoOpenPlatformFromArgs('{"action":"employees.li').opened).toBe(false)
    expect(
      tryEagerAutoOpenPlatformFromArgs(JSON.stringify({ action: 'agents.list' }), {
        toolCallId: 'eager-agents',
        toolName: 'platform',
      }).reason,
    ).toBe('not-eager-action')
  })
})

describe('workflow.run autoOpen 右栏', () => {
  it('tools-scan 首见也拉开 collab-workflow（不依赖 AG-UI RESULT）', async () => {
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.hideAll()
    const tool = {
      id: 'tc-wf-scan',
      name: 'platform',
      output: JSON.stringify({
        ok: true,
        action: 'workflow.run',
        task_id: 'mt-auto-1',
        ui: {
          kind: 'success',
          title: '已启动工作流',
          domain: 'workflow',
          action: 'workflow.run',
          actions: [
            {
              label: '查看进度',
              autoOpen: true,
              openStage: { kind: 'collab-workflow', data: { mainTaskId: 'mt-auto-1' } },
            },
          ],
        },
      }),
    }
    syncPlatformFeedbackFromTools([tool], new Set())
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs.some((t) => t.kind === 'collab-workflow')).toBe(true)
    expect(String(snap.surface?.data?.mainTaskId || '')).toBe('mt-auto-1')
  })

  it('seen 已标时 RESULT 仍会补开侧栏', async () => {
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    // 清掉上一用例留下的 tab，模拟「只标 seen、没开栏」
    rightStageStore.hideAll()
    const seen = new Set(['tc-wf-seen'])
    publishPlatformFromAgUiResult({
      isBackground: false,
      aguiEvent: {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: 'tc-wf-seen',
        toolCallName: 'platform',
        content: JSON.stringify({
          ok: true,
          action: 'workflow.run',
          ui: {
            kind: 'success',
            title: '已启动',
            domain: 'workflow',
            actions: [
              {
                label: '查看进度',
                autoOpen: true,
                openStage: { kind: 'collab-workflow', data: { mainTaskId: 'mt-seen-1' } },
              },
            ],
          },
        }),
      },
      platformFeedbackSeenRef: { current: seen },
      turnPlatformEntriesRef: { current: [] },
      publishPlatformEntries: vi.fn(),
      toast: vi.fn(),
    })
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs.some((t) => t.kind === 'collab-workflow')).toBe(true)
    expect(String(snap.surface?.data?.mainTaskId || '')).toBe('mt-seen-1')
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
