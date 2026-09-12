import { describe, it, expect } from 'vitest'
import { toUserFacingError } from '../src/lib/user-facing-error.js'

describe('toUserFacingError', () => {
  it('keeps already friendly Chinese messages', () => {
    expect(toUserFacingError('上一条消息仍在处理中，请稍候')).toBe(
      '上一条消息仍在处理中，请稍候',
    )
  })

  it('maps thread_id jargon', () => {
    expect(toUserFacingError('无法获取会话 thread_id')).toBe('会话尚未就绪，请稍后重试')
  })

  it('maps python TypeError from backend', () => {
    expect(
      toUserFacingError(
        "ContextCompactionEngine.should_compress() got an unexpected keyword argument 'protect_first_n'",
      ),
    ).toBe('对话整理失败，请稍后重试')
  })

  it('maps gateway errors', () => {
    expect(toUserFacingError('请重启 EvoFlow Gateway 后重试')).toBe(
      '服务连接异常，请确认服务已启动后重试',
    )
  })

  it('maps fetch failures', () => {
    expect(toUserFacingError('GET live-run failed: 404')).toBe('暂时无法加载对话，请刷新后重试')
  })

  it('returns fallback for stack traces', () => {
    expect(toUserFacingError('Error\n  File "foo.py", line 1')).toBe('操作失败，请稍后重试')
  })
})
