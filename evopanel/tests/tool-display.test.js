import { describe, it, expect } from 'vitest'
import {
  agentBrowserBriefFromCommand,
  evoflowCliBriefFromCommand,
  formatReadFileBriefWithSource,
  formatReadPathBrief,
  formatReadLineRangeLabel,
  formatSubagentTypeLabel,
  formatToolBriefDetail,
  formatToolDisplayTitle,
  formatActivityDetailFromToolCalls,
  formatActivityDetailFromRunningToolCalls,
  pickLatestRunningToolCall,
  normalizeStreamActivityDetail,
  getToolIcon,
  inferToolNameFromArgs,
  looksLikeSubagentArgs,
  isCoreChatToolName,
  isScenarioToolName,
  resolveAssignedAgentDisplayName,
  resolveEffectiveToolName,
  scenarioSwitchBrief,
  supervisorActionZh,
  toolShortLabel,
  toolTitleDetailTail,
  workerFileActionBriefZh,
} from '../src/lib/tool-display.js'
import {
  formatSubtaskOutcomeReportOutput,
  formatSubtaskWorkChecklistOutput,
} from '../src/lib/collab-tool-display.js'
import { formatToolOutputForUserDisplay } from '../src/lib/chat-normalize.js'

describe('supervisorActionZh', () => {
  it('passes through actions as-is (English UI)', () => {
    expect(supervisorActionZh('create_task')).toBe('create_task')
    expect(supervisorActionZh('start_execution')).toBe('start_execution')
  })
  it('passes through unknown action', () => {
    expect(supervisorActionZh('custom_action')).toBe('custom_action')
  })
})

describe('getToolIcon', () => {
  it('returns icon by tool object', () => {
    expect(getToolIcon({ name: 'supervisor' })).toBe('🧭')
    expect(getToolIcon({ name: 'bash' })).toBe('⌨️')
  })
  it('returns default for unknown', () => {
    expect(getToolIcon({ name: 'some_mcp_tool_xyz' })).toBe('🔧')
  })
})

