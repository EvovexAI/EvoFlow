import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyHealthSource, getHealthProbeCandidates } from '../src/lib/services-health.js'

test('健康探测候选地址优先检查 nginx 入口 2026', () => {
  const candidates = getHealthProbeCandidates()
  assert.equal(candidates[0], 'http://localhost:2024/')
})

test('2024 端口应识别为 LangGraph 后端健康检查', () => {
  const meta = classifyHealthSource('http://localhost:2024/')
  assert.equal(meta.title, '后端健康检查（LangGraph）')
})
