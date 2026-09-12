import { describe, expect, it } from 'vitest'
import {
  priorTurnStripBundleFromRows,
  stripPriorTurnPollutants,
} from '../src/react/lib/turn-text-isolation.ts'

describe('prior turn strip on new message after stop', () => {
  it('strips sealed assistant body from cumulative delta', () => {
    const rows = [
      { role: 'user', text: '写一篇' },
      {
        role: 'assistant',
        text: '关于 AI 编程工具的一些随想。第二个误区：不加思考地全盘接受。',
      },
      { role: 'system', text: '生成已停止' },
      { role: 'user', text: '继续' },
    ]
    const bundle = priorTurnStripBundleFromRows(rows)
    const polluted =
      bundle.body + '好的，那我随便聊聊，凑够2000字。关于 AI 编程工具的一些随想。'
    const clean = stripPriorTurnPollutants(polluted, bundle)
    expect(clean).toBe('好的，那我随便聊聊，凑够2000字。')
    expect(clean).not.toContain('第二个误区')
  })
})