describe('formatToolDisplayTitle', () => {
  it('formats collab subtask tools with English short labels', () => {
    expect(toolShortLabel('subtask_work_checklist')).toBe('Subtask_work_checklist')
    expect(toolShortLabel('subtask_outcome_report')).toBe('Subtask_outcome_report')
    expect(
      formatToolDisplayTitle({
        name: 'subtask_work_checklist',
        input: { action: 'set', items: [{ content: 'a' }, { content: 'b' }] },
      }),
    ).toContain('set (2)')
    expect(
      formatToolDisplayTitle({
        name: 'subtask_outcome_report',
        input: { outcome: 'completed', summary: '接口已联调通过' },
      }),
    ).toMatch(/completed|已完成/)
    expect(
      formatToolDisplayTitle({
        name: 'subtask_outcome_report',
        input: { outcome: 'completed', summary: '接口已联调通过' },
      }),
    ).toContain('接口已联调')
  })

  it('formats supervisor with English action', () => {
    expect(
      formatToolDisplayTitle({
        name: 'supervisor',
        input: { action: 'create_task', task_name: 'x' },
      }),
    ).toContain('create_task')
    expect(formatToolDisplayTitle({ name: 'supervisor', input: {} })).toBe('Supervisor')
  })
  it('formats common builtins in English', async () => {
    const { setAgentsDisplayCache } = await import('../src/lib/agents-display-cache.js')
    setAgentsDisplayCache([{ agent_code: 'media-artist', agent_name: '美术设计师' }])
    expect(formatToolDisplayTitle({ name: 'read_file', input: { path: '/a' } })).toContain('Read_file')
    expect(formatToolDisplayTitle({ name: 'web_search', input: { query: 'q' } })).toContain('Web_search')
    expect(formatToolDisplayTitle({ name: 'subagent', input: { description: '调研' } })).toContain('Subagent · 调研')
    expect(formatToolDisplayTitle({
      name: 'subagent',
      input: { subagent_type: 'media-artist', description: '生成首帧' },
    })).toContain('美术设计师 · 生成首帧')
    expect(formatToolDisplayTitle({ name: 'task', input: { description: '调研' } })).toContain('Subagent · 调研')
  })
  it('media_video_generate short label uses capitalized tool id', async () => {
    const { toolShortLabel, formatToolDisplayTitle } = await import('../src/lib/tool-display.js')
    expect(toolShortLabel('media_video_generate')).toBe('Media_video_generate')
    expect(formatToolDisplayTitle({
      name: 'media_video_generate',
      input: { prompt: 'slow zoom', mode: 'image2video', duration: 5 },
    })).toContain('Media_video_generate')
  })
  it('infers read_file from placeholder name and shows path line range', () => {
    const tool = {
      name: '工具',
      input: {
        path: 'D:\\github\\EvoFlow\\backend\\app\\channels\\manager.py',
        offset: '1300',
        limit: '200',
      },
    }
    expect(resolveEffectiveToolName(tool)).toBe('read')
    expect(formatToolDisplayTitle(tool)).toContain('manager.py')
    expect(formatToolDisplayTitle(tool)).toContain('L1300-1499')
    expect(formatReadPathBrief(tool.input)).toContain('L1300-1499')
    expect(formatReadLineRangeLabel(tool.input)).toBe('L1300-1499')
  })
  it('formats start_line/end_line as Lstart-end', () => {
    expect(formatReadLineRangeLabel({ start_line: 10, end_line: 20 })).toBe('L10-20')
    expect(formatReadPathBrief({ path: 'a.ts', start_line: 10, end_line: 20 })).toBe('a.ts · L10-20')
  })
  it('formats newly added builtins in English', () => {
    expect(formatToolDisplayTitle({ name: 'send_message', input: { text: 'hi' } })).toContain('Send_message')
    expect(formatToolDisplayTitle({ name: 'session_search', input: { query: 'foo' } })).toContain('Session_search')
    expect(formatToolDisplayTitle({ name: 'experience_list', input: {} })).toContain('Experience_list')
  })
  it('formats worker batches in English', () => {
    expect(workerFileActionBriefZh('write')).toBe('write')
    expect(workerFileActionBriefZh('delete')).toBe('delete')
    expect(toolShortLabel('worker')).toBe('Worker')
    expect(
      formatToolDisplayTitle({
        name: 'worker',
        input: { tasks: [{ action: 'search', query: 'auth middleware' }] },
      }),
    ).toBe('Worker · 1 tasks')
    expect(
      formatToolDisplayTitle({
        name: 'worker',
        input: {
          tasks: [
            { action: 'search', query: 'a' },
            { action: 'search', query: 'b' },
          ],
        },
      }),
    ).toBe('Worker · 2 tasks')
  })
  it('formatReadFileBriefWithSource prefixes invocation source', () => {
    expect(
      formatReadFileBriefWithSource({
        path: 'src/a.ts',
        invocation_source: 'post_search',
      }),
    ).toBe('follow-up · src/a.ts')
    expect(
      formatReadFileBriefWithSource({
        path: 'src/a.ts',
        invocation_source: 'prefetch',
      }),
    ).toBe('prefetch · src/a.ts')
  })
  it('formats rg and find_file in English', () => {
    expect(toolShortLabel('rg')).toBe('Rg')
    expect(toolShortLabel('find_file')).toBe('Find_file')
    expect(
      formatToolDisplayTitle({ name: 'rg', input: { pattern: 'TODO', path: 'src' } }),
    ).toBe('Rg · src')
    expect(
      formatToolDisplayTitle({ name: 'find_file', input: { pattern: '*settings*' } }),
    ).toBe('Find_file · *settings*')
  })
})

