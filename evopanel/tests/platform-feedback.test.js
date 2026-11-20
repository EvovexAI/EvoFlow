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
// 重导入（zcode-ui 渲染树）提到文件级：文件加载不受单测 5s 超时约束，
// 全量并发跑时动态 import 会被 worker 饥饿拖到超时（偶发 flake）。
import { readToolResultDisplay } from '../src/zcode-ui/ToolCallBlocks/toolResultDisplay.ts'
import { readPlatformProgressFeedback } from '../src/zcode-ui/ToolCallBlocks/renderers/platform.tsx'

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

  it('skips preview / confirm; list reads give clickable card without auto-open', () => {
    const preview = JSON.stringify({
      ok: true,
      pending_confirm: true,
      action: 'items.create',
    })
    expect(parsePlatformUiFeedback(preview)).toBeNull()

    // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：断言从 autoOpen===true 反转为不开。
    // 为什么：用户要求「有通知就够了，右侧不要突然展开」；items.list 是纯只读，
    // 它只要出可点卡片即可，自动展开会让右栏莫名其妙弹出来。
    const listed = JSON.stringify({
      ok: true,
      action: 'items.list',
      items: [],
    })
    const ui = parsePlatformUiFeedback(listed)
    expect(ui).not.toBeNull()
    expect(ui?.actions?.[0]?.openStage?.kind).toBe('shell-page')
    expect(ui?.actions?.[0]?.openStage?.data?.path).toBe('/tasks/items')
    expect(ui?.actions?.[0]?.autoOpen).toBeFalsy()
  })

  // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：本用例原断言 items.create 的 autoOpen===true，现反转为不自动开。
  // 为什么：items.create 不在后端 AUTO_OPEN_ACTIONS 里（should_auto_open 返 False），
  // 前端原先有一行硬编码 `autoOk || action === 'items.create' ...` 把统一判据整个
  // 绕过了——这就是用户说的「莫名其妙打开右栏」。判据改为只认 autoOk 后，
  // 这条断言按旧值必红，反转后才是与真源同口径。
  it('items.create 出可点卡片但不再自动展开右栏', () => {
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
    // 卡片仍在（用户可点开），只是不抢视线
    expect(ui?.actions?.[0]?.openStage?.kind).toBe('shell-page')
    expect(ui?.actions?.[0]?.openStage?.data?.path).toBe('/tasks/items')
    expect(ui?.actions?.[0]?.openStage?.data?.mountId).toBe('items.board')
    expect(ui?.actions?.[0]?.autoOpen).toBeFalsy()
  })

  // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：新增 3 条用例，锚住第88轮删掉的硬编码 OR。
  // 为什么：第87轮只抓了 items.* 一处，同一文件还有 tasks.list / employees.list 三类 /
  // workflow.run_status 三处绕过。**注意夹具必须命中被改的那条分支**——我第一版
  // 用 route:'/proactive' 传 tasks.list，根本没进 /tasks 那段，重新注入 OR 仍然全绿，
  // 等于没测（反证一跑就露）。
  it('tasks.list 的 /tasks 卡片不自动展开右栏', () => {
    const ui = parsePlatformUiFeedback(
      JSON.stringify({
        ok: true,
        action: 'tasks.list',
        ui: {
          kind: 'success',
          title: '任务列表',
          domain: 'tasks',
          action: 'tasks.list',
          actions: [{ label: '打开任务', route: '/tasks' }],
        },
      }),
    )
    const cta = (ui?.actions || []).find((a) => a.openStage?.kind === 'shell-page')
    expect(cta).toBeTruthy()
    expect(cta?.openStage?.data?.path).toBe('/tasks')
    expect(cta?.autoOpen).toBeFalsy()
  })

  for (const action of ['employees.list', 'employees.org_status', 'employees.board_overview']) {
    it(`${action} 的 /proactive 看板卡片不自动展开右栏`, () => {
      const ui = parsePlatformUiFeedback(
        JSON.stringify({
          ok: true,
          action,
          ui: {
            kind: 'success',
            title: '员工看板',
            domain: 'employees',
            action,
            actions: [{ label: '打开 BOT', route: '/proactive' }],
          },
        }),
      )
      const cta = (ui?.actions || []).find((a) => a.openStage?.kind === 'shell-page')
      expect(cta).toBeTruthy()
      expect(cta?.openStage?.data?.path).toBe('/proactive')
      expect(cta?.autoOpen).toBeFalsy()
    })
  }

  it('workflow.run_status 不自动展开工作流图（真跑的 run 仍开）', () => {
    // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：拆成「带 route / 不带 route」两条夹具。
    // 为什么：enrich 里 workflow 有**两条**产生 collab-workflow 的分支——
    // ① 已有 CTA 且 route 是 /apps/…/run → 原地升级；② 没有可升级的 CTA → unshift 补一条。
    // 我第一版只给了带 route 的夹具，unshift 那条根本没执行；把 `autoOpen: true` 写回去
    // 测试照样全绿（反证一跑就露）。两条都必须单独锚住。
    const mk = (action, actions) =>
      parsePlatformUiFeedback(
        JSON.stringify({
          ok: true,
          action,
          ui: {
            kind: 'success',
            title: '工作流',
            domain: 'workflow',
            action,
            // tid 取自 entityId（enrich 里 `tid = siblingTid || entityId`）
            entityId: 'mt-1',
            actions,
          },
        }),
      )
    const runRoute = [{ label: '打开工作流', route: '/apps/App_1/run?runId=r-1' }]
    const noRoute = [{ label: '打开工作流' }]

    for (const [tag, actions] of [
      ['升级分支', runRoute],
      ['unshift 分支', noRoute],
    ]) {
      for (const [action, expectAuto] of [
        ['workflow.run_status', false],
        ['workflow.run', true],
      ]) {
        const ui = mk(action, actions)
        const ctas = (ui?.actions || []).filter(
          (a) => a.openStage?.kind === 'collab-workflow',
        )
        expect(ctas.length, `${tag}/${action} 没生成工作流 CTA`).toBeGreaterThan(0)
        for (const c of ctas) {
          expect(c.autoOpen, `${tag}/${action} autoOpen 不符`).toBe(expectAuto)
        }
      }
    }
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

  it('restores workflow openStage from platform artifact (Info Rail CTA)', async () => {
    const { normalizeChatArtifact } = await import('../src/react/lib/chat-artifact.ts')
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    const { activatePlatformFeedbackAction, platformRunEntriesFromChatArtifacts } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const raw = {
      id: 'platform:tc-wf-open',
      type: 'platform',
      label: '已启动工作流「demo」',
      platformAction: 'workflow.run',
      platformDomain: 'workflow',
      platformEntityId: 'mt-open-1',
      platformSubtitle: '可在工作流/应用页查看运行',
      platformActions: [
        {
          label: '打开工作流',
          autoOpen: true,
          openStage: { kind: 'collab-workflow', data: { mainTaskId: 'mt-open-1' } },
        },
      ],
    }
    const normalized = normalizeChatArtifact(raw)
    expect(normalized?.platformActions?.[0]?.openStage?.kind).toBe('collab-workflow')
    expect(normalized?.platformActions?.[0]?.openStage?.data?.mainTaskId).toBe('mt-open-1')
    expect(normalized?.platformEntityId).toBe('mt-open-1')

    const entries = platformRunEntriesFromChatArtifacts([normalized])
    expect(entries[0]?.actions?.[0]?.openStage?.kind).toBe('collab-workflow')
    expect(entries[0]?.entityId).toBe('mt-open-1')

    rightStageStore.hideAll()
    expect(
      activatePlatformFeedbackAction(entries[0].actions[0], {
        domain: entries[0].domain,
        action: entries[0].action,
        entityId: entries[0].entityId,
        title: entries[0].title,
      }),
    ).toBe(true)
    expect(rightStageStore.getSnapshot().tabs.some((t) => t.kind === 'collab-workflow')).toBe(true)
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
  it('readToolResultDisplay 接受无二维码的 openStage actions', () => {
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
  it('employees.list args 不再自动拉开右栏（只读：只给通知卡）', async () => {
    // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：断言从 opened===true 反转为不开。
    // 为什么：用户 2026-11-20 要求「有通知就够了，右侧不要突然展开」。
    // employees.list 是纯只读查询，模型每查一次名单就弹右栏正是要修的毛病。
    const { tryEagerAutoOpenPlatformFromArgs } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.hideAll()
    rightStageStore.expand()
    const diag = tryEagerAutoOpenPlatformFromArgs(
      JSON.stringify({ action: 'employees.list' }),
      { toolCallId: 'eager-emp-list-1', toolName: 'platform' },
    )
    expect(diag.opened).toBe(false)
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs.some((t) => t.kind === 'shell-page')).toBe(false)
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

  it('契约声明某 EAGER 动作不自动展开时，args 阶段也不开（真源优先）', async () => {
    // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：新增本用例，钉住「EAGER 表不再单独决定开不开」。
    // 为什么：EAGER 表原本直接写 autoOpen:true，绕过真源判据——是同一文件里
    // 第 5 处私有白名单。它的 4 个成员当时恰好都在自动展开白名单里，
    // 所以旧代码在这条用例下才会红、旧测试全绿也发现不了。
    const { __resetRightPanelContractCache, loadRightPanelContract } = await import(
      '../src/lib/right-stage/right-panel-contract.ts'
    )
    const { tryEagerAutoOpenPlatformFromArgs } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')

    __resetRightPanelContractCache()
    const prevFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          kinds: [{ kind: 'employeeProcess', required: ['data.agentCode'] }],
          autoOpenActions: [],
          readOnlyActions: ['employees.wake'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    let contract
    try {
      contract = await loadRightPanelContract()
    } finally {
      globalThis.fetch = prevFetch
    }
    // 契约必须真的加载成功，否则下面走的是兜底分支，本用例就测了个寂寞
    expect(contract.ok).toBe(true)

    rightStageStore.hideAll()
    rightStageStore.expand()
    const diag = tryEagerAutoOpenPlatformFromArgs(
      JSON.stringify({ action: 'employees.wake', agent_code: 'clerk' }),
      { toolCallId: 'eager-wake-contract-1', toolName: 'platform' },
    )
    expect(diag.opened).toBe(false)
    expect(rightStageStore.getSnapshot().tabs.some((t) => t.kind === 'employeeProcess')).toBe(
      false,
    )
    __resetRightPanelContractCache()
  })

  it('用线上真实接口载荷回放：用户抱怨的那 5 个动作都不再自动开右栏', async () => {
    // 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：新增本用例，夹具直接读 __fixture_live_kinds.json（= 重启后线上接口原样返回体）。
    // 为什么：前面几条用例的契约都是我手写的「期望值」，等于自己出题自己判卷。
    // 这条拿**真机返回的字节**灌进前端，验证前端认的就是后端此刻真给的那份 —— 断掉的
    // 恰恰是最常见的「函数层绿、接线层错」那一米。
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const live = JSON.parse(
      fs.readFileSync(path.join(here, '__fixture_live_kinds.json'), 'utf8'),
    )
    // 夹具必须是「真·线上口径」，否则本用例名不副实
    expect(live.ok).toBe(true)
    expect(live.count).toBe(8)
    expect(live.autoOpenActions).not.toContain('tasks.update')
    expect(live.readOnlyActions).toHaveLength(21)

    const { __resetRightPanelContractCache, loadRightPanelContract } = await import(
      '../src/lib/right-stage/right-panel-contract.ts'
    )
    const { tryEagerAutoOpenPlatformFromArgs } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')

    __resetRightPanelContractCache()
    const prevFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(live), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    let contract
    try {
      contract = await loadRightPanelContract()
    } finally {
      globalThis.fetch = prevFetch
    }
    expect(contract.ok).toBe(true)
    // 前端吃进去的条数必须与线上一致（证明字段名透传没丢）
    expect(contract.autoOpenActions).toHaveLength(13)
    expect(contract.readOnlyActions).toHaveLength(21)

    // 用户投诉「右侧突然展开」的那几个动作：只读类必须不再开
    const readOnlyComplaints = [
      'tasks.list',
      'employees.list',
      'employees.get',
      'employees.brief',
      'tasks.get',
      'workflow.run_status',
    ]
    for (const action of readOnlyComplaints) {
      rightStageStore.hideAll()
      rightStageStore.expand()
      const before = rightStageStore.getSnapshot().tabs.length
      const diag = tryEagerAutoOpenPlatformFromArgs(
        JSON.stringify({ action, agent_code: 'clerk', task_id: 't-1' }),
        { toolCallId: `live-ro-${action}`, toolName: 'platform' },
      )
      expect(diag.opened, `${action} 不该自动开右栏`).toBe(false)
      expect(rightStageStore.getSnapshot().tabs.length).toBe(before)
    }

    // 真在办事的写动作仍要开：能力没被砍掉
    rightStageStore.hideAll()
    const wake = tryEagerAutoOpenPlatformFromArgs(
      JSON.stringify({ action: 'employees.wake', agent_code: 'clerk' }),
      { toolCallId: 'live-wake-1', toolName: 'platform' },
    )
    expect(wake.opened).toBe(true)

    __resetRightPanelContractCache()
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

describe('workflow.run CTA 升级右栏', () => {
  it('旧 route=/apps 升成 collab-workflow，不整窗跳菜单', async () => {
    const { parsePlatformUiFeedback, activatePlatformFeedbackAction } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.hideAll()
    const ui = parsePlatformUiFeedback(
      JSON.stringify({
        ok: true,
        action: 'workflow.run',
        task_id: 'mt-apps-legacy-1',
        ui: {
          kind: 'success',
          title: '已启动工作流',
          domain: 'workflow',
          action: 'workflow.run',
          entityId: 'mt-apps-legacy-1',
          actions: [{ label: '打开工作流', route: '/apps' }],
        },
      }),
    )
    expect(ui?.actions?.[0]?.openStage?.kind).toBe('collab-workflow')
    expect(ui?.actions?.[0]?.openStage?.data?.mainTaskId).toBe('mt-apps-legacy-1')
    expect(ui?.actions?.[0]?.route).toBeFalsy()
    expect(
      activatePlatformFeedbackAction(ui.actions[0], {
        domain: 'workflow',
        action: 'workflow.run',
        entityId: 'mt-apps-legacy-1',
      }),
    ).toBe(true)
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs.some((t) => t.kind === 'collab-workflow')).toBe(true)
    expect(String(snap.surface?.data?.mainTaskId || '')).toBe('mt-apps-legacy-1')
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

  it('发消息后不清 seen：同 toolCallId 不再 toast', () => {
    // 模拟 handle-send 旧 bug：每发清空 seen → 历史平台结果再弹。
    // 正确行为：seen 跨回合保留，RESULT / tools-scan 同 id 只补 autoOpen、不 publish/toast。
    const seen = new Set()
    const publish = vi.fn()
    const toast = vi.fn()
    const content = JSON.stringify({
      ok: true,
      action: 'employees.hire',
      ui: {
        kind: 'success',
        title: '已添加智能体员工「小助手」',
        domain: 'employees',
        action: 'employees.hire',
      },
    })
    expect(
      publishPlatformFromAgUiResult({
        isBackground: false,
        aguiEvent: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'tc-hire-sticky',
          toolCallName: 'platform',
          content,
        },
        platformFeedbackSeenRef: { current: seen },
        turnPlatformEntriesRef: { current: [] },
        publishPlatformEntries: publish,
        toast,
      }),
    ).toBe(true)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)

    // 模拟「下一轮发送」：seen 保留（不再 new Set()）
    publish.mockClear()
    toast.mockClear()
    expect(
      publishPlatformFromAgUiResult({
        isBackground: false,
        aguiEvent: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'tc-hire-sticky',
          toolCallName: 'platform',
          content,
        },
        platformFeedbackSeenRef: { current: seen },
        turnPlatformEntriesRef: { current: [] },
        publishPlatformEntries: publish,
        toast,
      }),
    ).toBe(true)
    expect(toast).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
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
