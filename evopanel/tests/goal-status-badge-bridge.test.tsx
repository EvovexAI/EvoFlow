import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

// 回归：ConversationProjectionStore.subscribe 是 class 方法，直接把它交给
// useSyncExternalStore 会丢 this，挂载时抛 "Cannot read properties of undefined (reading 'listeners')"。
const { fakeStore } = vi.hoisted(() => {
  class FakeProjectionStore {
    readonly listeners = new Set<() => void>()
    // 与真实 store 一致：getState 必须返回稳定引用，否则 useSyncExternalStore 无限重渲染。
    readonly state = {
      snapshot: {
        goal: {
          objective: '把构建跑绿',
          status: 'active',
          timeUsedSeconds: 65,
          summaryTitle: null,
        },
      },
    }
    subscribe(listener: () => void): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }
    getState() {
      return this.state
    }
  }
  return { fakeStore: new FakeProjectionStore() }
})

vi.mock('../src/react/v4/V4StreamRowsBridge.js', () => ({
  getSharedV4SessionDataLayer: () => ({
    acquire: () => ({ store: fakeStore, release: () => {} }),
  }),
}))

vi.mock('../src/lib/ws-client.js', () => ({
  wsClient: {
    getSessionThreadId: () => 'thread-1',
    resolveSessionThreadId: async () => 'thread-1',
  },
}))

import { GoalStatusBadgeBridge } from '../src/react/v4/GoalStatusBadgeBridge.js'

afterEach(() => cleanup())

describe('GoalStatusBadgeBridge', () => {
  it('订阅 class store 时保持 this 绑定，并渲染目标徽标', async () => {
    render(<GoalStatusBadgeBridge sessionKey="session-1" />)

    expect(await screen.findByText(/目标 · 把构建跑绿/)).toBeTruthy()
    expect(fakeStore.listeners.size).toBeGreaterThan(0)
  })
})