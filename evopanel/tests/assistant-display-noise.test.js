import { describe, it, expect } from 'vitest'
import {
  isStreamExecutionPlanOutline,
  isToolCallPreambleAssistantNoise,
} from '../src/lib/assistant-display-noise.ts'

const searchTools = [{ name: 'search_code_index', args: { query: 'smoke' } }]

describe('isToolCallPreambleAssistantNoise', () => {
  it('hides short narration that cites the tool name', () => {
    expect(
      isToolCallPreambleAssistantNoise('好，直接调 `search_code_index` 搜一次', searchTools),
    ).toBe(true)
    expect(isToolCallPreambleAssistantNoise('调用 search_code_index 查一下', searchTools)).toBe(true)
  })

  it('keeps post-tool directory replies that mention 测试目录', () => {
    expect(
      isToolCallPreambleAssistantNoise('好，测试目录已创建', [{ name: 'terminal' }]),
    ).toBe(false)
  })

  it('keeps substantive answers even when short', () => {
    expect(isToolCallPreambleAssistantNoise('第一段', [{ name: 'read_file' }])).toBe(false)
    expect(
      isToolCallPreambleAssistantNoise('根据 search_code_index 的结果，入口在 main.py', searchTools),
    ).toBe(false)
    expect(isToolCallPreambleAssistantNoise('找到了 3 个相关文件，入口在 main.py', searchTools)).toBe(
      false,
    )
  })

  it('keeps long explanatory text', () => {
    const long =
      '我先说明一下背景：这个仓库里 smoke 测试分散在多个目录。接下来我会用 search_code_index 检索相关路径，然后再读关键文件给你总结。'
    expect(isToolCallPreambleAssistantNoise(long, searchTools)).toBe(false)
  })

  it('ignores text when there are no tools on the row', () => {
    expect(isToolCallPreambleAssistantNoise('好，直接调 search_code_index 搜一次', [])).toBe(false)
  })

  it('keeps stream execution plan outline even with tools context', () => {
    const plan =
      '目标：梳理 smoke 入口。步骤：先搜代码索引再读关键文件。验收：列出路径与调用关系。'
    expect(isStreamExecutionPlanOutline(plan)).toBe(true)
    expect(isToolCallPreambleAssistantNoise(plan, searchTools)).toBe(false)
  })

  it('hides scenario activation narration without citing tool name', () => {
    const scenarioTools = [{ name: 'scenario', args: { action: 'activate', scenario_key: 'workspace' } }]
    expect(
      isToolCallPreambleAssistantNoise(
        '好的，我先确认当前场景，然后开始工作区工具冒烟测试',
        scenarioTools,
      ),
    ).toBe(true)
  })
})
