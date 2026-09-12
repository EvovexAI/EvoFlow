import { describe, expect, it } from 'vitest'
import {
  buildCurlSync,
  buildExampleChatRequest,
  buildExampleChatResponse,
  buildExampleVariables,
  sampleParameterValue,
} from '../src/lib/app-api-call-example.js'

describe('app-api-call-example', () => {
  it('samples defaults / options / typed fallbacks without angle placeholders', () => {
    expect(sampleParameterValue({ name: 'topic', default: 'AI' })).toBe('AI')
    expect(
      sampleParameterValue({
        name: 'format',
        type: 'select',
        options: ['Markdown', 'PDF'],
      }),
    ).toBe('Markdown')
    expect(sampleParameterValue({ name: 'n', type: 'number', label: '数量' })).toBe('1')
    expect(sampleParameterValue({ name: 'topic', label: '主题' })).toBe('示例主题')
    expect(sampleParameterValue({ name: 'topic', label: '主题' })).not.toMatch(/</)
  })

  it('builds paste-ready request and response with agent ids', () => {
    const app = {
      name: '竞品调研',
      goal_template: '调研 {{topic}}',
      answer_from_ref: '2',
      parameters: [
        { name: 'topic', label: '主题', required: true },
        { name: 'format', type: 'select', options: ['Markdown'], required: false },
      ],
      steps: [
        { ref: '1', name: '调研', assigned_agent: 'researcher' },
        { ref: '2', name: '撰稿', assigned_agent: 'writer' },
      ],
    }
    const vars = buildExampleVariables(app)
    expect(vars).toEqual({ topic: '示例主题', format: 'Markdown' })
    const body = buildExampleChatRequest({ appId: 'App_x', app, variables: vars })
    expect(body.model).toBe('App_x')
    expect(body.detail).toBe(true)
    expect(body.variables.topic).toBe('示例主题')
    expect(body.messages[0].content).toContain('竞品调研')
    const curl = buildCurlSync({
      baseUrl: 'http://127.0.0.1:8012/v1',
      apiKey: 'ef-test',
      body,
    })
    expect(curl).toContain('/chat/completions')
    expect(curl).toContain('ef-test')
    expect(curl).toContain('示例主题')

    const resp = buildExampleChatResponse({ appId: 'App_x', app, detail: true })
    expect(resp.choices[0].message.content).toContain('撰稿')
    expect(resp.responseData.map((r) => r.assigned_agent)).toEqual([
      'researcher',
      'writer',
    ])
  })
})
