import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { sanitizeSubtaskLiveTicker } from '../src/lib/subtask-live-preview.js'

describe('sanitizeSubtaskLiveTicker', () => {
  it('prefers last natural-language line over JSON tool blobs', () => {
    const raw = [
      '{"ok": true, "action": "set", "count": 4}',
      '好的，现在更新步骤1为进行中，并检查 outputs 目录是否存在',
      '{"ok": true, "action": "update", "itemId": "wc_1"}',
    ].join('\n')
    assert.equal(
      sanitizeSubtaskLiveTicker(raw),
      '好的，现在更新步骤1为进行中，并检查 outputs 目录是否存在',
    )
  })

  it('returns empty when only JSON', () => {
    assert.equal(sanitizeSubtaskLiveTicker('{"ok": true, "action": "list"}'), '')
  })
})
