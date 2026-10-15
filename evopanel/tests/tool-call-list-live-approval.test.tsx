import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ToolCallList } from '../src/react/components/ToolCallList.tsx'

afterEach(cleanup)

/** 实时流路径(toolEntryFromAgUi + pending RESULT)产出的工具行形状。 */
function livePendingTool() {
  const envelope = JSON.stringify({
    _evoflow_tool: { status: 'pending_approval' },
    message: '[pending_approval] terminal（echo x）尚未执行，等待用户授权。',
    approval: {
      title: '需要您的授权',
      tool_name: 'terminal',
      tool_call_id: 'call_x',
      summary: 'echo x',
      risk: 'confirm',
    },
  })
  return {
    id: 'call_x',
    tool_call_id: 'call_x',
    name: 'terminal',
    type: 'tool_call',
    status: 'pending_approval',
    function: { name: 'terminal', arguments: '{"command": "echo x"}' },
    content: envelope,
    output: envelope,
    _aguiPhase: 'done',
    _aguiTracked: true,
  }
}

describe('ToolCallList 实时审批挂起渲染', () => {
  it('pending 工具行渲染 .msg-tool + 内联审批卡片(最小 props)', () => {
    const calls: Array<[string, string?]> = []
    const { container } = render(
      <ToolCallList
        tools={[livePendingTool()]}
        filterIds={['call_x']}
        nestedInExploring
        activityGrouped={false}
        isStreaming={false}
        interactiveToolApproval
        onToolApproval={(action, id) => calls.push([action, id])}
      />,
    )
    const toolEl = container.querySelector('.msg-tool')
    expect(toolEl, 'tool entry should render').toBeTruthy()
    const inline = container.querySelector('.msg-tool-approval-inline')
    expect(inline, 'inline approval card should render').toBeTruthy()
  })

  it('app 全量 props(含 isStreaming/hideSubagentInnerTools/terminalStreams)下仍渲染', () => {
    const { container } = render(
      <ToolCallList
        tools={[livePendingTool()]}
        filterIds={['call_x']}
        subagentTasks={{}}
        terminalStreams={{}}
        onToolApproval={() => {}}
        toolApprovalBusy={false}
        interactiveToolApproval
        hideSubagentInnerTools
        nestedInExploring
        activityGrouped={false}
        isStreaming
        showToolTiming
        sessionKey="sess-1"
        compareLogSource="exploring#0"
        compareSessionKey="sess-1"
      />,
    )
    expect(container.querySelector('.msg-tool'), 'tool entry should render with app props').toBeTruthy()
    expect(container.querySelector('.msg-tool-approval-inline')).toBeTruthy()
  })
})
