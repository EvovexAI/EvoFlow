import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ServiceHealthState,
  triggerServiceHealthCheck,
  getServiceHealthState,
  onServiceHealthChange,
  startServiceHealthPoll,
  stopServiceHealthPoll,
  __resetServiceHealthForTest,
  __setReadyDetailProbe,
  markServiceUnreachable,
} from '../src/lib/service-health.js'

// === /health/ready 响应构造器（模拟后端 startup_gate 状态机） ===

/** 进程未起 → HTTP 失败（network error） */
function httpFail() {
  return async () => ({
    httpOk: false,
    phase: null,
    extended: null,
    fullyReady: false,
  })
}

/** 进程在跑但还没初始化完：HTTP 200 + phase=initializing + extended=false（用户当前场景） */
function initializing() {
  return async () => ({
    httpOk: true,
    phase: 'initializing',
    extended: false,
    fullyReady: false,
  })
}

/** 进程在跑但报 unhealthy（网关致命错误） */
function unhealthy() {
  return async () => ({
    httpOk: true,
    phase: 'unknown',
    extended: null,
    fullyReady: false,
  })
}

/** 完全 ready：HTTP 200 + phase=ready + extended=true */
function readyOk() {
  return async () => ({
    httpOk: true,
    phase: 'ready',
    extended: true,
    fullyReady: true,
  })
}

/** [fix-2026-09-25] HTTP 200 + phase=ready + extended=false (LG ready, 但 extended routers 未注册)
 * 之前被当作 DEGRADED + "服务正在初始化中" banner；现在应是 UNKNOWN / transient，
 * 避免 cold start 时一探针就弹 banner 阻挡用户。 */
function extendedPending() {
  return async () => ({
    httpOk: true,
    phase: 'ready',
    extended: false,
    fullyReady: false,
  })
}

/** 老的启动中间态：HTTP 503 + status=not_ready（处理 startup_error） */
function notReady503() {
  return async () => ({
    httpOk: false,
    phase: 'not_ready',
    extended: null,
    fullyReady: false,
  })
}

test.beforeEach(() => {
  __resetServiceHealthForTest()
})

test('初始状态为 UNKNOWN', () => {
  assert.equal(getServiceHealthState().state, ServiceHealthState.UNKNOWN)
})

test('HTTP 不可达 → UNAVAILABLE（fail streak=1 已生效，用户早知道）', async () => {
  __setReadyDetailProbe(httpFail())
  await triggerServiceHealthCheck()
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.UNAVAILABLE)
  assert.match(snap.lastError, /http request failed|connect|fetch|ENOTFOUND|ECONNREFUSED|timeout|aborted|abort/i)
})

test('关键场景：HTTP 200 + phase=initializing + extended=false → 立即 DEGRADED', async () => {
  // 这是用户实际看到的 status: "ready" 但 phase: "initializing" 的伪 ready 场景。
  // 必须立刻识别为"还不能用" — banner 立刻亮，不等 streak。
  // [fix-2026-09-25] phase=initializing 仍然立即 DEGRADED（LG 引擎未就绪）；
  // extended=false 不再叠加进 DEGRADED 错误信息，避免误报。
  __setReadyDetailProbe(initializing())
  await triggerServiceHealthCheck()
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.DEGRADED)
  // error 字符串应该带 phase 信息，方便调试
  assert.match(snap.lastError, /initializing/)
})

test('HTTP 200 + 完全 ready → HEALTHY', async () => {
  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck()
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.HEALTHY)
  assert.equal(snap.lastError, null)
  assert.equal(snap.failStreak, 0)
})

test('[fix-2026-09-25] HTTP 200 + phase=ready + extended=false → HEALTHY (extended routers 后台注册中)', async () => {
  // Cold start 时 extended routers (settings/knowledge/MCP) 还没注册，但 core API
  // (models/agents/messages/LG runs) 已可用。把 extended=false 单独当作 HEALTHY
  // — 不阻挡主聊天面板，extended 路由会自己 503 (StartupGateMiddleware)。
  __setReadyDetailProbe(extendedPending())
  await triggerServiceHealthCheck()
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.HEALTHY)
})

test('HTTP 503 + status=not_ready → UNAVAILABLE', async () => {
  __setReadyDetailProbe(notReady503())
  await triggerServiceHealthCheck()
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.UNAVAILABLE)
})

test('手动重试（manual）也立即生效', async () => {
  __setReadyDetailProbe(initializing())
  await triggerServiceHealthCheck({ manual: true })
  const snap = getServiceHealthState()
  // HTTP 200 但 phase=initializing 仍 DEGRADED（即时生效）
  assert.equal(snap.state, ServiceHealthState.DEGRADED)
})

test('从 DEGRADED 恢复：phase=ready, extended=true → HEALTHY', async () => {
  __setReadyDetailProbe(initializing())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.DEGRADED)

  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck()
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.HEALTHY)
  assert.equal(snap.lastError, null)
})

test('从 UNAVAILABLE 恢复：HTTP 失败 → readyOk → HEALTHY', async () => {
  __setReadyDetailProbe(httpFail())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.UNAVAILABLE)

  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.HEALTHY)
})

test('状态变化通过 onServiceHealthChange 推送', async () => {
  __setReadyDetailProbe(readyOk())
  const events = []
  const unsub = onServiceHealthChange((snap) => events.push(snap.state))

  await triggerServiceHealthCheck() // HEALTHY
  __setReadyDetailProbe(initializing())
  await triggerServiceHealthCheck() // DEGRADED
  __setReadyDetailProbe(httpFail())
  await triggerServiceHealthCheck() // UNAVAILABLE
  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck() // HEALTHY

  unsub()
  assert.deepEqual(events, [
    ServiceHealthState.UNKNOWN, // 订阅立即推送初始
    ServiceHealthState.HEALTHY,
    ServiceHealthState.DEGRADED,
    ServiceHealthState.UNAVAILABLE,
    ServiceHealthState.HEALTHY,
  ])
})

test('订阅立即收到当前快照（避免 UI 初始空白）', async () => {
  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck()

  let firstSnap = null
  const unsub = onServiceHealthChange((snap) => { if (!firstSnap) firstSnap = snap.state })
  unsub()
  assert.equal(firstSnap, ServiceHealthState.HEALTHY)
})

test('markServiceUnreachable：跳过 streak 立即进入 UNAVAILABLE', () => {
  markServiceUnreachable('502 from /api/chat/send')
  const snap = getServiceHealthState()
  assert.equal(snap.state, ServiceHealthState.UNAVAILABLE)
  assert.match(snap.lastError, /502/)
})

test('startServiceHealthPoll / stopServiceHealthPoll 幂等', () => {
  startServiceHealthPoll()
  startServiceHealthPoll() // 不应抛
  assert.equal(getServiceHealthState().isPolling, true)
  stopServiceHealthPoll()
  assert.equal(getServiceHealthState().isPolling, false)
})

test('完整流程：healthy → initializing → http fail → ready ok', async () => {
  // 1. 健康
  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.HEALTHY)

  // 2. 进入 initializing（用户实际看到的 case）
  __setReadyDetailProbe(initializing())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.DEGRADED)

  // 3. HTTP 直接挂
  __setReadyDetailProbe(httpFail())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.UNAVAILABLE)

  // 4. 恢复
  __setReadyDetailProbe(readyOk())
  await triggerServiceHealthCheck()
  assert.equal(getServiceHealthState().state, ServiceHealthState.HEALTHY)
})
