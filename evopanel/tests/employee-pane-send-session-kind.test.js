/**
 * 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 回归测试：员工面板「发送」不允许落到 task 会话。
 * **必须从源码导入**，不许在测试里复制一份等价逻辑 —— 第一版我复制了，
 * 结果「把护栏改成 if(false) 测试仍 5 passed」，等于没测。
 *
 * 现网事故（2026-11-21 19:40 真机实证）：
 *   同时给个人助理 + 审核员发消息。个人助理正常；审核员面板毫无反应。
 *   查库发现它其实收到并回答了 ——
 *     thread 517144f5 / `proactive:reviewer:task:2611202007_de39`
 *       19:40:28 user「只说一句：你的岗位叫什么？不超过10个字。」
 *       19:40:31 assistant「审核员」
 *   而面板显示的是 chat 会话 `proactive:reviewer:chat:dept-e52862be9e71`
 *   （thread ce27a8d1，只有 3 条、停在昨天 20:07）。
 *   根因：panel surface 带着昨天任务的 taskId → pickProactiveConversationSessionKey 的
 *   taskId 分支（kind==='task'）排在最前 → 面板绑定 task 会话 → 对话消息写进任务时间线。
 *   更坏：后端回执的 session_key 是调用方传的 chat key，看起来完全正确，纯属误导。
 */

import { describe, expect, it } from 'vitest'
import {
  isTaskTimelineSessionKey,
  resolveSendSessionKeyForChat,
} from '../src/lib/right-stage/employee-send-session-kind.ts'

describe('isTaskTimelineSessionKey', () => {
  it('task 会话必须被拒（现网事故复现）', () => {
    expect(isTaskTimelineSessionKey('proactive:reviewer:task:2611202007_de39')).toBe(true)
  })

  it('chat 会话可以发送', () => {
    expect(isTaskTimelineSessionKey('proactive:reviewer:chat:dept-e52862be9e71')).toBe(false)
  })

  it('duty 会话可以发送（轮次值班不是任务时间线）', () => {
    expect(isTaskTimelineSessionKey('proactive:reviewer:duty:2601011200')).toBe(false)
  })

  it('空值不算 task 会话', () => {
    expect(isTaskTimelineSessionKey('')).toBe(false)
    expect(isTaskTimelineSessionKey(null)).toBe(false)
    expect(isTaskTimelineSessionKey(undefined)).toBe(false)
  })

  it('形状边界：只认 :task: 段，不误伤含 task 字样的 chat 会话', () => {
    expect(isTaskTimelineSessionKey('proactive:task-runner:chat:abc123')).toBe(false)
    expect(isTaskTimelineSessionKey('proactive:reviewer:chat:task-dept')).toBe(false)
  })
})

describe('resolveSendSessionKeyForChat', () => {
  it('正常 chat 会话原样保留，不触发切换', () => {
    const r = resolveSendSessionKeyForChat({
      candidate: 'proactive:reviewer:chat:dept-e52862be9e71',
      fallback: 'proactive:reviewer:chat:fresh',
    })
    expect(r.sk).toBe('proactive:reviewer:chat:dept-e52862be9e71')
    expect(r.switchedFrom).toBe('')
  })

  it('task 会话被拒并改用 fallback（现网事故的修复点）', () => {
    const r = resolveSendSessionKeyForChat({
      candidate: 'proactive:reviewer:task:2611202007_de39',
      fallback: 'proactive:reviewer:chat:fresh',
    })
    expect(r.sk).toBe('proactive:reviewer:chat:fresh')
    expect(r.switchedFrom).toBe('proactive:reviewer:task:2611202007_de39')
  })

  it('candidate 为空时保持为空（交给上层 mint），不误判成 task', () => {
    const r = resolveSendSessionKeyForChat({ candidate: '', fallback: 'x' })
    expect(r.sk).toBe('')
    expect(r.switchedFrom).toBe('')
  })
})
