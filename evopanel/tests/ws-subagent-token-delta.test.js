/**
 * 工作流节点实时正文：LangGraph custom 通道必须转发 subagent_token_delta。
 *
 * 背景：后端 SubagentExecutor 通过 parent_chat_stream_writer 推 token 级增量
 * （type=subagent_token_delta），前端 mergeSubagentStreamEvent 也认这个类型。
 * 但 ws-client 的 LangGraph custom 分发只列了 5 个 task_* 类型，且**没有**
 * legacy 路径那种「兜底也当 subtask 事件」的分支 → 增量被静默丢弃，
 * 工作流节点只剩派发瞬间写死的「子任务已派发」。
 *
 * 回归护栏：custom 通道新增 subtask 类事件类型时，务必同步这里的白名单。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WS_CLIENT = resolve(process.cwd(), 'src/lib/ws-client.js')
const source = readFileSync(WS_CLIENT, 'utf8')

/** 取出 LangGraph custom 分发里那段 task_* 白名单。 */
function customDispatchTaskTypes() {
  // 该段落在 ws-client 内以 'langgraph_custom_recv' 调试标记为锚点。
  const anchor = source.indexOf("subtaskStreamDebug('langgraph_custom_recv'")
  expect(anchor).toBeGreaterThan(-1)

  // 白名单的 if(...) 紧挨着这个锚点（在它之前）。
  const ifIdx = source.lastIndexOf('if (', anchor)
  expect(ifIdx).toBeGreaterThan(-1)

  // 条件体：从 'if (' 到匹配的 ') {'（跨行）。
  const cond = source.slice(ifIdx + 4, anchor)
  const close = cond.lastIndexOf(')')
  expect(close).toBeGreaterThan(-1)

  return [...cond.slice(0, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

describe('ws-client LangGraph custom channel', () => {
  it('forwards subagent_token_delta so workflow nodes get live text', () => {
    const types = customDispatchTaskTypes()

    expect(types).toContain('subagent_token_delta')
    // 原有 5 个 task_* 类型不能被改掉
    for (const t of [
      'task_started',
      'task_running',
      'task_completed',
      'task_failed',
      'task_timed_out',
    ]) {
      expect(types).toContain(t)
    }
  })

  it('merges subagent_token_delta into liveOutput', () => {
    // mergeSubagentStreamEvent 必须认识这个类型（追加到 liveOutput）
    const merge = readFileSync(
      resolve(process.cwd(), 'src/react/subagent-stream-merge.ts'),
      'utf8',
    )
    expect(merge).toContain("type !== 'subagent_token_delta'")
    expect(merge).toContain('mergeDeltaLiveOutput')
  })
})
