import { describe, expect, it } from 'vitest'
import {
  buildToolApprovalMessage,
  buildToolApprovalReplayMessage,
  collectPendingApprovalsForDock,
  formatToolApprovalPrimaryLine,
  formatUserToolApprovalBubbleText,
  isToolPendingApproval,
  isUserToolApprovalMessage,
  mergePendingApprovalLists,
  parseToolApprovalFromOutput,
  parseToolApprovalFromTool,
  resolveToolApprovalHost,
  toolApprovalInteractiveForItem,
  toolRequiresApproval,
  TOOL_APPROVAL_REPLAY_MARKER,
} from '../src/lib/tool-approval.js'

describe('tool-approval', () => {
  it('formats primary line as operation and path', () => {
    expect(formatToolApprovalPrimaryLine('delete_file', 'outputs/test-file.txt')).toBe(
      '删除文件 · outputs/test-file.txt',
    )
    expect(formatToolApprovalPrimaryLine('terminal', 'rm -rf /tmp/foo')).toBe(
      '终端 · rm -rf /tmp/foo',
    )
  })

  it('builds structured approval message', () => {
    const msg = buildToolApprovalMessage('approve', 'tc_1')
    expect(msg).toContain('__evf_tool_approval_v1__:')
    expect(msg).toContain('"tool_call_id":"tc_1"')
  })

  it('detects pending approval from tool output', () => {
    const output = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: {
        title: '需要您的授权',
        summary: 'rm foo.txt',
        tool_name: 'delete_file',
        tool_call_id: 'tc_1',
      },
    })
    expect(isToolPendingApproval({ name: 'delete_file', id: 'tc_1', output })).toBe(true)
    expect(parseToolApprovalFromOutput(output)?.summary).toBe('rm foo.txt')
  })

  it('does not mark read-only tools pending when output was mis-attached', () => {
    const output = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: {
        tool_name: 'delete_file',
        tool_call_id: 'tc_delete',
        summary: 'outputs/foo.md',
      },
    })
    expect(toolRequiresApproval('list_dir')).toBe(false)
    expect(isToolPendingApproval({ name: 'list_dir', id: 'tc_list', output })).toBe(false)
  })

  it('process requires approval only for action=start', () => {
    expect(toolRequiresApproval('process', { action: 'start', command: 'npm test' })).toBe(true)
    expect(toolRequiresApproval('process', { action: 'log', session_id: 'p1' })).toBe(false)
    expect(toolRequiresApproval('process_start')).toBe(true)
  })

  it('hides internal approval payloads from chat bubbles', () => {
    const msg = buildToolApprovalMessage('grant_all')
    expect(formatUserToolApprovalBubbleText(msg)).toBeNull()
  })

  it('only hosts interactive approval on the active turn', () => {
    const pendingOut = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete_file', tool_call_id: 'tc_old', summary: 'x' },
    })
    const rows = [
      {
        role: 'assistant',
        tools: [{ id: 'tc_old', name: 'delete_file', output: pendingOut, status: 'pending_approval' }],
      },
      { role: 'user', text: buildToolApprovalMessage('approve', 'tc_old') },
      { role: 'assistant', text: '好的' },
    ]
    expect(resolveToolApprovalHost({ rows, streamTools: [], isSending: false })).toEqual({
      kind: 'none',
    })
    expect(
      toolApprovalInteractiveForItem({ kind: 'none' }, { kind: 'row', row: rows[0], i: 0 }),
    ).toBe(false)
    expect(isUserToolApprovalMessage(buildToolApprovalMessage('approve', 'tc_old'))).toBe(true)
  })

  it('builds replay marker after approve flow', () => {
    const msg = buildToolApprovalReplayMessage(['tc_1'])
    expect(msg.startsWith(TOOL_APPROVAL_REPLAY_MARKER)).toBe(true)
    expect(formatUserToolApprovalBubbleText(msg)).toBeNull()
  })

  it('hosts approval on last pending assistant row after refresh', () => {
    const pendingOut = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete_file', tool_call_id: 'tc_1', summary: 'y' },
    })
    const rows = [
      {
        role: 'assistant',
        tools: [{ id: 'tc_1', name: 'delete_file', output: pendingOut, status: 'pending_approval' }],
      },
    ]
    expect(resolveToolApprovalHost({ rows, streamTools: [], isSending: false })).toEqual({
      kind: 'row',
      index: 0,
    })
  })

  it('does not host approval while replay/approve user message is last', () => {
    const pendingOut = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete_file', tool_call_id: 'tc_1', summary: 'y' },
    })
    const rows = [
      {
        role: 'assistant',
        tools: [{ id: 'tc_1', name: 'delete_file', output: pendingOut, status: 'pending_approval' }],
      },
      { role: 'user', text: buildToolApprovalReplayMessage(['tc_1']) },
    ]
    const streamTools = [
      { id: 'tc_1', name: 'delete_file', output: pendingOut, status: 'pending_approval' },
    ]
    expect(resolveToolApprovalHost({ rows, streamTools, isSending: true })).toEqual({
      kind: 'none',
    })
    expect(
      collectPendingApprovalsForDock({ streamTools, rows, isSending: true }),
    ).toEqual([])
  })

  it('mergePendingApprovalLists skips locally resolved ids from stream fallback', () => {
    const stream = [{ tool_call_id: 'tc_1', tool_name: 'delete_file', summary: 'x' }]
    const exclude = new Set(['tc_1'])
    expect(mergePendingApprovalLists([], stream, { excludeToolCallIds: exclude })).toEqual([])
  })

  it('collects pending tools for dock from stream when collab poll is empty', () => {
    const pendingOut = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: {
        tool_name: 'delete_file',
        tool_call_id: 'tc_1',
        summary: 'outputs/demo-config.json',
      },
    })
    const streamTools = [
      { id: 'tc_1', name: 'delete_file', output: pendingOut, status: 'pending_approval' },
    ]
    const dock = collectPendingApprovalsForDock({
      streamTools,
      rows: [{ role: 'user', text: 'hi' }],
      isSending: true,
    })
    expect(dock).toHaveLength(1)
    expect(dock[0].tool_call_id).toBe('tc_1')
    expect(mergePendingApprovalLists([], dock)).toEqual(dock)
  })

  it('parseToolApprovalFromTool does not recurse with pending status', () => {
    const pendingOut = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete', tool_call_id: 'tc_x', summary: 'outputs/x.txt' },
    })
    const tool = { id: 'tc_x', name: 'delete', content: pendingOut, status: 'pending_approval' }
    expect(() => parseToolApprovalFromTool(tool)).not.toThrow()
    expect(parseToolApprovalFromTool(tool)?.summary).toBe('outputs/x.txt')
    expect(isToolPendingApproval(tool)).toBe(true)
  })

  it('hosts approval on stream-only pending while run is paused', () => {
    const pendingOut = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete', tool_call_id: 'tc_stream', summary: 'outputs/x.txt' },
    })
    const streamTools = [
      { id: 'tc_stream', name: 'delete', content: pendingOut, status: 'pending_approval' },
    ]
    expect(
      resolveToolApprovalHost({
        rows: [{ role: 'assistant', text: 'ok', tools: [] }],
        streamTools,
        isSending: false,
      }),
    ).toEqual({ kind: 'stream' })
    expect(parseToolApprovalFromTool(streamTools[0])?.summary).toBe('outputs/x.txt')
    expect(
      toolApprovalInteractiveForItem(
        { kind: 'stream' },
        { kind: 'row', i: 0 },
        { continuedStreamRowIndex: 0 },
      ),
    ).toBe(true)
  })
})

