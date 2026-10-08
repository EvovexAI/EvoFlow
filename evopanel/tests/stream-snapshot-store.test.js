/**
 * 原生 stream-snapshot-store 测试 (ZCode v4 对齐)。
 * 不再依赖 live-stream-store / live-stream-publish / apply-live-stream-overlay
 * shim；直接覆盖 commit/seq/status/recovery。
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  commitStreamSnapshot,
  commitStreamFrame,
  deleteStreamSnapshot,
  getStreamSnapshot,
  resetStreamSnapshotStoreForTests,
  setStoreStatus,
  subscribeRecoverySignal,
  subscribeStreamSnapshot,
} from '../src/react/lib/stream-snapshot-store.js'

const SK = 'snap-test-session'

afterEach(() => {
  resetStreamSnapshotStoreForTests()
})

describe('stream-snapshot-store', () => {
  it('commitStreamSnapshot 推进 seq 并通知订阅者', () => {
    deleteStreamSnapshot(SK)
    let notified = 0
    const off = subscribeStreamSnapshot(SK, () => {
      notified += 1
    })
    commitStreamSnapshot(SK, { kind: 'A' })
    expect(getStreamSnapshot(SK).status).toBe('live')
    expect(getStreamSnapshot(SK).seq).toBe(1)
    commitStreamSnapshot(SK, { kind: 'B' })
    expect(getStreamSnapshot(SK).seq).toBe(2)
    expect(notified).toBeGreaterThanOrEqual(2)
    off()
  })

  it('同一引用 + 同一 seq 静默短路', () => {
    deleteStreamSnapshot(SK)
    const snap = { kind: 'X' }
    commitStreamSnapshot(SK, snap)
    const seq0 = getStreamSnapshot(SK).seq
    let calls = 0
    const off = subscribeStreamSnapshot(SK, () => {
      calls += 1
    })
    commitStreamSnapshot(SK, snap, { seq: seq0 })
    expect(calls).toBe(0)
    off()
  })

  it('迟到低 seq 静默丢弃，绝不向后覆盖', () => {
    deleteStreamSnapshot(SK)
    commitStreamSnapshot(SK, { kind: 'fresh' }, { seq: 10 })
    commitStreamSnapshot(SK, { kind: 'stale' }, { seq: 5 })
    expect(getStreamSnapshot(SK).seq).toBe(10)
    expect((getStreamSnapshot(SK).snapshot).kind).toBe('fresh')
  })

  it('commitStreamFrame fromSeq 不对齐时拒绝 + 推 recovery', () => {
    deleteStreamSnapshot(SK)
    commitStreamSnapshot(SK, { v: 1 }, { seq: 3 })
    let recoveryTicks = 0
    const off = subscribeRecoverySignal(SK, () => {
      recoveryTicks += 1
    })
    const result = commitStreamFrame(SK, {
      fromSeq: 99,
      toSeq: 100,
      snapshot: { v: 99 },
    })
    expect(result.accepted).toBe(false)
    expect(result.recoveryTriggered).toBe(true)
    expect(recoveryTicks).toBe(1)
    expect(getStreamSnapshot(SK).seq).toBe(3)
    off()
  })

  it('commitStreamFrame fromSeq 衔接时推进 seq + 整体替换', () => {
    deleteStreamSnapshot(SK)
    commitStreamSnapshot(SK, { v: 1 }, { seq: 5 })
    const result = commitStreamFrame(SK, {
      fromSeq: 5,
      toSeq: 6,
      snapshot: { v: 2 },
    })
    expect(result.accepted).toBe(true)
    expect(getStreamSnapshot(SK).seq).toBe(6)
    expect((getStreamSnapshot(SK).snapshot).v).toBe(2)
  })

  it('setStoreStatus 流转 connecting → live → error → closed', () => {
    deleteStreamSnapshot(SK)
    setStoreStatus(SK, 'live')
    expect(getStreamSnapshot(SK).status).toBe('live')
    setStoreStatus(SK, 'error', 'boom')
    expect(getStoreStatus(SK)).toBe('error')
    expect(getStreamSnapshot(SK).lastError).toBe('boom')
    setStoreStatus(SK, 'closed')
    expect(getStoreStatus(SK)).toBe('closed')
    expect(getStreamSnapshot(SK).lastError).toBeNull()
  })

  it('空 sk 安全 no-op', () => {
    expect(() => commitStreamSnapshot('', { v: 1 })).not.toThrow()
    expect(() => commitStreamFrame('', { fromSeq: 0, toSeq: 1, snapshot: {} })).not.toThrow()
    expect(() => subscribeStreamSnapshot('', () => {})).not.toThrow()
  })

  it('订阅同一 store 多次 commit 都收到通知', () => {
    deleteStreamSnapshot(SK)
    let a = 0
    let b = 0
    const offA = subscribeStreamSnapshot(SK, () => {
      a += 1
    })
    const offB = subscribeStreamSnapshot(SK, () => {
      b += 1
    })
    commitStreamSnapshot(SK, { v: 1 })
    commitStreamSnapshot(SK, { v: 2 })
    expect(a).toBeGreaterThanOrEqual(2)
    expect(b).toBeGreaterThanOrEqual(2)
    offA()
    offB()
  })
})

function getStoreStatus(sk) {
  return getStreamSnapshot(sk).status
}
