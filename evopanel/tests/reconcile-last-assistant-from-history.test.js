import { describe, expect, it } from 'vitest'
import {
  findAssistantIndexAfterLastUser,
  mergeDbOnlyHistoryRows,
  reconcileLastAssistantInRows,
} from '../src/react/lib/reconcile-last-assistant-from-history.ts'

describe('reconcile-last-assistant-from-history', () => {
  it('findAssistantIndexAfterLastUser prefers matching runId after last user', () => {
    const rows = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'old', runId: 'r1' },
      { role: 'user', text: 'again' },
      { role: 'assistant', text: 'live', runId: 'r2' },
    ]
    expect(findAssistantIndexAfterLastUser(rows, 'r2')).toBe(3)
    expect(findAssistantIndexAfterLastUser(rows, 'r9')).toBe(3)
  })

  it('reconcileLastAssistantInRows replaces local assistant with db row', () => {
    const local = [
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'stream final', runId: 'r1', tokenStr: '12 tok' },
    ]
    const db = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: '',
        runId: 'r1',
        segments: [{ kind: 'text', text: 'db canonical', segIndex: 0 }],
      },
    ]
    const result = reconcileLastAssistantInRows(local, db, 'r1')
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.rows[1].segments?.[0]?.text).toBe('db canonical')
    expect(result.rows[1].tokenStr).toBe('12 tok')
  })

  it('reconcileLastAssistantInRows retries when db assistant not ready', () => {
    const local = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'x', runId: 'r1' }]
    const db = [{ role: 'user', text: 'q' }]
    expect(reconcileLastAssistantInRows(local, db, 'r1')).toEqual({
      status: 'retry',
      reason: 'no_db_assistant',
    })
  })

  it('reconcileLastAssistantInRows reports synced when plain body matches despite segment layout', () => {
    const local = [
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'same answer', runId: 'r1', tools: [] },
    ]
    const db = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: '',
        runId: 'r1',
        segments: [{ kind: 'text', text: 'same answer', segIndex: 0 }],
        tools: [],
      },
    ]
    expect(reconcileLastAssistantInRows(local, db, 'r1')).toEqual({ status: 'synced' })
  })

  it('reconcileLastAssistantInRows applies db row when tool statuses differ', () => {
    const local = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'same answer',
        runId: 'r1',
        incompleteStream: true,
        tools: [{ id: 't1', name: 'read', status: 'running' }],
      },
    ]
    const db = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'same answer',
        runId: 'r1',
        durationStr: '2s',
        tools: [{ id: 't1', name: 'read', status: 'ok' }],
      },
    ]
    const result = reconcileLastAssistantInRows(local, db, 'r1')
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.rows[1].incompleteStream).toBeUndefined()
    expect(result.rows[1].tools?.[0]?.status).toBe('ok')
  })

  it('mergeDbOnlyHistoryRows keeps local incomplete assistant when db not ready', () => {
    const local = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: '冒烟验证全部通过 ✅',
        runId: 'r1',
        incompleteStream: true,
        segments: [{ kind: 'text', text: '冒烟验证全部通过 ✅' }],
      },
    ]
    const db = [{ role: 'user', text: 'q' }]
    const merged = mergeDbOnlyHistoryRows(local, db, 'r1')
    expect(merged).toBe(local)
    expect(merged[1].text).toContain('冒烟验证')
  })

  it('mergeDbOnlyHistoryRows applies db when judgment finished', () => {
    const local = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'stream',
        runId: 'r1',
        incompleteStream: true,
      },
    ]
    const db = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'stream',
        runId: 'r1',
        durationStr: '3s',
        tokenStr: '100 tok',
      },
    ]
    const merged = mergeDbOnlyHistoryRows(local, db, 'r1')
    expect(merged[1].durationStr).toBe('3s')
    expect(merged[1].incompleteStream).toBeUndefined()
  })

  it('reconcile applies db when local misses post-tool wrap-up body', () => {
    const local = [
      { role: 'user', text: '值班' },
      {
        role: 'assistant',
        text: '好的，我来将这个会话思维导图数据添加到知识库。',
        runId: 'r1',
        tools: [{ id: 'c1', name: 'platform', status: 'ok' }],
        segments: [
          { kind: 'text', text: '好的，我来将这个会话思维导图数据添加到知识库。' },
          { kind: 'tools', ids: ['c1'] },
        ],
      },
    ]
    const db = [
      { role: 'user', text: '值班' },
      {
        role: 'assistant',
        text: '好的，我来将这个会话思维导图数据添加到知识库。\n\n本轮值班结束。',
        runId: 'r1',
        tools: [{ id: 'c1', name: 'platform', status: 'ok' }],
        segments: [
          { kind: 'text', text: '好的，我来将这个会话思维导图数据添加到知识库。' },
          { kind: 'tools', ids: ['c1'] },
          { kind: 'text', text: '本轮值班开始。\n\n**结论**：本轮值班结束。' },
        ],
      },
    ]
    const result = reconcileLastAssistantInRows(local, db, 'r1')
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(String(result.rows[1].segments?.at(-1)?.text || '')).toContain('本轮值班结束')
  })
})
