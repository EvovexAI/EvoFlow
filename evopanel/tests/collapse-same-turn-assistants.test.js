import { describe, expect, it } from 'vitest'
import {
  assistantLooksMidTurnPartial,
  collapseSameTurnAssistantsInRows,
  earlierToolsSubsetOfLater,
  shouldCollapseSameTurnAssistants,
  shouldMergeFinalIntoPriorAssistant,
} from '../src/react/lib/collapse-same-turn-assistants.ts'

describe('collapseSameTurnAssistantsInRows', () => {
  it('merges mid-turn exploring bubble into final delivery bubble (user DOM repro)', () => {
    const mid = {
      role: 'assistant',
      runId: 'run-ports',
      text: '',
      tools: [
        { id: 't1', name: 'run_terminal', status: 'ok' },
        { id: 't2', name: 'process', status: 'ok' },
        { id: 't3', name: 'process', status: 'ok' },
        { id: 't4', name: 'run_terminal', status: 'error' },
        { id: 't5', name: 'write_file', status: 'ok' },
      ],
      segments: [
        { kind: 'text', text: '我来检查一下前后端服务状态。' },
        { kind: 'tools', ids: ['t1'] },
        { kind: 'text', text: '问题定位：后端 8000 挂了' },
        { kind: 'tools', ids: ['t2', 't3', 't4'] },
        { kind: 'text', text: '用脚本文件方式避免转义。' },
        { kind: 'tools', ids: ['t5'] },
      ],
      timestamp: 1,
    }
    const final = {
      role: 'assistant',
      runId: 'run-ports',
      text: '✅ 服务已恢复，工具菜单页面已重新打开。',
      durationStr: '2m',
      tokenStr: '1.2k',
      tools: [
        { id: 't1', name: 'run_terminal', status: 'ok' },
        { id: 't2', name: 'process', status: 'ok' },
        { id: 't3', name: 'process', status: 'ok' },
        { id: 't4', name: 'run_terminal', status: 'error' },
        { id: 't5', name: 'write_file', status: 'ok' },
        { id: 't6', name: 'run_terminal', status: 'ok' },
        { id: 't7', name: 'run_terminal', status: 'ok' },
        { id: 't8', name: 'run_terminal', status: 'ok' },
        { id: 't9', name: 'run_terminal', status: 'ok' },
        { id: 't10', name: 'run_terminal', status: 'ok' },
        { id: 't11', name: 'run_terminal', status: 'ok' },
        { id: 't12', name: 'run_terminal', status: 'ok' },
      ],
      segments: [
        { kind: 'tools', ids: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'] },
        { kind: 'text', text: '✅ 服务已恢复，工具菜单页面已重新打开。' },
      ],
      timestamp: 2,
    }
    const rows = [
      { role: 'user', text: '工具页挂了', timestamp: 0 },
      mid,
      final,
    ]
    expect(assistantLooksMidTurnPartial(mid)).toBe(true)
    expect(earlierToolsSubsetOfLater(mid, final)).toBe(true)
    expect(shouldCollapseSameTurnAssistants(mid, final)).toBe(true)

    const out = collapseSameTurnAssistantsInRows(rows)
    expect(out.filter((r) => r.role === 'assistant')).toHaveLength(1)
    const asst = out.find((r) => r.role === 'assistant')
    expect(asst?.tools?.length).toBe(12)
    expect(String(asst?.text || '') + JSON.stringify(asst?.segments || [])).toContain('服务已恢复')
    expect(asst?.incompleteStream).not.toBe(true)
  })

  it('does not merge assistants from different user turns', () => {
    const rows = [
      { role: 'user', text: 'a', timestamp: 0 },
      {
        role: 'assistant',
        runId: 'r1',
        text: 'ans1',
        tools: [{ id: 't1', name: 'read' }],
        segments: [
          { kind: 'tools', ids: ['t1'] },
          { kind: 'text', text: 'ans1' },
        ],
        timestamp: 1,
      },
      { role: 'user', text: 'b', timestamp: 2 },
      {
        role: 'assistant',
        runId: 'r2',
        text: 'ans2',
        tools: [{ id: 't2', name: 'read' }],
        segments: [
          { kind: 'tools', ids: ['t2'] },
          { kind: 'text', text: 'ans2' },
        ],
        timestamp: 3,
      },
    ]
    const out = collapseSameTurnAssistantsInRows(rows)
    expect(out.filter((r) => r.role === 'assistant')).toHaveLength(2)
  })

  it('shouldMergeFinalIntoPriorAssistant covers completed mid-turn without incomplete flag', () => {
    const prior = {
      role: 'assistant',
      runId: 'run-1',
      tools: [{ id: 't1', name: 'read' }],
      segments: [
        { kind: 'text', text: '先看一下' },
        { kind: 'tools', ids: ['t1'] },
      ],
    }
    const next = {
      role: 'assistant',
      runId: 'run-1',
      text: '结论好了',
      tools: [
        { id: 't1', name: 'read' },
        { id: 't2', name: 'write' },
      ],
      segments: [
        { kind: 'tools', ids: ['t1', 't2'] },
        { kind: 'text', text: '结论好了' },
      ],
    }
    expect(shouldMergeFinalIntoPriorAssistant(prior, next, 'run-1')).toBe(true)
  })

  it('merges across page seam after older+newer concat (no user between mid and final)', () => {
    const mid = {
      role: 'assistant',
      runId: 'run-seam',
      messageId: 'm-mid',
      tools: [{ id: 't1', name: 'read' }],
      segments: [
        { kind: 'text', text: '先查一下' },
        { kind: 'tools', ids: ['t1'] },
      ],
      timestamp: 1,
    }
    const final = {
      role: 'assistant',
      runId: 'run-seam',
      messageId: 'm-final',
      text: '结论出来了',
      tools: [
        { id: 't1', name: 'read' },
        { id: 't2', name: 'write' },
      ],
      segments: [
        { kind: 'tools', ids: ['t1', 't2'] },
        { kind: 'text', text: '结论出来了' },
      ],
      timestamp: 2,
    }
    // Older page had user+mid; newer page started at final — after concat:
    const rows = [
      { role: 'user', text: '帮我看下', timestamp: 0, messageId: 'm-u' },
      mid,
      final,
    ]
    const out = collapseSameTurnAssistantsInRows(rows)
    expect(out.filter((r) => r.role === 'assistant')).toHaveLength(1)
  })

  it('folds leading orphan mid+final when page starts mid-turn (no user yet)', () => {
    const mid = {
      role: 'assistant',
      runId: 'run-lead',
      tools: [{ id: 't1', name: 'read' }],
      segments: [
        { kind: 'text', text: '旁白' },
        { kind: 'tools', ids: ['t1'] },
      ],
      timestamp: 1,
    }
    const final = {
      role: 'assistant',
      runId: 'run-lead',
      text: '最终回复',
      tools: [
        { id: 't1', name: 'read' },
        { id: 't2', name: 'read' },
      ],
      segments: [
        { kind: 'tools', ids: ['t1', 't2'] },
        { kind: 'text', text: '最终回复' },
      ],
      timestamp: 2,
    }
    const rows = [
      mid,
      final,
      { role: 'user', text: '下一问', timestamp: 3 },
      {
        role: 'assistant',
        runId: 'run-next',
        text: '另一轮',
        tools: [],
        segments: [{ kind: 'text', text: '另一轮' }],
        timestamp: 4,
      },
    ]
    const out = collapseSameTurnAssistantsInRows(rows)
    expect(out.filter((r) => r.role === 'assistant')).toHaveLength(2)
    expect(String(out[0]?.text || '') + JSON.stringify(out[0]?.segments || [])).toContain('最终回复')
  })
})