describe('formatToolBriefDetail', () => {
  it('extracts tail after first separator from display title', () => {
    const title = formatToolDisplayTitle({ name: 'web_extract', input: { url: 'https://example.com' } })
    expect(toolTitleDetailTail(title)).toBe('https://example.com')
    expect(formatToolBriefDetail({ name: 'web_extract', input: { url: 'https://example.com' } }, title)).toBe(
      'https://example.com',
    )
  })
  it('falls back to common input fields when title has no separator', () => {
    expect(
      formatToolBriefDetail({
        name: 'media_voiceover_synthesize',
        input: { prompt: 'welcome narration' },
      }),
    ).toBe('welcome narration')
    expect(
      formatToolBriefDetail({
        name: 'send_message',
        input: { channel: 'telegram', text: 'hello world' },
      }),
    ).toBe('hello world')
    expect(
      formatToolBriefDetail({
        name: 'rg',
        input: { pattern: 'class Foo', path: 'backend' },
      }),
    ).toBe('backend')
  })
  it('returns empty for list-only tools without args', () => {
    expect(formatToolBriefDetail({ name: 'list_assignable_tools', input: {} })).toBe('')
  })
  it('does not fall back to raw task_id / agent_code', () => {
    expect(
      formatToolBriefDetail({
        name: 'mystery_tool',
        input: { task_id: 'Task_12', agent_code: 'code-agent' },
      }),
    ).toBe('')
  })
})

describe('action-router tool briefs (tasks / knowledge / platform)', () => {
  it('formats tasks with readable name and progress, never task_id', () => {
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'progress', task_id: 'Task_12', name: '修登录闪烁', progress: 80 },
      }),
    ).toBe('Tasks · progress · 修登录闪烁 · 80%')
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'progress', task_id: 'Task_12', progress: 40 },
      }),
    ).toBe('Tasks · progress · 40%')
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'state', task_id: 'Task_12', name: '修登录闪烁', status: 'completed' },
      }),
    ).toBe('Tasks · state · 修登录闪烁 · completed')
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'create', name: '修登录闪烁' },
      }),
    ).toBe('Tasks · create · 修登录闪烁')
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'list', status: 'executing', role: '前端' },
      }),
    ).toBe('Tasks · list · executing · 前端')
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'get', task_id: 'Task_12' },
      }),
    ).toBe('Tasks · get')
  })

  it('formats knowledge search/read with query or path leaf', () => {
    expect(
      formatToolDisplayTitle({
        name: 'knowledge',
        input: { action: 'search', query: 'auth middleware' },
      }),
    ).toBe('Knowledge · search · auth middleware')
    expect(
      formatToolDisplayTitle({
        name: 'knowledge',
        input: { action: 'read', paths: ['docs/roles/duty-handbook.md'] },
      }),
    ).toBe('Knowledge · read · duty-handbook.md')
    expect(
      formatToolDisplayTitle({
        name: 'knowledge',
        input: { action: 'ingest', title: '值班手册' },
      }),
    ).toBe('Knowledge · ingest · 值班手册')
  })

  it('formats platform by parsing args_json; never agent_code / ids', () => {
    expect(
      formatToolDisplayTitle({
        name: 'platform',
        input: {
          action: 'knowledge.search',
          args_json: JSON.stringify({ query: '怎么配 MCP' }),
        },
      }),
    ).toBe('Platform · knowledge.search · 怎么配 MCP')
    expect(
      formatToolDisplayTitle({
        name: 'platform',
        input: {
          action: 'items.create',
          args_json: JSON.stringify({ name: '下周发版' }),
        },
      }),
    ).toBe('Platform · items.create · 下周发版')
    expect(
      formatToolDisplayTitle({
        name: 'platform',
        input: {
          action: 'employees.hire',
          args_json: JSON.stringify({ agent_code: 'code-agent', agent_name: '代码助手' }),
        },
      }),
    ).toBe('Platform · employees.hire · 代码助手')
    expect(
      formatToolDisplayTitle({
        name: 'platform',
        input: {
          action: 'employees.hire',
          args_json: JSON.stringify({ agent_code: 'code-agent' }),
        },
      }),
    ).toBe('Platform · employees.hire')
  })
})

describe('toolShortLabel', () => {
  it('maps tools to capitalized English ids', () => {
    expect(toolShortLabel('subagent')).toBe('Subagent')
    expect(toolShortLabel('send_message')).toBe('Send_message')
    expect(toolShortLabel('session_search')).toBe('Session_search')
    expect(toolShortLabel('vision_analyze')).toBe('Vision_analyze')
    expect(toolShortLabel('list_assignable_tools')).toBe('List_assignable_tools')
    expect(toolShortLabel('media_image_generate')).toBe('Media_image_generate')
    expect(toolShortLabel('media_video_generate')).toBe('Media_video_generate')
  })
})

