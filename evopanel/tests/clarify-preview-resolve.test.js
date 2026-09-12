import { describe, it, expect } from 'vitest'
import { stripResolvedAskClarificationFromRows } from '../src/lib/ask-clarification-pending.js'
import {
  coerceClarifyOptionsList,
  findAskClarificationAfterHuman,
  findAskClarificationAwaitingUserInRows,
  findPendingAskClarificationInRows,
  isAskClarificationToolPending,
  isClarificationPreviewRenderable,
  isCommandInterruptOutput,
  clarificationPreviewFromTool,
  isStaleClarificationPreview,
  parseQuestionsJsonBlob,
  repairClarifyQuestionsFromArgs,
  resolveClarificationPreview,
  tryParseClarifyPreviewJson,
  clarificationPreviewJsonFromToolArgs,
} from '../src/lib/clarify-preview-resolve.js'

const MALFORMED_ID =
  ': "topic", "prompt": ""agent teme"具体指什么？", "context": "决定了整支视频的讲解内容方向", ' +
  '"options": ["Agent Team（多智能体团队协作的概念）", "Agent Theme（智能体主题/风格设计）", ' +
  '"Agent Tempo（智能体节奏/速率相关）", "其他（我来说清楚）"]}, ' +
  '{"id": "style", "prompt": "视频风格偏好？", "context": "10秒需要高信息密度", ' +
  '"options": ["炫酷科技感（动态粒子、数据流）", "简洁科普风（信息图表、文字辅助）", ' +
  '"产品或功能演示式", "你定，我相信你的判断"]}, ' +
  '{"id": "audio", "prompt": "配音语言？", "context": "Seedance原生支持音频输出", ' +
  '"options": ["中文配音", "英文配音", "无需配音，纯BGM+字幕"]}]'

describe('coerceClarifyOptionsList', () => {
  it('parses JSON string array from model tool args', () => {
    const raw = '["EvoFlow 自动化营销系统架构详解", "即梦 AI (Jimeng) 视觉生成 API 集成指南", "其他"]'
    expect(coerceClarifyOptionsList(raw)).toEqual([
      'EvoFlow 自动化营销系统架构详解',
      '即梦 AI (Jimeng) 视觉生成 API 集成指南',
      '其他',
    ])
  })
})

