/**
 * 状态持久化管理
 * 文件：evopanel/src/lib/state-persistence.js
 * 
 * 实现三层状态恢复机制：
 * 1. localStorage 快速恢复 (<100ms)
 * 2. API 获取最新状态 (200-500ms)
 * 3. SSE 事件流实时更新 (即时)
 * 
 * 参考文档：EvoFlow 前端实现进度.md - Task 4.1
 */

/**
 * 状态持久化类
 */
export class StatePersistence {
  /**
   * localStorage 键名常量
   */
  static STORAGE_KEYS = {
    TASKS: 'evoflow_tasks_cache',
    PANEL_STATE: 'evoflow_panel_state',
    EVENT_STREAM: 'evoflow_event_stream_state',
    CONVERSATION_PANELS: 'evoflow_conversation_panels'
  }

  /**
   * 缓存有效期（毫秒）
   */
  static CACHE_TTL = 5 * 60 * 1000 // 5 分钟

  /**
   * 保存任务状态
   * @public
   * @async
   * @param {Array} tasks - 任务列表
   * @returns {Promise<void>}
   */
  async saveTasks(tasks) {
    try {
      const cache = {
        timestamp: Date.now(),
        tasks: tasks.map(t => ({
          id: t.id,
          name: t.name,
          status: t.status,
          progress: t.progress,
          thread_id: t.thread_id,
          current_step: t.current_step
        }))
      }
      localStorage.setItem(this.STORAGE_KEYS.TASKS, JSON.stringify(cache))
      console.log('[StatePersistence] Tasks saved:', tasks.length, 'tasks')
    } catch (error) {
      console.error('[StatePersistence] Failed to save tasks:', error)
    }
  }

  /**
   * 恢复任务状态
   * @public
   * @async
   * @returns {Promise<Array|null>} 任务列表或 null
   */
  async restoreTasks() {
    try {
      const cached = localStorage.getItem(this.STORAGE_KEYS.TASKS)
      if (!cached) {
        console.log('[StatePersistence] No cached tasks found')
        return null
      }
      
      const cache = JSON.parse(cached)
      const age = Date.now() - cache.timestamp
      
      // 缓存超过 TTL 则无效
      if (age > this.CACHE_TTL) {
        console.log('[StatePersistence] Cache expired, age:', Math.round(age / 1000), 's')
        localStorage.removeItem(this.STORAGE_KEYS.TASKS)
        return null
      }
      
      console.log('[StatePersistence] Restored tasks from cache, age:', Math.round(age / 1000), 's')
      return cache.tasks
    } catch (error) {
      console.error('[StatePersistence] Failed to restore tasks:', error)
      return null
    }
  }

  /**
   * 保存面板状态
   * @public
   * @param {Object} state - 面板状态
   * @param {boolean} state.isOpen - 是否打开
   * @param {Object} state.position - 位置
   * @param {Object} state.size - 大小
   * @param {boolean} state.isMinimized - 是否最小化
   */
  savePanelState(state) {
    try {
      const serialized = JSON.stringify(state)
      localStorage.setItem(this.STORAGE_KEYS.PANEL_STATE, serialized)
      console.log('[StatePersistence] Panel state saved')
    } catch (error) {
      console.error('[StatePersistence] Failed to save panel state:', error)
    }
  }

  /**
   * 恢复面板状态
   * @public
   * @returns {Object|null} 面板状态或 null
   */
  restorePanelState() {
    try {
      const cached = localStorage.getItem(this.STORAGE_KEYS.PANEL_STATE)
      if (!cached) {
        console.log('[StatePersistence] No cached panel state found')
        return null
      }
      
      const state = JSON.parse(cached)
      console.log('[StatePersistence] Restored panel state')
      return state
    } catch (error) {
      console.error('[StatePersistence] Failed to restore panel state:', error)
      return null
    }
  }

  /**
   * 保存打开的对话面板列表
   * @public
   * @async
   * @param {Array} panels - 面板信息列表
   * @returns {Promise<void>}
   */
  async saveConversationPanels(panels) {
    try {
      const panelData = panels.map(p => ({
        taskId: p.taskId,
        mode: p.mode,
        position: p.position,
        size: p.size
      }))
      localStorage.setItem(this.STORAGE_KEYS.CONVERSATION_PANELS, JSON.stringify(panelData))
      console.log('[StatePersistence] Conversation panels saved:', panels.length)
    } catch (error) {
      console.error('[StatePersistence] Failed to save conversation panels:', error)
    }
  }

  /**
   * 恢复打开的对话面板列表
   * @public
   * @async
   * @returns {Promise<Array|null>} 面板信息列表或 null
   */
  async restoreConversationPanels() {
    try {
      const cached = localStorage.getItem(this.STORAGE_KEYS.CONVERSATION_PANELS)
      if (!cached) {
        console.log('[StatePersistence] No cached conversation panels found')
        return null
      }
      
      const panels = JSON.parse(cached)
      console.log('[StatePersistence] Restored conversation panels:', panels.length)
      return panels
    } catch (error) {
      console.error('[StatePersistence] Failed to restore conversation panels:', error)
      return null
    }
  }

