import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeTaskHandlers,
  tryParseHandlersJson,
} from '../src/lib/task-handlers.js'

describe('normalizeTaskHandlers', () => {
  it('parses valid structured handlers JSON into read_outputs', () => {
    const items = normalizeTaskHandlers(
      '[{"agent_code":"quality-inspector","content":"审核文档","outputs":[{"type":"file","key":"report","value":"docs/a.md","label":"报告"}]}]',
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].agent_code, 'quality-inspector')
    assert.equal(items[0].content, '审核文档')
    assert.equal(items[0].read_outputs[0].value, 'docs/a.md')
    assert.equal(items[0].read_outputs[0].label, '报告')
  })

  it('prefers read_outputs over legacy outputs', () => {
    const items = normalizeTaskHandlers([
      {
        agent_code: 'a',
        content: 'x',
        read_outputs: [{ type: 'file', key: 'r', value: 'docs/new.md' }],
        outputs: [{ type: 'file', key: 'r', value: 'docs/old.md' }],
      },
    ])
    assert.equal(items[0].read_outputs[0].value, 'docs/new.md')
  })

  it('repairs unquoted-key blob instead of comma-splitting into fake rows', () => {
    const raw =
      '[{agent_code:quality-inspector, content:审核 ContentOS 产品定位文档，重点关注技术可行性（内置浏览器方案、平台 Cookie 拦截、EvoFlow）, outputs:[{type:file, key:report, value:docs/roles/product-manager/20260724-09/contentos-product-pos.md, label:ContentOS 产品定位文档}]}]'
    const items = normalizeTaskHandlers(raw)
    assert.equal(items.length, 1)
    assert.equal(items[0].agent_code, 'quality-inspector')
    assert.match(items[0].content, /ContentOS/)
    assert.match(items[0].read_outputs[0].value, /contentos-product-pos\.md$/)
    assert.equal(items[0].read_outputs[0].label, 'ContentOS 产品定位文档')
  })

  it('reassembles already comma-split fragments from a prior bad normalize', () => {
    const fragments = [
      '[{agent_code:quality-inspector',
      'content:审核 ContentOS 文档',
      'outputs:[{type:file',
      'key:report',
      'value:docs/a.md',
      'label:报告}]}]',
    ]
    const items = normalizeTaskHandlers(fragments)
    assert.equal(items.length, 1)
    assert.equal(items[0].agent_code, 'quality-inspector')
    assert.equal(items[0].content, '审核 ContentOS 文档')
    assert.equal(items[0].read_outputs[0].value, 'docs/a.md')
  })

  it('still accepts flat comma-separated agent codes', () => {
    const items = normalizeTaskHandlers('frontend-dev, backend-dev')
    assert.deepEqual(items, [
      { agent_code: 'frontend-dev', content: '', read_outputs: [] },
      { agent_code: 'backend-dev', content: '', read_outputs: [] },
    ])
  })

  it('tryParseHandlersJson returns null for garbage', () => {
    assert.equal(tryParseHandlersJson('not-json-at-all {{{'), null)
  })
})