describe('tryParseClarifyPreviewJson', () => {
  it('builds legacy single-question preview when options is a JSON string', () => {
    const input = {
      question: '请明确 AI 技术文档的具体方向或主题',
      options:
        '["EvoFlow 自动化营销系统架构详解", "即梦 AI (Jimeng) 视觉生成 API 集成指南", "基于 RPA 的跨平台内容自动分发实现", "其他（请在回复中说明）"]',
    }
    const parsed = tryParseClarifyPreviewJson(
      JSON.stringify({
        title: '补充关键信息',
        question: input.question,
        options: coerceClarifyOptionsList(input.options),
      }),
    )
    expect(parsed?.questions?.length).toBe(1)
    expect(parsed?.questions?.[0]?.options?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('resolveClarificationPreview', () => {
  it('prefers middleware tool output over raw tool input', () => {
    const formatted = JSON.stringify({
      title: '补充关键信息',
      questions: [
        {
          id: 'q1',
          prompt: '请明确方向',
          options: [
            { id: 'opt_1', label: 'A. 方案一' },
            { id: 'opt_2', label: 'B. 方案二' },
          ],
        },
      ],
    })
    const preview = resolveClarificationPreview({
      tools: [
        {
          name: 'ask_clarification',
          input: {
            question: '请明确方向',
            options: '["方案一","方案二"]',
          },
          output: formatted,
        },
      ],
    })
    expect(preview).toBe(formatted)
  })

  it('treats Command interrupt JSON as stale', () => {
    expect(isCommandInterruptOutput('{"kind": "command", "goto": "__end__"}')).toBe(true)
    expect(isStaleClarificationPreview('{"kind": "command", "goto": "__end__"}')).toBe(true)
    const preview = resolveClarificationPreview({
      tools: [
        {
          name: 'ask_clarification',
          input: { question: 'Q?', options: '["a","b"]' },
          output: '{"kind": "command", "goto": "__end__"}',
        },
      ],
    })
    expect(tryParseClarifyPreviewJson(preview)?.questions?.length).toBeGreaterThanOrEqual(1)
  })

  it('repairs malformed multi-question blob stuffed into questions[0].id', () => {
    const args = {
      clarification_type: 'ambiguous_requirement',
      questions: [{ id: MALFORMED_ID, title: '10秒 Agent Teme 讲解视频 - 需求确认' }],
    }
    const repaired = repairClarifyQuestionsFromArgs(args)
    expect(repaired.title).toBe('10秒 Agent Teme 讲解视频 - 需求确认')
    expect(repaired.questions).toHaveLength(3)
    expect(parseQuestionsJsonBlob(MALFORMED_ID)).toHaveLength(3)

    const preview = resolveClarificationPreview({
      tools: [
        {
          name: 'ask_clarification',
          input: args,
          output: '{"kind": "command", "goto": "__end__"}',
        },
      ],
    })
    const parsed = tryParseClarifyPreviewJson(preview)
    expect(parsed?.title).toBe('10秒 Agent Teme 讲解视频 - 需求确认')
    expect(parsed?.questions?.length).toBe(3)
    expect(parsed?.questions?.[0]?.prompt).toContain('agent teme')
    expect(parsed?.questions?.[1]?.prompt).toContain('视频风格偏好')
    expect(parsed?.questions?.[2]?.prompt).toContain('配音语言')
    expect(parsed?.questions?.[0]?.options?.length).toBeGreaterThanOrEqual(2)

    const fromArgs = clarificationPreviewJsonFromToolArgs(args)
    expect(fromArgs).not.toContain('请补充必要信息')
  })

  it('findPendingAskClarificationInRows ignores first-round ask when user already sent later messages', () => {
    const clarifyTool = {
      id: 'tc-clarify',
      name: 'ask_clarification',
      input: {
        title: 'AI 角色设计需求确认',
        questions: [{ id: 'role_type', prompt: '类型？', options: ['A', 'B'] }],
      },
      output: '{"kind": "command", "goto": "__end__"}',
      status: 'ok',
    }
    const rows = [
      { role: 'user', text: '设计一个 AI 角色' },
      { role: 'assistant', text: '', tools: [clarifyTool] },
      { role: 'user', text: '已提交选择\n· 编程/技术助手' },
      { role: 'assistant', text: '好的，角色设计如下…' },
      { role: 'user', text: '第二轮问题' },
      { role: 'assistant', text: '第二轮回答' },
      { role: 'user', text: '第三轮' },
      { role: 'assistant', text: '第三轮回答' },
    ]
    expect(findPendingAskClarificationInRows(rows)).toBeNull()
  })

  it('findPendingAskClarificationInRows still opens ask after last user when unanswered', () => {
    const clarifyTool = {
      id: 'tc-open',
      name: 'ask_clarification',
      input: {
        questions: [{ prompt: '选类型', options: ['A', 'B'] }],
      },
      output: '{"kind": "command", "goto": "__end__"}',
      status: 'ok',
    }
    const rows = [
      { role: 'user', text: '帮我设计角色' },
      { role: 'assistant', text: '', tools: [clarifyTool] },
    ]
    expect(findPendingAskClarificationInRows(rows)?.tool).toBe(clarifyTool)
  })

  it('completed ask_clarification ToolMessage echo (questionnaire JSON) is not pending', () => {
    const echoOutput = JSON.stringify({
      title: 'AI 角色需求调研',
      questions: [{ prompt: '角色定位？', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    const tool = {
      name: 'ask_clarification',
      output: echoOutput,
      status: 'ok',
    }
    expect(isAskClarificationToolPending(tool)).toBe(false)
  })

  it('stripResolvedAskClarificationFromRows removes completed ask from merged assistant tools', () => {
    const echoOutput = JSON.stringify({
      title: '调研',
      questions: [{ prompt: 'q1', options: [{ label: 'A' }] }],
    })
    const rows = [
      {
        role: 'assistant',
        text: '角色已创建',
        tools: [
          { name: 'ask_clarification', output: echoOutput, status: 'ok' },
          { name: 'create_agent', output: { success: true }, status: 'ok' },
        ],
      },
    ]
    const out = stripResolvedAskClarificationFromRows(rows)
    expect(out[0].tools.map((t) => t.name)).toEqual(['create_agent'])
  })

  it('findPendingAskClarificationInRows ignores merged post-clarify row with ask echo + real reply', () => {
    const echoOutput = JSON.stringify({
      title: 'AI 角色需求调研',
      questions: [{ prompt: 'q1', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    const rows = [
      { role: 'user', text: '我想创建一个新的 AI 角色…' },
      {
        role: 'assistant',
        text: '好的！在开始设计之前，我需要先了解你的需求。',
        tools: [
          {
            id: 'call_ask',
            name: 'ask_clarification',
            input: { title: 'AI 角色需求调研', questions: [{ prompt: 'q1', options: ['A', 'B'] }] },
            output: '{"kind": "command", "goto": "__end__"}',
          },
        ],
      },
      {
        role: 'user',
        text: '__EVF_CLARIFY_ANS_V1__: {"answers":[{"question_id":"q1","selected_option_labels":["项目管理/效率助手"]}]}',
      },
      {
        role: 'assistant',
        text: '好的，manage 场景已激活。## ✅ 角色创建完成！「灵析」已就位',
        tools: [
          { name: 'ask_clarification', output: echoOutput, status: 'ok' },
          { name: 'create_agent', output: { success: true }, status: 'ok' },
        ],
      },
    ]
    expect(findPendingAskClarificationInRows(rows)).toBeNull()
    expect(findAskClarificationAwaitingUserInRows(rows)).toBeNull()
  })

  it('findPendingAskClarificationInRows finds ask in same row as other streaming tools', () => {
    const askTool = {
      id: 'call_ask_new',
      name: 'ask_clarification',
      input: {
        title: '新技能需求梳理',
        questions: [{ id: 'q1', prompt: '技能类型？', options: ['A', 'B'] }],
      },
      status: 'running',
    }
    const rows = [
      { role: 'user', text: '第一轮' },
      { role: 'assistant', text: '第一轮回复' },
      { role: 'user', text: '第二轮：帮我创建技能' },
      {
        role: 'assistant',
        text: '',
        tools: [
          { name: 'scenario', status: 'ok', output: { status: 'success' } },
          { name: 'list_skills_catalog', status: 'ok', output: { success: true } },
          askTool,
        ],
      },
    ]
    const pending = findPendingAskClarificationInRows(rows)
    expect(pending?.tool).toBe(askTool)
    expect(clarificationPreviewFromTool(askTool)?.preview).toContain('新技能需求梳理')
  })

  it('findAskClarificationAwaitingUserInRows keeps ask when sibling tools exist in same row', () => {
    const preview = JSON.stringify({
      title: '需求确认',
      questions: [{ id: 'q1', prompt: '选方向？', options: ['A', 'B'] }],
    })
    const askDone = {
      name: 'ask_clarification',
      id: 'tc-ok-sibling',
      input: {
        title: '需求确认',
        questions: [{ id: 'q1', prompt: '选方向？', options: ['A', 'B'] }],
      },
      output: preview,
      status: 'ok',
    }
    const rows = [
      { role: 'user', text: '帮我选型' },
      {
        role: 'assistant',
        text: '',
        tools: [
          { name: 'scenario', status: 'ok', output: { status: 'success' } },
          { name: 'list_skills_catalog', status: 'ok', output: { success: true } },
          askDone,
        ],
      },
    ]
    const awaiting = findAskClarificationAwaitingUserInRows(rows)
    expect(awaiting?.tool).toBe(askDone)
    expect(clarificationPreviewFromTool(askDone)?.preview).toContain('选方向')
  })

  it('findAskClarificationAwaitingUserInRows includes ok-status ask with questionnaire output', () => {
    const preview = JSON.stringify({
      title: '需求确认',
      questions: [{ id: 'q1', prompt: '选方向？', options: ['A', 'B'] }],
    })
    const askDone = {
      name: 'ask_clarification',
      id: 'tc-ok',
      input: {
        title: '需求确认',
        questions: [{ id: 'q1', prompt: '选方向？', options: ['A', 'B'] }],
      },
      output: preview,
      status: 'ok',
    }
    const rows = [
      { role: 'user', text: '帮我选型' },
      { role: 'assistant', tools: [askDone] },
    ]
    expect(findPendingAskClarificationInRows(rows)).toBeNull()
    const awaiting = findAskClarificationAwaitingUserInRows(rows)
    expect(awaiting?.tool).toBe(askDone)
    expect(clarificationPreviewFromTool(askDone)?.preview).toContain('选方向')
  })

  it('findAskClarificationAwaitingUserInRows finds stale-output ask for API hydration', () => {
    const askStale = {
      name: 'ask_clarification',
      id: 'tc-stale',
      input: {},
      output: 'Clarification request processed by middleware',
      status: 'ok',
    }
    const rows = [
      { role: 'user', text: '帮我选型' },
      { role: 'assistant', tools: [askStale] },
    ]
    const awaiting = findAskClarificationAwaitingUserInRows(rows)
    expect(awaiting?.tool).toBe(askStale)
    expect(clarificationPreviewFromTool(askStale)).toBeNull()
  })

  it('findAskClarificationAwaitingUserInRows keeps ask when co-located with other tools and stale output', () => {
    const askStale = {
      name: 'ask_clarification',
      id: 'tc-mix',
      input: {
        title: '确认',
        questions: [{ prompt: '选方向？', options: ['A', 'B'] }],
      },
      output: 'Clarification request processed by middleware',
      status: 'ok',
    }
    const rows = [
      { role: 'user', text: '设计角色' },
      {
        role: 'assistant',
        tools: [
          { name: 'list_skills_catalog', status: 'ok', output: { success: true } },
          askStale,
        ],
      },
    ]
    const awaiting = findAskClarificationAwaitingUserInRows(rows)
    expect(awaiting?.tool).toBe(askStale)
    const stripped = stripResolvedAskClarificationFromRows(rows)
    expect(stripped[1].tools.map((t) => t.name)).toContain('ask_clarification')
  })

  it('isAskClarificationAwaitingUser accepts input-only questionnaire', () => {
    const { isAskClarificationAwaitingUser } = require('../src/lib/ask-clarification-pending.js')
    const tool = {
      name: 'ask_clarification',
      input: {
        title: '确认',
        questions: [{ prompt: '选方向？', options: ['A', 'B'] }],
      },
      output: 'Clarification request processed by middleware',
      status: 'ok',
    }
    expect(isAskClarificationAwaitingUser(tool)).toBe(true)
  })

  it('findAskClarificationAfterHuman returns null once user or assistant continued', () => {
    const messages = [
      { type: 'human', content: '设计角色' },
      {
        type: 'ai',
        tool_calls: [
          {
            id: 'tc1',
            name: 'ask_clarification',
            args: {
              title: '确认',
              questions: [{ prompt: '选类型', options: ['A', 'B'] }],
            },
          },
        ],
      },
      { type: 'human', content: '__EVF_CLARIFY_ANS_V1__: {"answers":[]}' },
      { type: 'ai', content: '收到，继续设计…' },
    ]
    expect(findAskClarificationAfterHuman(messages, 0)).toBeNull()
  })

  it('isClarificationPreviewRenderable rejects title-only partial JSON', () => {
    const partial = JSON.stringify({
      clarification_type: 'missing_info',
      title: '新技能需求梳理',
    })
    expect(isClarificationPreviewRenderable(partial)).toBe(false)
    expect(
      resolveClarificationPreview({ preview: partial }),
    ).toBe('')
  })
})

describe('stripAskClarificationLeakFromDisplayText', () => {
  it('removes embedded clarify JSON and suppresses body when ask is awaiting', async () => {
    const { stripAskClarificationLeakFromDisplayText } = await import(
      '../src/react/lib/clarify-chat-display.ts'
    )
    const json =
      '{"title":"补充关键信息","questions":[{"id":"q1","prompt":"你想让目标 Agent 完成什么任务？","options":[{"id":"opt_1","label":"A. 排查 Bug"},{"id":"opt_2","label":"B. 全面审查"}],"allow_multiple":false}]}'
    const prose = '你想开启目标 Agent，但还没说具体要完成什么任务。'
    const tools = [
      {
        name: 'ask_clarification',
        status: 'running',
        input: {
          title: '补充关键信息',
          questions: [
            {
              id: 'q1',
              prompt: '你想让目标 Agent 完成什么任务？',
              options: [{ label: 'A. 排查 Bug' }, { label: 'B. 全面审查' }],
            },
          ],
        },
      },
    ]
    expect(stripAskClarificationLeakFromDisplayText(`${prose}\n\n${json}`, tools)).toBe('')
    expect(stripAskClarificationLeakFromDisplayText(`前缀说明\n${json}`, null)).toBe('前缀说明')
  })
})
