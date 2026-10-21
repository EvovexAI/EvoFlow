import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HARD_RELOAD_KEY_PREFIXES,
  classifyConfigReload,
  flattenConfigPaths,
} from '../src/lib/gateway-config-reload.js'

test('flattenConfigPaths 展开嵌套键', () => {
  assert.deepEqual(
    flattenConfigPaths({ gateway: { port: 8012 }, models: { providers: {} } }).sort(),
    ['gateway.port', 'models.providers'].sort(),
  )
})

test('仅改模型配置应走 soft reload', () => {
  const prev = { models: { providers: { a: { apiKey: '1' } } }, gateway: { port: 8012 } }
  const next = { models: { providers: { a: { apiKey: '2' } } }, gateway: { port: 8012 } }
  const d = classifyConfigReload(prev, next)
  assert.equal(d.hard, false)
  assert.deepEqual(d.changedHardKeys, [])
  assert.ok(d.changedPaths.some((p) => p.startsWith('models.')))
})

test('改 gateway.port 应走 hard reload', () => {
  const prev = { gateway: { port: 8012, mode: 'local' } }
  const next = { gateway: { port: 8070, mode: 'local' } }
  const d = classifyConfigReload(prev, next)
  assert.equal(d.hard, true)
  assert.ok(d.changedHardKeys.includes('gateway.port'))
})

test('HARD_RELOAD_KEY_PREFIXES 覆盖端口与存储', () => {
  assert.ok(HARD_RELOAD_KEY_PREFIXES.includes('gateway.port'))
  assert.ok(HARD_RELOAD_KEY_PREFIXES.includes('checkpointer'))
  assert.ok(HARD_RELOAD_KEY_PREFIXES.includes('storage'))
})
