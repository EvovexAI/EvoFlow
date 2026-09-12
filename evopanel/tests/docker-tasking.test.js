import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DOCKER_TASK_TIMEOUT_MS,
  buildDockerDispatchTargets,
  buildDockerInstanceSwitchContext,
} from '../src/lib/docker-tasking.js'

test('Docker å¼æ­¥ä»»å¡é»è®¤è¶æ¶æåå?10 åé', () => {
  assert.equal(DOCKER_TASK_TIMEOUT_MS, 10 * 60 * 1000)
})

test('Docker æ´¾åç®æ ä¼ä¿çå®¹å¨åèç¹ä¿¡æ¯', () => {
  const targets = buildDockerDispatchTargets([
    { id: 'container-1234567890ab', name: 'evopanel-coder', nodeId: 'node-a' },
    { id: 'container-bbbbbbbbbbbb', name: 'evopanel-writer', nodeId: 'node-b' },
  ])

  assert.deepEqual(targets, [
    { containerId: 'container-1234567890ab', containerName: 'evopanel-coder', nodeId: 'node-a' },
    { containerId: 'container-bbbbbbbbbbbb', containerName: 'evopanel-writer', nodeId: 'node-b' },
  ])
})

test('Docker å®ä¾åæ¢ä¸ä¸æä¼è¦æ±æ´é¡µéè½½å¹¶çææ­£ç¡®æ³¨ååæ?, () => {
  const ctx = buildDockerInstanceSwitchContext({
    containerId: 'abcdef1234567890',
    name: 'evopanel-coder',
    port: '21420',
    gatewayPort: '28789',
    nodeId: 'node-a',
  })

  assert.equal(ctx.instanceId, 'docker-abcdef123456')
  assert.equal(ctx.reloadRoute, true)
  assert.deepEqual(ctx.registration, {
    name: 'evopanel-coder',
    type: 'docker',
    endpoint: 'http://127.0.0.1:21420',
    gatewayPort: 28789,
    containerId: 'abcdef1234567890',
    nodeId: 'node-a',
    note: 'Added from Docker page',
  })
})
