/**
 * @fileoverview 任务事件流管理（兼容层）
 *
 * 旧版通过 `GET /api/events/tasks/{id}/stream` 订阅网关 SSE 的实现已移除。
 * 为避免历史组件导入报错，这里保留相同的导出 API，但连接逻辑全部 no-op。
 *
 * 任务态/输出与“实时对话”对齐：走 LangGraph `threads/state` / `runs/stream`（或网关 attach stream）+ 轮询刷新。
 */

export class TaskEventStream {
  constructor(mainTaskId) {
    this.mainTaskId = mainTaskId
    this.eventSource = null
    this.listeners = new Map()
    this.isConnected = false
    this.lastEventTime = null
  }

  async connect() {
    // 兼容层：原 SSE 通道已下线，连接成功状态保持 false 即可；
    // **不再在 connect 时主动 emit DISCONNECTED**——历史调用方（EmbeddedTaskDashboard、
    // FloatingTaskPanel）在挂载后立刻 connect()，若此处 emit 会让 UI 一开就闪现「已断开」
    // 假状态。真实任务态由 LangGraph runs/stream + 轮询负责，调用方根本不依赖此事件。
    this.isConnected = false
  }

  disconnect() {
    this.isConnected = false
    try {
      this.eventSource?.close()
    } catch {
      /* ignore */
    }
    this.eventSource = null
    this.emit(EventTypes.DISCONNECTED, { timestamp: new Date().toISOString(), reason: 'manual' })
  }

  on(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(callback)
    return () => this.off(type, callback)
  }

  off(type, callback) {
    const arr = this.listeners.get(type)
    if (!Array.isArray(arr)) return
    this.listeners.set(
      type,
      arr.filter((fn) => fn !== callback),
    )
  }

  emit(type, data) {
    const arr = this.listeners.get(type)
    if (!Array.isArray(arr)) return
    for (const fn of arr) {
      try {
        fn(data)
      } catch {
        /* ignore */
      }
    }
  }
}

export class EventStreamManager {
  constructor() {
    this.streams = new Map()
  }

  static getInstance() {
    if (!EventStreamManager.instance) {
      EventStreamManager.instance = new EventStreamManager()
    }
    return EventStreamManager.instance
  }

  getStream(mainTaskId) {
    if (!this.streams.has(mainTaskId)) {
      this.streams.set(mainTaskId, new TaskEventStream(mainTaskId))
    }
    return this.streams.get(mainTaskId)
  }

  disconnectStream(mainTaskId) {
    if (!this.streams.has(mainTaskId)) return
    try {
      this.streams.get(mainTaskId)?.disconnect()
    } catch {
      /* ignore */
    }
    this.streams.delete(mainTaskId)
  }

  disconnectAll() {
    for (const stream of this.streams.values()) {
      try {
        stream.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.streams.clear()
  }

  getActiveConnectionsCount() {
    let count = 0
    for (const stream of this.streams.values()) {
      if (stream?.isConnected) count += 1
    }
    return count
  }

  getConnectedMainTaskIds() {
    const ids = []
    for (const [mainTaskId, stream] of this.streams.entries()) {
      if (stream?.isConnected) ids.push(mainTaskId)
    }
    return ids
  }
}

export const EventTypes = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  TASK_CREATED: 'task:created',
  TASK_STARTED: 'task:started',
  TASK_PROGRESS: 'task:progress',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  TASK_HEARTBEAT: 'task:heartbeat',
  THREAD_MESSAGE: 'thread:message',
}

export default {
  TaskEventStream,
  EventStreamManager,
  EventTypes,
}

