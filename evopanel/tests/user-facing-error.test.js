import { describe, it, expect } from 'vitest'
import { isConnectivityToastNoise, toUserFacingError } from '../src/lib/user-facing-error.js'

describe('toUserFacingError', () => {
  it('keeps already friendly Chinese messages', () => {
    expect(toUserFacingError('上一条消息仍在处理中，请稍候')).toBe(
      '上一条消息仍在处理中，请稍候',
    )
  })

  it('maps thread_id jargon', () => {
    expect(toUserFacingError('无法获取会话 thread_id')).toBe('会话尚未就绪，请稍后重试')
  })

  it('maps Volc Ark tool-pair mismatch (11148) away from raw JSON', () => {
    const raw =
      'upstream 400: {"code":11148,"msg":"tool calls and tool results do not match, please start a new conversation and retry","retry_policy":{"retry":false}}'
    expect(toUserFacingError(raw)).toBe('对话里的工具调用记录不完整，请新建对话后再试')
  })

  it('maps zh Incomplete tool records displayMsg', () => {
    expect(toUserFacingError('工具记录不完整，请新建任务')).toBe(
      '对话里的工具调用记录不完整，请新建对话后再试',
    )
  })

  it('maps python TypeError from backend', () => {
    expect(
      toUserFacingError(
        "ContextCompactionEngine.should_compress() got an unexpected keyword argument 'protect_first_n'",
      ),
    ).toBe('对话整理失败，请稍后重试')
  })

  it('maps gateway errors', () => {
    const out = toUserFacingError('请重启 EvoFlow Gateway 后重试')
    // DEV appends a raw snippet so toast is not a black box; prod keeps the short tip.
    expect(out === '服务连接异常，请确认服务已启动后重试' || out.startsWith('服务连接异常：')).toBe(
      true,
    )
  })

  it('maps Failed to fetch with actionable tip', () => {
    const out = toUserFacingError('Failed to fetch')
    expect(out).toMatch(/无法连接本地服务|网络连接异常/)
  })

  it('maps fetch failures', () => {
    expect(toUserFacingError('GET live-run failed: 404')).toBe('暂时无法加载对话，请刷新后重试')
  })

  it('maps cold-start v4 subscribe 404 away from generic fallback', () => {
    expect(toUserFacingError('v4 /api/v4/conversation/subscribe failed: HTTP 404')).toBe(
      '会话服务正在启动，请稍后重试',
    )
    expect(toUserFacingError('POST /api/v4/conversation/subscribe :: Not Found')).toBe(
      '会话服务正在启动，请稍后重试',
    )
  })

  it('returns fallback for stack traces', () => {
    expect(toUserFacingError('Error\n  File "foo.py", line 1')).toBe('操作失败，请稍后重试')
  })

  it('suppresses user_interrupt variants (underscore/space/camel)', () => {
    expect(toUserFacingError('user_interrupt')).toBe('')
    expect(toUserFacingError('user interrupt')).toBe('')
    expect(toUserFacingError('UserInterrupt')).toBe('')
    expect(toUserFacingError('User interrupted the run')).toBe('')
  })

  it('maps bare run_error / model disconnect to actionable Chinese', () => {
    expect(toUserFacingError('run_error')).toMatch(/模型服务中断|负载过高|开新会话/)
    expect(
      toUserFacingError('httpx.RemoteProtocolError: Server disconnected without sending a response.'),
    ).toMatch(/模型服务中断|负载过高|开新会话/)
  })

  // 【self-evolution-bot · 2026-11-21 · 第115轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：为「上游只回一句通用英文错误」这一档加回归断言。
  // 为什么：2026-11-21 23:26:49 文档撰写师第二轮真实失败，上游回
  //   "An internal error occurred"；旧实现把它原样投给用户（无原因、无下一步）。
  //   实测同一句重发一次即成功，故文案必须含「再发一次」。
  // 反证边界：带冒号细节 / 带中文 / 超长的原文不得被本档吞掉。
  it('maps generic upstream error to actionable retry copy', () => {
    const out = toUserFacingError('An internal error occurred')
    expect(out).toMatch(/临时内部错误/)
    expect(out).toMatch(/再发一次/)
    // 不得把英文原文直接当文案投出去
    expect(out).not.toMatch(/internal error occurred/i)
  })

  it('maps generic upstream error case/dot variants', () => {
    expect(toUserFacingError('an internal error occurred.')).toMatch(/再发一次/)
    expect(toUserFacingError('Internal Server Error occurred')).toMatch(/再发一次/)
    expect(toUserFacingError('Something went wrong')).toMatch(/再发一次/)
  })

  it('does not swallow upstream errors that still carry detail', () => {
    // 带冒号后跟具体细节 —— 必须保留可归因信息，不得并进通用档
    const detailed = toUserFacingError(
      'an internal error occurred: tool schema invalid for knowledge',
    )
    expect(detailed).not.toMatch(/临时内部错误/)
    // 带中文的原文说明上游已给本地化信息，也不并档
    const cjk = toUserFacingError('An internal error occurred 请联系管理员')
    expect(cjk).not.toMatch(/临时内部错误/)
  })

  it('marks gateway connectivity copy as toast noise', () => {
    expect(isConnectivityToastNoise('服务连接异常，请确认服务已启动后重试')).toBe(true)
    expect(isConnectivityToastNoise('服务连接异常：gateway warming')).toBe(true)
    expect(isConnectivityToastNoise('服务未启动或暂时不可用，请检查服务状态')).toBe(true)
    expect(isConnectivityToastNoise('无法连接本地服务，请确认 Gateway（8070）与前端已启动')).toBe(
      true,
    )
    expect(isConnectivityToastNoise('上一条消息仍在处理中，请稍候')).toBe(false)
  })
})