describe('inferToolNameFromArgs (subagent)', () => {
  it('infers subagent from description/prompt when name is generic placeholder', () => {
    expect(
      inferToolNameFromArgs(
        { description: '调研代码结构', prompt: '列出主要模块', subagent_type: 'general-purpose' },
        '工具',
      ),
    ).toBe('subagent')
    expect(
      resolveEffectiveToolName({
        name: '工具',
        input: { description: '调研', prompt: '列出模块', subagent_type: 'general-purpose' },
      }),
    ).toBe('subagent')
  })
})

describe('inferToolNameFromArgs (file tools)', () => {
  it('infers write when only path+content are present under generic name', () => {
    expect(inferToolNameFromArgs({ path: 'a.ts', content: 'hello' }, 'tool')).toBe('write')
  })
  it('infers replace when old_string is present under generic name', () => {
    expect(inferToolNameFromArgs({ path: 'a.ts', old_string: 'x', new_string: 'y' }, 'tool')).toBe(
      'replace',
    )
  })
  it('still infers read for path-only generic args', () => {
    expect(inferToolNameFromArgs({ path: 'a.ts' }, 'tool')).toBe('read')
  })
})

describe('isCoreChatToolName', () => {
  it('matches backend CORE_TOOL_NAMES (+ legacy aliases)', () => {
    expect(isCoreChatToolName('tool_search')).toBe(true)
    expect(isCoreChatToolName('scenario')).toBe(true)
    expect(isCoreChatToolName('ask_clarification')).toBe(true)
    expect(isCoreChatToolName('subagent')).toBe(true)
    expect(isCoreChatToolName('task')).toBe(true)
    expect(isCoreChatToolName('worker')).toBe(true)
    expect(isCoreChatToolName('find')).toBe(true)
    expect(isCoreChatToolName('find_file')).toBe(true)
    expect(isCoreChatToolName('rg')).toBe(true)
    expect(isCoreChatToolName('list_agents')).toBe(false)
    expect(isCoreChatToolName('read')).toBe(true)
    expect(isCoreChatToolName('read_file')).toBe(true)
    expect(isCoreChatToolName('terminal')).toBe(true)
    expect(isCoreChatToolName('bash')).toBe(false)
  })
})

describe('evoflowCliBriefFromCommand', () => {
  it('detects evoflow subcommands in terminal commands', () => {
    expect(evoflowCliBriefFromCommand('evoflow agents list')).toBe('智能体')
    expect(evoflowCliBriefFromCommand('cd backend && uv run evoflow skills list')).toBe('技能')
    expect(evoflowCliBriefFromCommand('echo hi')).toBe(null)
  })

  it('formatToolDisplayTitle keeps terminal command text (English tool id)', () => {
    expect(
      formatToolDisplayTitle({
        name: 'terminal',
        input: { command: 'evoflow agents list' },
      }),
    ).toContain('Terminal · evoflow agents list')
  })

  it('formatToolDisplayTitle includes tasks summary for state/progress', () => {
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'state', status: 'completed', summary: '已按要求回复确认信息' },
      }),
    ).toContain('已按要求回复确认信息')
    expect(
      formatToolDisplayTitle({
        name: 'tasks',
        input: { action: 'progress', progress: 100, summary: '进度已更新' },
      }),
    ).toContain('100%')
  })
})

describe('agentBrowserBriefFromCommand', () => {
  it('detects agent-browser subcommands in terminal commands', () => {
    expect(agentBrowserBriefFromCommand('agent-browser --session evoflow open https://x.com')).toBe('打开')
    expect(agentBrowserBriefFromCommand('agent-browser --session evoflow snapshot -c')).toBe('快照')
    expect(agentBrowserBriefFromCommand('npm install -g agent-browser')).toBe('浏览器')
    expect(agentBrowserBriefFromCommand('echo hi')).toBe(null)
  })

  it('formatToolDisplayTitle keeps agent-browser command text', () => {
    expect(
      formatToolDisplayTitle({
        name: 'terminal',
        input: { command: 'agent-browser --session evoflow snapshot -c' },
      }),
    ).toContain('Terminal · agent-browser --session evoflow snapshot -c')
  })

  it('formatToolDisplayTitle handles fetch_url', () => {
    expect(
      formatToolDisplayTitle({
        name: 'fetch_url',
        input: { url: 'https://example.com' },
      }),
    ).toContain('Fetch_url · https://example.com')
  })
})

