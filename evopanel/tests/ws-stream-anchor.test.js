/**
 * Regression: [user_new, prev_assistant+tools] must not count as graph progress.
 * Logic mirrored from ws-client.js hasGraphProgressBetweenUserAndLastSubstantive.
 */
import { describe, expect, it } from 'vitest'

function isAssistantMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'assistant') return true
  const t = String(m.type || '').trim()
  return t === 'ai' || t === 'AIMessage' || t === 'AIMessageChunk'
}

function isHumanMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'user') return true
  const t = String(m.type || '').trim()
  return t === 'human' || t === 'HumanMessage'
}

function lastSubstantiveIndexAfterHuman(messages, humanIdx) {
  let end = messages.length - 1
  while (end > humanIdx) {
    const m = messages[end]
    if (m?.role === 'system') {
      end--
      continue
    }
    break
  }
  return end
}

function hasGraphProgressBetweenUserAndLastSubstantive(messages, humanIdx) {
  if (!Array.isArray(messages) || humanIdx < 0) return false
  const lastSub = lastSubstantiveIndexAfterHuman(messages, humanIdx)
  if (lastSub <= humanIdx) return false
  if (lastSub === humanIdx + 1 && isAssistantMessage(messages[lastSub])) return false
  if (!isAssistantMessage(messages[lastSub])) return true
  for (let i = humanIdx + 1; i < lastSub; i++) {
    const m = messages[i]
    if (m?.role === 'tool') return true
    if (isHumanMessage(m)) return true
    if (isAssistantMessage(m)) return true
  }
  return false
}

describe('hasGraphProgressBetweenUserAndLastSubstantive', () => {
  it('returns false when new user is immediately followed by previous assistant', () => {
    const messages = [
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '旧回答', tool_calls: [{ id: 'tc-old', name: 'grep' }] },
    ]
    expect(hasGraphProgressBetweenUserAndLastSubstantive(messages, 0)).toBe(false)
  })

  it('returns true when a tool message appears after the new user', () => {
    const messages = [
      { role: 'user', content: '新问题' },
      { role: 'assistant', tool_calls: [{ id: 'tc1', name: 'grep' }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
    ]
    expect(hasGraphProgressBetweenUserAndLastSubstantive(messages, 0)).toBe(true)
  })
})
