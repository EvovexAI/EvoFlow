import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfigCandidates, readConfigWithFallback } from '../src/lib/services-config.js'

test('候选路径优先使用项目根目录 config.yaml', () => {
  const candidates = buildConfigCandidates('/home/user/evoflow', '')
  assert.equal(candidates[0], '/home/user/evoflow/config.yaml')
  assert.equal(candidates[1], '/home/user/evoflow/backend/config.yaml')
})

test('readConfigWithFallback 可从首个命中路径读取成功', async () => {
  const mockReadFile = async (p) => (p === '/home/user/evoflow/config.yaml' ? 'name: evoflow' : '')
  const result = await readConfigWithFallback({
    readFile: mockReadFile,
    preferredRoot: '/home/user/evoflow',
    savedPath: '',
    resolveByShell: async () => '',
  })
  assert.equal(result.path, '/home/user/evoflow/config.yaml')
  assert.equal(result.content, 'name: evoflow')
})

test('readConfigWithFallback 可通过 shell 回退路径读取成功', async () => {
  const mockReadFile = async (p) => (p === '/opt/evoflow/config.yaml' ? 'api: true' : '')
  const result = await readConfigWithFallback({
    readFile: mockReadFile,
    preferredRoot: '',
    savedPath: '',
    resolveByShell: async () => '/opt/evoflow/config.yaml',
  })
  assert.equal(result.path, '/opt/evoflow/config.yaml')
  assert.equal(result.content, 'api: true')
})