describe('tool-approval-settings session override priority', () => {
  it('prefers explicit session tool_approval_policy over stale effective_tool_approval_policy', async () => {
    const { isEffectiveToolApprovalGrantAll } = await import('../src/lib/tool-approval-settings.js')
    expect(
      isEffectiveToolApprovalGrantAll({
        tool_approval_policy: 'prompt',
        effective_tool_approval_policy: 'grant_all',
      }),
    ).toBe(false)
    expect(
      isEffectiveToolApprovalGrantAll({
        tool_approval_policy: 'grant_all',
        effective_tool_approval_policy: 'prompt',
      }),
    ).toBe(true)
  })

  it('session badge uses explicit grant_all override only', async () => {
    const { isSessionToolApprovalGrantAllOverride } = await import('../src/lib/tool-approval-settings.js')
    expect(
      isSessionToolApprovalGrantAllOverride({
        tool_approval_policy: 'grant_all',
        effective_tool_approval_policy: 'grant_all',
      }),
    ).toBe(true)
    expect(
      isSessionToolApprovalGrantAllOverride({
        effective_tool_approval_policy: 'grant_all',
      }),
    ).toBe(false)
    expect(
      isSessionToolApprovalGrantAllOverride({
        tool_approval_policy: 'prompt',
        effective_tool_approval_policy: 'grant_all',
      }),
    ).toBe(false)
  })
})
