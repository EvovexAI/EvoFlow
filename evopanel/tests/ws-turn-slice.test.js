import { describe, expect, it } from 'vitest'
import { sliceMessagesForCurrentTurn } from '../src/lib/ws-client.js'

describe('sliceMessagesForCurrentTurn', () => {
  it('returns only current turn assistant text after new user', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'old answer body' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'old answer body new reply only' },
    ]
    const slice = sliceMessagesForCurrentTurn(messages)
    expect(slice.humanIdx).toBe(2)
    expect(slice.prevAssistantPrefix).toContain('old answer')
    expect(slice.assistantText).toBe('new reply only')
    expect(slice.assistantText).not.toContain('old answer body new')
  })

  it('does not include prior turn tool_calls when only prev assistant follows new user', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1', tool_calls: [{ id: 'tc-old', name: 'search' }] },
      { role: 'user', content: 'q2' },
    ]
    const slice = sliceMessagesForCurrentTurn(messages)
    expect(slice.toolCalls).toBeNull()
  })

  it('strips stopped prior assistant when user sends continue', () => {
    const prior =
      '关于 AI 编程工具的一些随想\n\n第二个误区：不加思考地全盘接受 AI 的输出。这不仅仅是'
    const messages = [
      { role: 'user', content: '写一篇长文' },
      { role: 'assistant', content: prior },
      { role: 'user', content: '继续回复我' },
      { role: 'assistant', content: `${prior}好的，那我随便聊聊，凑够2000字。` },
    ]
    const slice = sliceMessagesForCurrentTurn(messages)
    expect(slice.assistantText).toBe('好的，那我随便聊聊，凑够2000字。')
    expect(slice.assistantText).not.toContain('第二个误区')
  })

  it('includes tool_calls after new user when graph progressed', () => {
    const messages = [
      { role: 'user', content: 'q2' },
      { role: 'assistant', tool_calls: [{ id: 'tc-new', name: 'read_file', args: { path: 'a' } }] },
      { role: 'tool', tool_call_id: 'tc-new', content: 'ok' },
    ]
    const slice = sliceMessagesForCurrentTurn(messages)
    expect(slice.toolCalls).toHaveLength(1)
    expect(slice.toolCalls[0].id).toBe('tc-new')
  })
})
