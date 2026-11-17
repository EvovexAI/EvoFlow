/**
 * 【self-evolution-bot · 2026-11-17 · 第33轮】
 * V4 面板 search_code_index 卡片必须可分派到**能展开**的专属渲染器。
 *
 * 缺陷现场：用户报「调用 search_code_index 后只能看到工具被调用了，
 * 看不到下拉的搜索结果，点击也无法展开」。
 * 根因：`resolveLegacyKindFamily` 把 `search_code_index` 判进 `search` family，
 * `resolveToolCallRenderer` 返回 `SearchToolCallBlock`，而它写死
 * `canToggle={false}` + `content={null}` → 永久不可展开。
 *
 * 这两条断言就是那次事故的红线：
 *   1. search_code_index → SearchCodeIndexToolCallBlock（不是 SearchToolCallBlock）
 *   2. 同 family 的普通 search / search_content 仍走 SearchToolCallBlock（别改坏别人）
 */
import { describe, expect, it } from 'vitest'
import { resolveToolCallRenderer } from '../src/zcode-ui/ToolCallBlocks/resolveRenderer.ts'
import {
  isSearchCodeIndexToolCall,
  SearchCodeIndexToolCallBlock,
} from '../src/zcode-ui/ToolCallBlocks/renderers/search-code-index.tsx'
import { SearchToolCallBlock } from '../src/zcode-ui/ToolCallBlocks/renderers/search.tsx'
import type { ToolCallBlockRenderContext } from '../src/zcode-ui/ToolCallBlocks/fileSummaryTypes.ts'

function makeContext(toolName: string, input: unknown = {}): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      toolCall: {
        toolId: `tool-${toolName}`,
        toolName,
        // kind 的真实类型是 string | null（fileSummaryTypes.ts:306）。
        // 早先这里写成数组，导致 isCuaToolCall → normalizeToolName 调 .trim() 抛
        // TypeError，看起来像产品 bug，其实是夹具不合契约。
        kind: toolName,
        title: toolName,
        input,
        status: 'completed',
        output: 'Symbols:\n  - function foo @ a.py:1',
      },
    },
    workspacePath: '/w',
    displayModel: {
      inlinePreview: { type: 'none' },
      planResult: null,
      viewerSource: null,
      viewerLabelId: 'codeViewer.viewCode',
      showSummaryFileLink: false,
      showInput: false,
      showOutput: true,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: '',
    childToolList: null,
  } as unknown as ToolCallBlockRenderContext
}

describe('V4 search_code_index 工具卡可展开', () => {
  it('search_code_index 分派到专属卡，而不是不可展开的 SearchToolCallBlock', () => {
    const renderer = resolveToolCallRenderer(makeContext('search_code_index', { query: 'foo bar' }))
    expect(renderer).toBe(SearchCodeIndexToolCallBlock)
    // 反证锚点：旧行为就是返回这个，改回去必须立刻红。
    expect(renderer).not.toBe(SearchToolCallBlock)
  })

  it('同 family 的普通检索工具不受影响（仍走一行式 SearchToolCallBlock）', () => {
    expect(resolveToolCallRenderer(makeContext('search', { query: 'x' }))).toBe(SearchToolCallBlock)
    expect(resolveToolCallRenderer(makeContext('search_content', { pattern: 'x' }))).toBe(
      SearchToolCallBlock,
    )
    expect(resolveToolCallRenderer(makeContext('grep', { pattern: 'x' }))).toBe(SearchToolCallBlock)
  })

  it('工具名识别只认 search_code_index，不误伤 search_content / search', () => {
    expect(isSearchCodeIndexToolCall({ toolName: 'search_code_index' })).toBe(true)
    expect(isSearchCodeIndexToolCall({ toolName: 'SEARCH_CODE_INDEX' })).toBe(true)
    expect(isSearchCodeIndexToolCall({ toolName: 'search_content' })).toBe(false)
    expect(isSearchCodeIndexToolCall({ toolName: 'search' })).toBe(false)
    expect(isSearchCodeIndexToolCall({ toolName: 'grep' })).toBe(false)
  })
})
