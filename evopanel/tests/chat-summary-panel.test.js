import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildProcessItems,
  buildProcessSummary,
  PROCESS_STATE_LABEL,
} from '../src/react/lib/chat-summary-panel-model.ts'
import {
  DEFAULT_CHAT_SUMMARY_SECTIONS,
  loadChatSummaryPrefs,
  normalizeChatSummaryDisplayMode,
  normalizeChatSummaryExpandPolicy,
  normalizeChatSummarySections,
  saveChatSummaryDisplayMode,
  saveChatSummaryExpandPolicy,
  saveChatSummarySections,
} from '../src/react/lib/chat-summary-panel-prefs.ts'

describe('状态面板偏好', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('displayMode 归一化，未知值回落 panel', () => {
    expect(normalizeChatSummaryDisplayMode('capsule')).toBe('capsule')
    expect(normalizeChatSummaryDisplayMode('mini')).toBe('capsule')
    expect(normalizeChatSummaryDisplayMode('hidden')).toBe('hidden')
    expect(normalizeChatSummaryDisplayMode('none')).toBe('hidden')
    expect(normalizeChatSummaryDisplayMode('nonsense')).toBe('panel')
    expect(normalizeChatSummaryDisplayMode(undefined)).toBe('panel')
  })

  it('expandPolicy 归一化，未知值回落 auto-expand', () => {
    expect(normalizeChatSummaryExpandPolicy('sticky')).toBe('sticky')
    expect(normalizeChatSummaryExpandPolicy('sticky_minimized')).toBe('sticky-collapsed')
    expect(normalizeChatSummaryExpandPolicy('weird')).toBe('auto-expand')
  })

  it('读写往返一致', () => {
    saveChatSummaryDisplayMode('capsule')
    saveChatSummaryExpandPolicy('sticky-collapsed')
    saveChatSummarySections({ process: false, agent: true, more: true })

    const prefs = loadChatSummaryPrefs()
    expect(prefs.displayMode).toBe('capsule')
    expect(prefs.expandPolicy).toBe('sticky-collapsed')
    expect(prefs.sections).toEqual({ process: false, agent: true, more: true })
  })

  it('首次无存储时用默认分区：智能体开、进程/更多关', () => {
    const prefs = loadChatSummaryPrefs()
    expect(prefs.displayMode).toBe('panel')
    expect(prefs.sections).toEqual(DEFAULT_CHAT_SUMMARY_SECTIONS)
  })

  it('损坏的 sections JSON 回落默认值而不是抛错', () => {
    localStorage.setItem('evopanel_chat_summary_sections_v1', '{not json')
    expect(normalizeChatSummarySections('{not json')).toEqual(DEFAULT_CHAT_SUMMARY_SECTIONS)
    expect(loadChatSummaryPrefs().sections).toEqual(DEFAULT_CHAT_SUMMARY_SECTIONS)
  })

  it('sections 只接受布尔值，逐项补齐缺失键', () => {
    // 缺省以 DEFAULT 为准：智能体开，进程/更多关
    expect(normalizeChatSummarySections({ agent: true })).toEqual({
      process: false,
      agent: true,
      more: false,
    })
  })

  // v1→v2 布局迁移：老用户 localStorage 里是 {process:true, agent:false}，
  // 光改 DEFAULT 对他们无效，会一直卡在「进程展开、智能体收着」。
  it('老用户 v1 的 sections 会被迁移到新默认（智能体展开）', () => {
    localStorage.setItem('evopanel_chat_summary_sections_v1', JSON.stringify({ process: true, agent: false, more: false }))
    const prefs = loadChatSummaryPrefs()
    expect(prefs.sections).toEqual(DEFAULT_CHAT_SUMMARY_SECTIONS)
    expect(prefs.sections.agent).toBe(true)
    expect(prefs.sections.process).toBe(false)
  })

  it('迁移只发生一次，之后以用户显式设置为准', () => {
    localStorage.setItem('evopanel_chat_summary_sections_v1', JSON.stringify({ process: true, agent: false, more: false }))
    loadChatSummaryPrefs() // 触发迁移，落下 v2 stamp

    // 用户随后自己调成「都收着」——不该被默认值顶回来
    saveChatSummarySections({ process: false, agent: false, more: false })
    expect(loadChatSummaryPrefs().sections).toEqual({ process: false, agent: false, more: false })
  })
})

