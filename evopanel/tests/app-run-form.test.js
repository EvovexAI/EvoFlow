import { describe, expect, it } from 'vitest'
import {
  collectParamValues,
  paramToField,
  parseParamsFromEditor,
  previewRenderText,
  serializeParamsForEditor,
} from '../src/lib/app-run-form.js'

describe('app-run-form', () => {
  it('paramToField prefers label over name', () => {
    const f = paramToField({ name: 'topic', label: '主题', required: true, default: 'AI' })
    expect(f.name).toBe('topic')
    expect(f.label).toBe('主题')
    expect(f.required).toBe(true)
    expect(f.value).toBe('AI')
  })

  it('paramToField maps select options', () => {
    const f = paramToField({
      name: 'fmt',
      label: '格式',
      type: 'select',
      options: ['md', 'json'],
      default: 'md',
    })
    expect(f.type).toBe('select')
    expect(f.options).toEqual([
      { value: 'md', label: 'md' },
      { value: 'json', label: 'json' },
    ])
  })

  it('collectParamValues validates required and number', () => {
    const params = [
      { name: 'a', label: 'A', required: true },
      { name: 'n', label: 'N', type: 'number', required: true },
    ]
    expect(collectParamValues(params, { a: '', n: '1' }).ok).toBe(false)
    expect(collectParamValues(params, { a: '1', n: 'x' }).ok).toBe(false)
    expect(collectParamValues(params, { a: '1', n: '3' }).ok).toBe(true)
  })

  it('previewRenderText substitutes params', () => {
    expect(previewRenderText('分析 {{topic}}', { topic: 'AI' })).toBe('分析 AI')
    expect(previewRenderText('分析 {{topic}}', {})).toBe('分析 〈未填 · topic〉')
  })

  it('roundtrips parameter editor text including select options', () => {
    const params = [
      { name: 'topic', label: '主题', type: 'text', default: '', required: true },
      {
        name: 'fmt',
        label: '格式',
        type: 'select',
        default: 'md',
        required: true,
        options: ['md', 'json'],
      },
    ]
    const text = serializeParamsForEditor(params)
    expect(text).toContain('fmt|格式|select|md|1|md,json')
    const parsed = parseParamsFromEditor(text)
    expect(parsed[1]).toMatchObject({
      name: 'fmt',
      type: 'select',
      options: ['md', 'json'],
      required: true,
    })
  })
})
