import { describe, expect, it } from 'vitest'
import {
  parsePlatformUiFeedback,
  syncPlatformFeedbackFromTools,
  canOpenPlatformFeedbackFromTool,
  mergePlatformRunEntries,
  platformRunEntriesFromChatArtifacts,
  platformUiToRunEntry,
} from '../src/lib/right-stage/platform-feedback.ts'

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
