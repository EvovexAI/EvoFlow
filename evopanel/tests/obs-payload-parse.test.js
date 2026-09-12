import { describe, expect, it } from 'vitest'
import {
  parseRequestViews,
  parseResponseViews,
  tryParseObsJsonLoose,
} from '../src/react/obs/lib/obs-payload-parse.ts'

describe('obs-payload-parse', () => {
  it('repairs sqlite truncation suffix', () => {
    const body = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    })
    const truncated = `${body.slice(0, body.length - 40)}\n… [truncated]`
    const parsed = tryParseObsJsonLoose(truncated)
    expect(parsed).toBeTruthy()
    expect(typeof parsed).toBe('object')
  })

  it('reads fields from truncated request_json string', () => {
    const payload = {
      model: 'doubao',
      system: 'You are EvoFlow assistant.',
      messages: [
        { role: 'system', content: 'System in messages' },
        { role: 'user', content: 'older question' },
        { role: 'user', content: 'latest user question' },
      ],
      tools: [{ type: 'function', function: { name: 'grep_search' } }],
    }
    const raw = `${JSON.stringify(payload).slice(0, 900)}\n… [truncated]`
    const views = parseRequestViews(raw)
    expect(views).toBeTruthy()
    expect(views?.systemPrompt).toMatch(/EvoFlow assistant|System in messages/)
    expect(views?.userLatest).toMatch(/question/)
  })

  it('handles legacy wrapper with system_prompt_full', () => {
    const raw = {
      stage: 'final_payload',
      system_prompt_full: 'Legacy full system prompt',
      payload: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    }
    const views = parseRequestViews(raw)
    expect(views?.systemPrompt).toBe('Legacy full system prompt')
    expect(views?.userLatest).toBe('hi')
  })

  it('unwraps langchain human message kwargs', () => {
    const raw = {
      model: 'x',
      messages: [
        {
          type: 'constructor',
          id: ['langchain_core', 'messages', 'HumanMessage'],
          kwargs: { content: 'from kwargs' },
        },
      ],
    }
    const views = parseRequestViews(raw)
    expect(views?.userLatest).toBe('from kwargs')
  })

  it('reads request_tool_names and latest_user_preview from storage record', () => {
    const raw = {
      model: 'x',
      latest_user_preview: 'What is the bug?',
      request_tool_names: ['read', 'rg'],
      request_tools_stats: [
        { name: 'read', chars: 1200, tokens: 300 },
        { name: 'rg', chars: 800, tokens: 200 },
      ],
      request_tools_tokens_total: 500,
      system_prompt_stats: { chars: 16, tokens: 4 },
      latest_user_stats: { chars: 15, tokens: 4 },
      tools: [{ type: 'function', function: { name: 'read' } }],
      messages: [
        { role: 'system', content: 'Full system text' },
        { role: 'user', content: 'What is the bug?' },
      ],
    }
    const views = parseRequestViews(raw)
    expect(views?.systemPrompt).toBe('Full system text')
    expect(views?.userLatest).toBe('What is the bug?')
    expect(views?.requestToolNames).toEqual(['read', 'rg'])
    expect(views?.requestToolStats).toHaveLength(2)
    expect(views?.requestToolsTokensTotal).toBe(500)
    expect(views?.systemPromptStats?.chars).toBe(16)
    expect(views?.userLatestStats?.chars).toBe(15)
  })

  it('extracts assistant_preview from response record', () => {
    const raw = {
      generations: [[{ text: 'Hello from model' }]],
      assistant_preview: 'Hello from model',
    }
    const views = parseResponseViews(raw)
    expect(views?.assistantContent).toMatch(/Hello from model/)
  })
})
