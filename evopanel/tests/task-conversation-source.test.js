/**
 * 任务详情「对话」面板读哪条会话 —— 不许把别处的对话挂在任务名下。
 *
 * 【self-evolution-bot · 2026-11-22 · 第125轮 · 模型:deepseek-v4.1-flash】
 * 现网实证（2026-11-22 18:5x，直接打网关接口取证）：
 *   · task 2611221757_60a8（执行人 case-fullstack-dev）
 *     task.thread_id = 8bcaa342 → by-thread 回 sessionKey
 *     `proactive:case-fullstack-dev:chat:dept-28baad343765`，28 条普通聊天；
 *   · 该任务真正的执行记录在 `proactive:case-fullstack-dev:task:2611221757_60a8`
 *     （task 桶，5 条）里；
 *   · 全库 40 条带 thread_id 的任务中 **16 条** thread 指向的不是 task 桶。
 * 于是「续聊」按 task 桶跳、「对话」面板按 thread 读 → 同页两处指向不同会话，用户说「误导别人」。
 */

import { describe, expect, it } from 'vitest'
import {
  proactiveTaskSessionKey,
  isOwnTaskConversation,
  pickTaskConversationSource,
} from '../src/lib/task-conversation-source.js'

const AGENT = 'case-fullstack-dev'
const TASK = '2611221757_60a8'
const TASK_SK = `proactive:${AGENT}:task:${TASK}`
const CHAT_SK = `proactive:${AGENT}:chat:dept-28baad343765`
const MSGS = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }))

describe('proactiveTaskSessionKey', () => {
  it('与后端 proactive_task_session_key 同口径', () => {
    expect(proactiveTaskSessionKey(AGENT, TASK)).toBe(TASK_SK)
  })

  it('任务 id 里的非法字符按后端 _sanitize_session_suffix 同规则替换', () => {
    expect(proactiveTaskSessionKey('a', 'x:y/z\\w')).toBe('proactive:a:task:x-y-z-w')
  })

  it('缺参数返回空串（不许拼出半截 key 去打接口）', () => {
    expect(proactiveTaskSessionKey('', TASK)).toBe('')
    expect(proactiveTaskSessionKey(AGENT, '')).toBe('')
  })
})

describe('isOwnTaskConversation', () => {
  it('同员工会话算自家（可展示但需标来源）', () => {
    expect(isOwnTaskConversation(CHAT_SK, AGENT)).toBe(true)
  })

  it('主智能体主会话算自家', () => {
    expect(isOwnTaskConversation('agent:main', AGENT)).toBe(true)
    expect(isOwnTaskConversation('agent:main:task-123', AGENT)).toBe(true)
  })

  it('别的员工的会话不算自家 —— 这条是「误导」的定义', () => {
    expect(isOwnTaskConversation('proactive:douyin-analyst:chat:x', AGENT)).toBe(false)
  })

  it('没有执行人信息 → 无从判定，按原行为放行（不误伤）', () => {
    expect(isOwnTaskConversation(CHAT_SK, '')).toBe(true)
  })
})

describe('pickTaskConversationSource', () => {
  it('执行会话有消息 → 优先用它（用户看到的必须就是真跑的那条）', () => {
    const picked = pickTaskConversationSource({
      taskSessionMessages: MSGS(5),
      threadMessages: MSGS(28),
      sourceSessionKey: CHAT_SK,
      assignedTo: AGENT,
      taskSessionKey: TASK_SK,
    })
    expect(picked.source).toBe('task-session')
    expect(picked.messages).toHaveLength(5)
    expect(picked.mismatchSessionKey).toBe('')
  })

  it('执行会话为空、thread 同员工普通会话 → 展示但标来源（不许冒充本任务记录）', () => {
    const picked = pickTaskConversationSource({
      taskSessionMessages: [],
      threadMessages: MSGS(28),
      sourceSessionKey: CHAT_SK,
      assignedTo: AGENT,
      taskSessionKey: TASK_SK,
    })
    expect(picked.source).toBe('thread-same-agent')
    expect(picked.messages).toHaveLength(28)
  })

  it('执行会话为空、thread 是别人的对话 → 一条都不展示', () => {
    const picked = pickTaskConversationSource({
      taskSessionMessages: [],
      threadMessages: MSGS(28),
      sourceSessionKey: 'proactive:release-engineer:chat:x',
      assignedTo: AGENT,
      taskSessionKey: TASK_SK,
    })
    expect(picked.source).toBe('thread-mismatch')
    expect(picked.messages).toHaveLength(0)
    expect(picked.mismatchSessionKey).toBe('proactive:release-engineer:chat:x')
  })

  it('两处都空 → none（空态文案据此区分「真没跑」）', () => {
    const picked = pickTaskConversationSource({
      taskSessionMessages: [],
      threadMessages: [],
      assignedTo: AGENT,
      taskSessionKey: TASK_SK,
    })
    expect(picked.source).toBe('none')
  })

  it('thread 解析回的就是本任务专用会话 → 归类成 task-session，不许再打「普通会话」提示', () => {
    const picked = pickTaskConversationSource({
      taskSessionMessages: [],
      threadMessages: MSGS(5),
      sourceSessionKey: TASK_SK,
      assignedTo: AGENT,
      taskSessionKey: TASK_SK,
    })
    expect(picked.source).toBe('task-session')
  })
})