describe('进程聚合', () => {
  it('三类来源各出一行', () => {
    const items = buildProcessItems({
      terminalStreams: {
        tc1: { toolCallId: 'tc1', phase: 'running', command: 'npm run build' },
      },
      subagentTasks: {
        t1: { taskId: 't1', phase: 'running', description: '写测试' },
      },
      workflowSubtasks: [{ subtaskId: 's1', name: '迁移 CSS', status: 'completed' }],
    })
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.kind).sort()).toEqual(['agent', 'terminal', 'workflow'])
  })

  it('running 排在最前，completed 沉底', () => {
    const items = buildProcessItems({
      terminalStreams: {
        a: { toolCallId: 'a', phase: 'success', command: 'done-cmd' },
        b: { toolCallId: 'b', phase: 'running', command: 'live-cmd' },
      },
    })
    expect(items[0].state).toBe('running')
    expect(items[items.length - 1].state).toBe('completed')
  })

  it('phase=success 但 exitCode 非 0 仍判失败', () => {
    // 后端 phase 可能滞后于 exit 事件，exitCode 才是权威
    const [item] = buildProcessItems({
      terminalStreams: { a: { toolCallId: 'a', phase: 'success', command: 'x', exitCode: 2 } },
    })
    expect(item.state).toBe('failed')
    expect(item.detail).toBe('退出码 2')
  })

  it('同一轮终端多实例按 invocationId 分开，不互相覆盖', () => {
    const items = buildProcessItems({
      terminalStreams: {
        k1: { toolCallId: 'tc1', invocationId: 'i1', phase: 'running', command: 'first' },
        k2: { toolCallId: 'tc1', invocationId: 'i2', phase: 'running', command: 'second' },
      },
    })
    expect(items).toHaveLength(2)
    expect(new Set(items.map((i) => i.id)).size).toBe(2)
  })

  it('长命令压成单行并截断', () => {
    const long = 'echo ' + 'x'.repeat(200)
    const [item] = buildProcessItems({
      terminalStreams: { a: { toolCallId: 'a', phase: 'running', command: `  ${long}\n  ` } },
    })
    expect(item.label.length).toBeLessThanOrEqual(72)
    expect(item.label.endsWith('…')).toBe(true)
    expect(item.label).not.toMatch(/\s{2,}|\n/)
  })

  it('subagent 的 timed_out / cancelled 归入失败 / 取消', () => {
    const items = buildProcessItems({
      subagentTasks: {
        a: { taskId: 'a', phase: 'timed_out' },
        b: { taskId: 'b', phase: 'cancelled' },
      },
    })
    const byId = Object.fromEntries(items.map((i) => [i.id, i.state]))
    expect(byId['agent:a']).toBe('failed')
    expect(byId['agent:b']).toBe('cancelled')
  })

  it('workflow 子任务复用任务中心状态口径', () => {
    const items = buildProcessItems({
      workflowSubtasks: [
        { subtaskId: 's1', name: 'A', status: 'in_progress' },
        { subtaskId: 's2', name: 'B', status: 'failed' },
        { subtaskId: 's3', name: 'C', status: 'planned' },
      ],
    })
    const byId = Object.fromEntries(items.map((i) => [i.id, i.state]))
    expect(byId['workflow:s1']).toBe('running')
    expect(byId['workflow:s2']).toBe('failed')
    expect(byId['workflow:s3']).toBe('pending')
  })

  it('缺 subtaskId 的 workflow 行被丢弃（无稳定 key）', () => {
    const items = buildProcessItems({
      workflowSubtasks: [{ name: '无 id' }, { subtaskId: '  ', name: '空白 id' }],
    })
    expect(items).toHaveLength(0)
  })

  it('summary 计数与胶囊摘要：优先报在跑的那条', () => {
    const s = buildProcessSummary({
      terminalStreams: {
        a: { toolCallId: 'a', phase: 'success', command: 'ok-cmd' },
        b: { toolCallId: 'b', phase: 'running', command: 'live-cmd' },
      },
    })
    expect(s.completed).toBe(1)
    expect(s.total).toBe(2)
    expect(s.running).toBe(1)
    expect(s.capsuleLabel).toBe('live-cmd')
    expect(s.capsuleState).toBe('running')
  })

  it('无进程时胶囊回落 idle 文案', () => {
    const s = buildProcessSummary({}, '空闲')
    expect(s.total).toBe(0)
    expect(s.capsuleLabel).toBe('空闲')
    expect(s.capsuleState).toBe('pending')
  })

  it('无在跑进程时胶囊报最后一个失败', () => {
    const s = buildProcessSummary({
      terminalStreams: { a: { toolCallId: 'a', phase: 'failed', command: 'boom' } },
    })
    expect(s.capsuleState).toBe('failed')
    expect(s.capsuleLabel).toBe('boom')
  })

  it('空输入不抛错', () => {
    expect(buildProcessSummary({})).toEqual({
      items: [],
      completed: 0,
      total: 0,
      running: 0,
      failed: 0,
      capsuleLabel: '空闲',
      capsuleState: 'pending',
    })
  })

  it('每个进程态都有中文标签', () => {
    for (const k of ['running', 'completed', 'failed', 'cancelled', 'pending']) {
      expect(PROCESS_STATE_LABEL[k]).toBeTruthy()
    }
  })
})