describe('scenarioSwitchBrief', () => {
  it('formats activate/deactivate in English', () => {
    expect(scenarioSwitchBrief({ action: 'activate', scenario_key: 'plan' })).toBe('mode_set · activate · plan')
    expect(scenarioSwitchBrief({ action: 'deactivate', scenario_key: 'web' })).toBe('mode_set · deactivate · agent')
    expect(isScenarioToolName('scenario')).toBe(true)
    expect(isScenarioToolName('scenario_activation')).toBe(true)
    expect(isScenarioToolName('read_file')).toBe(false)
  })
  it('formatToolDisplayTitle uses English scenario fields', () => {
    expect(
      formatToolDisplayTitle({
        name: 'scenario',
        input: { action: 'activate', scenario_key: 'workspace', reason: 'long reason' },
      }),
    ).toBe('Scenario · activate · workspace')
  })
})

describe('collab subtask tool output', () => {
  it('maps checklist JSON to markdown table', () => {
    const out = formatSubtaskWorkChecklistOutput(
      JSON.stringify({
        ok: true,
        action: 'set',
        count: 2,
        tableMarkdown: '| # | 状态 | 步骤 |\n| 1 | 待处理 | 读代码 |',
      }),
    )
    expect(out).toContain('| # | 状态 |')
  })

  it('maps outcome report JSON and input summary', () => {
    const out = formatSubtaskOutcomeReportOutput(
      JSON.stringify({ ok: true, status: 'completed', message: '子任务终态已写入' }),
      { outcome: 'completed', summary: '全部测试通过' },
    )
    expect(out).toContain('终态：已完成')
    expect(out).toContain('全部测试通过')
    expect(formatToolOutputForUserDisplay(
      JSON.stringify({ ok: true, status: 'completed', message: 'ok' }),
      'subtask_outcome_report',
    )).toContain('已完成')
  })

  it('formatActivityDetailFromToolCalls uses English tool labels', () => {
    expect(formatActivityDetailFromToolCalls([{ name: 'search_code_index' }])).toBe(
      'calling: Search_code_index',
    )
  })

  it('formatActivityDetailFromRunningToolCalls omits completed tools and keeps only latest', () => {
    expect(
      formatActivityDetailFromRunningToolCalls([
        { name: 'write_file', status: 'completed' },
        { name: 'read_file', status: 'running' },
      ]),
    ).toBe('calling: Read_file')
    expect(
      formatActivityDetailFromRunningToolCalls([
        { name: 'read_file', status: 'completed' },
      ]),
    ).toBe('')
  })

  it('normalizeStreamActivityDetail upgrades legacy execute-tool strings', () => {
    expect(
      normalizeStreamActivityDetail('calling tools…', {
        toolCalls: [{ name: 'search_code_index' }],
      }),
    ).toBe('calling: Search_code_index')
    expect(
      normalizeStreamActivityDetail('调用：🔍 工作区搜索 · 📂 找文件', {
        toolCalls: [{ name: 'search_code_index' }],
      }),
    ).toMatch(/^calling:/)
  })
})

describe('formatSubagentTypeLabel / resolveAssignedAgentDisplayName', () => {
  it('maps hidden builtin claude-code to Claude Code (not raw code)', () => {
    expect(formatSubagentTypeLabel('claude-code')).toBe('Claude Code')
    expect(formatSubagentTypeLabel('claude_session')).toBe('Claude Code')
    expect(resolveAssignedAgentDisplayName('claude-code', [])).toBe('Claude Code')
    expect(resolveAssignedAgentDisplayName('general-purpose', [])).toBe('通用助手')
  })

  it('prefers /api/agents display name when present', () => {
    expect(
      resolveAssignedAgentDisplayName('claude-code', [
        { agent_code: 'claude-code', agent_name: '代码助手' },
      ]),
    ).toBe('代码助手')
  })
})