  /**
   * 保存事件流状态
   * @public
   * @param {Object} state - 事件流状态
   */
  saveEventStreamState(state) {
    try {
      const serialized = JSON.stringify(state)
      localStorage.setItem(this.STORAGE_KEYS.EVENT_STREAM, serialized)
      console.log('[StatePersistence] Event stream state saved')
    } catch (error) {
      console.error('[StatePersistence] Failed to save event stream state:', error)
    }
  }

  /**
   * 恢复事件流状态
   * @public
   * @returns {Object|null} 事件流状态或 null
   */
  restoreEventStreamState() {
    try {
      const cached = localStorage.getItem(this.STORAGE_KEYS.EVENT_STREAM)
      if (!cached) {
        return null
      }
      return JSON.parse(cached)
    } catch (error) {
      console.error('[StatePersistence] Failed to restore event stream state:', error)
      return null
    }
  }

  /**
   * 清除所有缓存
   * @public
   */
  clearCache() {
    Object.values(this.STORAGE_KEYS).forEach(key => {
      localStorage.removeItem(key)
    })
    console.log('[StatePersistence] All cache cleared')
  }

  /**
   * 清除任务缓存
   * @public
   */
  clearTasksCache() {
    localStorage.removeItem(this.STORAGE_KEYS.TASKS)
    console.log('[StatePersistence] Tasks cache cleared')
  }

  /**
   * 获取缓存统计信息
   * @public
   * @returns {Object} 缓存统计
   */
  getCacheStats() {
    const stats = {}
    
    Object.entries(this.STORAGE_KEYS).forEach(([key, storageKey]) => {
      const cached = localStorage.getItem(storageKey)
      if (cached) {
        try {
          const data = JSON.parse(cached)
          stats[key] = {
            size: cached.length,
            timestamp: data.timestamp || null,
            age: data.timestamp ? Date.now() - data.timestamp : null
          }
        } catch {
          stats[key] = {
            size: cached.length,
            timestamp: null,
            age: null
          }
        }
      }
    })
    
    return stats
  }

  /**
   * 打印缓存统计（调试用）
   * @public
   */
  logCacheStats() {
    const stats = this.getCacheStats()
    console.log('[StatePersistence] Cache statistics:', stats)
  }
}

/**
 * 状态恢复管理器
 * 实现三层状态恢复机制
 */
export class StateRestorationManager {
  constructor() {
    this.persistence = new StatePersistence()
    this.isRestoring = false
  }

  /**
   * 执行三层状态恢复
   * @public
   * @async
   * @param {Object} callbacks - 回调函数
   * @param {Function} callbacks.onCacheRestore - 缓存恢复回调
   * @param {Function} callbacks.onAPIRestore - API 恢复回调
   * @param {Function} callbacks.onSSEConnect - SSE 连接回调
   * @returns {Promise<void>}
   */
  async restore(callbacks = {}) {
    if (this.isRestoring) {
      console.warn('[StateRestorationManager] Already restoring')
      return
    }

    this.isRestoring = true
    console.log('[StateRestorationManager] Starting three-layer restoration...')

    try {
      // Layer 1: 从 localStorage 恢复 (<100ms)
      console.log('[StateRestorationManager] Layer 1: Restoring from localStorage...')
      const cachedTasks = await this.persistence.restoreTasks()
      const panelState = this.persistence.restorePanelState()
      
      if (callbacks.onCacheRestore) {
        callbacks.onCacheRestore({
          tasks: cachedTasks,
          panelState: panelState
        })
      }

      // Layer 2: 从 API 获取最新状态 (200-500ms)
      console.log('[StateRestorationManager] Layer 2: Fetching from API...')
      const freshTasks = await this.fetchFreshTasks()
      
      if (freshTasks) {
        // 更新缓存
        await this.persistence.saveTasks(freshTasks)
        
        if (callbacks.onAPIRestore) {
          callbacks.onAPIRestore({
            tasks: freshTasks
          })
        }
      }

      // Layer 3: SSE 事件流会在外部连接
      console.log('[StateRestorationManager] Layer 3: SSE will connect separately')
      
      if (callbacks.onSSEConnect) {
        callbacks.onSSEConnect()
      }

      console.log('[StateRestorationManager] Restoration completed')
    } catch (error) {
      console.error('[StateRestorationManager] Restoration failed:', error)
    } finally {
      this.isRestoring = false
    }
  }

  /**
   * 获取最新任务数据
   * @private
   * @async
   * @returns {Promise<Array|null>}
   */
  async fetchFreshTasks() {
    try {
      // 动态导入以避免循环依赖
      const { tasksAPI } = await import('./api-client.js')
      const tasks = await tasksAPI.listTasks()
      return tasks
    } catch (error) {
      console.error('[StateRestorationManager] Failed to fetch fresh tasks:', error)
      return null
    }
  }

  /**
   * 获取恢复状态
   * @public
   * @returns {boolean} 是否正在恢复
   */
  getIsRestoring() {
    return this.isRestoring
  }
}

export default {
  StatePersistence,
  StateRestorationManager
}
