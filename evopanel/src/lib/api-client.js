/**
 * 任务管理 API 客户端
 * 文件：evopanel/src/lib/api-client.js
 * 
 * 封装所有与任务管理相关的后端 API 调用
 * 参考文档：EvoFlow 前端实现进度.md - Task 1.1
 */

/**
 * API 路径解析：
 * - Vite dev（非 Tauri）：走相对路径 `/api/*`（由 vite proxy 转发到 gateway）
 * - Tauri：直连 Gateway（通过 Rust get_gateway_base_url 获取实际地址）
 * - 生产 Web：直连 gateway（默认 http://localhost:38012）
 */
const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

/** @type {string | null} */
let _cachedTauriGatewayBase = null

async function _refreshTauriGatewayBase() {
  if (!isTauri) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const base = await invoke('get_gateway_base_url')
    if (typeof base === 'string' && base.trim()) {
      _cachedTauriGatewayBase = base.trim().replace(/\/+$/, '')
    }
  } catch {
    // fall through
  }
}

// 模块加载时立即异步刷新 Gateway 地址（invoke 是本地调用，通常毫秒级完成）
if (isTauri) {
  _refreshTauriGatewayBase()
}

function envGatewayBaseUrl() {
  try {
    const env = (import.meta && import.meta.env) || {}
    const url = env.VITE_EVOFLOW_GATEWAY_URL || ''
    if (typeof url === 'string' && url.trim()) return url.trim().replace(/\/+$/, '')
    const port = parseInt(String(env.VITE_EVOFLOW_GATEWAY_PORT || '').trim(), 10)
    if (Number.isFinite(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
  } catch {
    // ignore
  }
  return null
}

function guessGatewayBaseUrl() {
  const fromEnv = envGatewayBaseUrl()
  if (fromEnv) return fromEnv
  if (isTauri) {
    if (_cachedTauriGatewayBase) return _cachedTauriGatewayBase
    return ''
  }
  const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : ''
  if (!origin) return 'http://localhost:38012'
  if (origin.includes(':1420') || origin.includes(':1421') || origin.includes(':1521')) return origin
  if (origin === 'http://localhost' || /^http:\/\/localhost:\d+$/.test(origin)) {
    return origin.replace(/(:\d+)?$/, ':38012')
  }
  return origin
}

/** @param {string} path e.g. `/settings/media` or `settings/media` */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  // Tauri 桌面端：直连 Gateway，不走 Vite 代理
  if (isTauri) {
    const base = _cachedTauriGatewayBase || guessGatewayBaseUrl()
    return `${base}/api${p}`
  }
  // Vite dev：保留相对路径走 proxy
  try {
    if (import.meta && import.meta.env && import.meta.env.DEV) return `/api${p}`
  } catch {
    // ignore
  }
  // 生产 Web：直连 gateway
  const base = guessGatewayBaseUrl()
  return `${base}/api${p}`
}

/** Tauri 下读取 sidecar 实际 Gateway 端口（供截图等 `<img src>` 直连）。 */
export async function getGatewayBaseUrl() {
  if (isTauri) {
    const fromEnv = envGatewayBaseUrl()
    if (fromEnv) return fromEnv
    await _refreshTauriGatewayBase()
    return _cachedTauriGatewayBase || envGatewayBaseUrl() || ''
  }
  try {
    if (import.meta?.env?.DEV) return ''
  } catch {
    // ignore
  }
  const fromEnv = envGatewayBaseUrl()
  if (fromEnv) return fromEnv
  return guessGatewayBaseUrl()
}

/** 异步版 apiUrl（Tauri 打包后需读 runtime 端口）。 */
export async function apiUrlAsync(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  if (isTauri) {
    await _refreshTauriGatewayBase()
    const base = _cachedTauriGatewayBase || envGatewayBaseUrl()
    return base ? `${base}/api${p}` : `/api${p}`
  }
  try {
    if (import.meta && import.meta.env && import.meta.env.DEV) return `/api${p}`
  } catch {
    // ignore
  }
  const base = await getGatewayBaseUrl()
  return `${base}/api${p}`
}

async function tauriTasksApi() {
  const m = await import('./tauri-api.js')
  return m.api
}

/**
 * 任务管理 API 客户端
 */
export const tasksAPI = {
  /**
   * 获取任务列表；传 threadId 时只查该会话绑定主任务（GET /tasks?thread_id=…）
   * @param {{ threadId?: string, sessionKey?: string, preferTaskId?: string }} [options]
   * @returns {Promise<Array|Object>} 任务列表或 Gateway 包装体
   */
  async listTasks(options = {}) {
    const threadId = String(options.threadId || options.thread_id || '').trim()
    const sessionKey = String(options.sessionKey || options.session_key || '').trim()
    const preferTaskId = String(options.preferTaskId || options.prefer_task_id || '').trim()
    const qs = new URLSearchParams()
    if (sessionKey) qs.set('session_key', sessionKey)
    if (threadId) qs.set('thread_id', threadId)
    if (preferTaskId) qs.set('prefer_task_id', preferTaskId)
    const query = qs.toString()
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.listAllTasks(query ? Object.fromEntries(qs.entries()) : null)
      }
      const response = await fetch(apiUrl(`/tasks${query ? `?${query}` : ''}`))
      if (!response.ok) throw new Error(`Failed to fetch tasks: ${response.status} ${response.statusText}`)
      return await response.json()
    } catch (error) {
      console.error('Error fetching tasks:', error)
      throw error
    }
  },

  /**
   * 获取单个任务详情
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 任务对象
   */
  async getTask(taskId) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.getTask(taskId)
      }
      const response = await fetch(apiUrl(`/tasks/${taskId}`))
      if (!response.ok) {
        if (response.status === 404) throw new Error(`Task not found: ${taskId}`)
        throw new Error(`Failed to get task: ${response.status} ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error fetching task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 创建新任务
   * @param {Object} taskData - 任务数据
   * @param {string} taskData.name - 任务名称
   * @param {string} taskData.description - 任务描述
   * @param {string} [taskData.thread_id] - 绑定的线程 ID（可选）
   * @returns {Promise<Object>} 创建的任务对象
   */
  async createTask(taskData) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.createTask(
          String(taskData?.name || ''),
          String(taskData?.description || ''),
          String(taskData?.run_mode || taskData?.runMode || 'unattended'),
        )
      }
      const response = await fetch(apiUrl('/tasks'), {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(taskData)
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to create task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error('Error creating task:', error)
      throw error
    }
  },

  /**
   * 启动任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 操作结果
   */
  async startTask(taskId) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.startTaskPlanning(taskId)
      }
      const response = await fetch(apiUrl(`/tasks/${taskId}/start`), {
        method: 'POST',
        headers: { 
          'Accept': 'application/json'
        }
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to start task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error starting task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 停止任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 操作结果
   */
  async stopTask(taskId) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.stopTaskExecution(taskId)
      }
      const response = await fetch(apiUrl(`/tasks/${taskId}/stop`), {
        method: 'POST',
        headers: { 
          'Accept': 'application/json'
        }
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to stop task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error stopping task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 暂停任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 操作结果
   */
  async pauseTask(taskId) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/stop`), {
        method: 'POST',
        headers: {
          'Accept': 'application/json'
        }
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to pause task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error pausing task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 恢复任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 操作结果
   */
  async resumeTask(taskId) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/resume`), {
        method: 'POST',
        headers: {
          'Accept': 'application/json'
        }
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to resume task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error resuming task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 取消任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 操作结果
   */
  async cancelTask(taskId) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/cancel`), {
        method: 'POST',
        headers: { 
          'Accept': 'application/json'
        }
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to cancel task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error cancelling task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 撤销任务执行授权
   * @param {string} taskId - 任务 ID
   * @param {Object} options - 选项
   * @param {string} [options.authorized_by] - 授权者（默认 user）
   * @param {string} [options.thread_id] - LangGraph thread_id（写入 collab 状态）
   * @returns {Promise<Object>} 操作结果
   */
  async revokeTaskExecutionAuthorization(taskId, options = {}) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/revoke-execution-authorization`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          authorized_by: options.authorized_by || 'user',
          ...(options.thread_id ? { thread_id: options.thread_id } : {}),
        }),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to revoke authorization: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error revoking authorization for task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 授权任务执行（真正开始执行）
   * @param {string} taskId - 任务 ID
   * @param {Object} options - 选项
   * @param {string} [options.authorized_by] - 授权者（默认 user）
   * @param {string} [options.thread_id] - LangGraph thread_id（写入 collab 状态）
   * @returns {Promise<Object>} 操作结果
   */
  /**
   * 对已授权任务仅重试派发（不向主对话注入用户消息）
   * @param {string} taskId
   * @param {Object} [options]
   * @param {string} [options.thread_id]
   */
  async dispatchTaskExecution(taskId, options = {}) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/dispatch-execution`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          authorized_by: options.authorized_by || 'user',
          ...(options.thread_id ? { thread_id: options.thread_id } : {}),
        }),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to dispatch task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error dispatching task ${taskId}:`, error)
      throw error
    }
  },

  async authorizeTaskExecution(taskId, options = {}) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/authorize-execution`), {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          authorized_by: options.authorized_by || 'user',
          ...(options.thread_id ? { thread_id: options.thread_id } : {}),
        })
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const detail = errorData?.detail
        const msg =
          typeof detail === 'string'
            ? detail
            : detail && typeof detail === 'object' && typeof detail.message === 'string'
              ? detail.message
              : `Failed to authorize task: ${response.status}`
        throw new Error(msg)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error authorizing task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 更新任务
   * @param {string} taskId - 任务 ID
   * @param {Object} updates - 更新数据
   * @param {string} [updates.status] - 任务状态
   * @param {number} [updates.progress] - 进度百分比
   * @param {any} [updates.result] - 执行结果
   * @returns {Promise<Object>} 更新后的任务对象
   */
  async updateTask(taskId, updates) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.updateTask(taskId, updates || {})
      }
      const response = await fetch(apiUrl(`/tasks/${taskId}`), {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(updates)
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to update task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error updating task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 获取子任务列表
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Array>} 子任务列表
   */
  async listSubtasks(taskId) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.listSubtasks(taskId)
      }
      const response = await fetch(apiUrl(`/tasks/${taskId}/subtasks`))
      if (!response.ok) {
        throw new Error(`Failed to fetch subtasks: ${response.status} ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error fetching subtasks for task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 获取任务/子任务详情（task_id 既可传主任务 id，也可传 subtask id）
   * @param {string} taskId - 任务或子任务 ID
   * @returns {Promise<Object>} 详情快照
   */
  async getTaskMemory(taskId) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.getTaskMemory(taskId)
      }
      const response = await fetch(apiUrl(`/task-detail/tasks/${taskId}`))
      if (!response.ok) {
        throw new Error(`Failed to fetch task detail: ${response.status} ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error fetching task detail for ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 获取子任务历史对话结构（持久化 conversation）。
   * @param {string} taskId - 主任务 ID
   * @param {string} subtaskId - 子任务 ID
   * @param {number} [limit=600] - 最多读取条数
   * @returns {Promise<{task_id:string, subtask_id:string, count:number, messages:Array}>}
   */
  /**
   * 向子任务 worker 会话发送续聊消息（与主界面多轮对话同类，保留会话上下文）。
   * @param {string} taskId
   * @param {string} subtaskId
   * @param {string} message
   * @param {{ keepSessionOpen?: boolean, waitForCompletion?: boolean }} [opts]
   */
  async continueSubtaskSession(taskId, subtaskId, message, opts = {}) {
    const mid = String(taskId || '').trim()
    const sid = String(subtaskId || '').trim()
    const text = String(message || '').trim()
    if (!mid || !sid || !text) {
      throw new Error('taskId, subtaskId and message are required')
    }
    const keepSessionOpen = opts.keepSessionOpen !== false
    const waitForCompletion = opts.waitForCompletion !== false
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.continueSubtaskSession(mid, sid, text, { keepSessionOpen, waitForCompletion })
      }
      const response = await fetch(
        apiUrl(
          `/tasks/${encodeURIComponent(mid)}/subtasks/${encodeURIComponent(sid)}/continue-session`,
        ),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            message: text,
            keep_session_open: keepSessionOpen,
            wait_for_completion: waitForCompletion,
          }),
        },
      )
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || errorData.message || `Failed to continue subtask session: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error continuing subtask session main=${taskId} sub=${subtaskId}:`, error)
      throw error
    }
  },

  async getSubtaskConversationHistory(taskId, subtaskId, limit = 600, opts = {}) {
    try {
      const { fetchSubtaskConversationHistory } = await import('./subtask-conversation-history.js')
      const options = opts && typeof opts === 'object' ? opts : {}
      return await fetchSubtaskConversationHistory({
        mainTaskId: taskId,
        subtaskId,
        leadThreadId: options.leadThreadId,
        storedSubtaskThreadId: options.storedSubtaskThreadId,
        subtaskSnapshot: options.subtaskSnapshot,
        limit,
      })
    } catch (error) {
      console.error(`Error fetching subtask conversation history main=${taskId} sub=${subtaskId}:`, error)
      throw error
    }
  },

  /**
   * 发送对话消息
   * @param {string} taskId - 任务 ID
   * @param {string} content - 消息内容
   * @param {string} threadId - 线程 ID
   * @returns {Promise<Object>} 发送结果 {success, message_id}
   */
  async sendMessage(taskId, content, threadId) {
    try {
      const response = await fetch(apiUrl(`/tasks/${taskId}/conversation/message`), {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ 
          content, 
          thread_id: threadId 
        })
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to send message: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error sending message for task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 删除任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 删除结果
   */
  async deleteTask(taskId) {
    try {
      if (isTauri) {
        const api = await tauriTasksApi()
        return await api.deleteTask(taskId)
      }
      const response = await fetch(apiUrl(`/tasks/${taskId}`), {
        method: 'DELETE',
        headers: { 
          'Accept': 'application/json'
        }
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || `Failed to delete task: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error deleting task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 获取任务执行历史列表
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object>} 执行历史列表
   */
  async getExecutionHistory(taskId) {
    try {
      const url = apiUrl(`/tasks/${taskId}/execution-history`)
      const response = await fetch(url)
      if (!response.ok) {
        if (response.status === 404) {
          return {
            task_id: taskId,
            current_thread_id: null,
            execution_history: [],
            total_executions: 0,
          }
        }
        throw new Error(`Failed to fetch execution history: ${response.status} ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error fetching execution history for task ${taskId}:`, error)
      throw error
    }
  },

  /**
   * 获取指定执行的输出
   * @param {string} taskId - 任务 ID
   * @param {string} executionId - 执行记录 ID
   * @param {Object} options - 查询选项
   * @param {number} [options.limit=100] - 每页数量
   * @returns {Promise<Object>} 执行输出对象
   */
  async getExecutionOutput(taskId, executionId, options = {}) {
    try {
      const params = new URLSearchParams()
      if (options.limit !== undefined) params.append('limit', options.limit)
      
      const queryString = params.toString()
      const url = apiUrl(`/tasks/${taskId}/execution-history/${executionId}/output${queryString ? '?' + queryString : ''}`)
      
      const response = await fetch(url)
      if (!response.ok) {
        if (response.status === 404) {
          return {
            execution_id: executionId,
            thread_id: null,
            entries: [],
            message: "Execution not found",
          }
        }
        throw new Error(`Failed to fetch execution output: ${response.status} ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      console.error(`Error fetching execution output for task ${taskId}, execution ${executionId}:`, error)
      throw error
    }
  },

  /**
   * RunManager 聚合输出：取最近一次 execution 的 output 条目（网关无独立 /output 时返回空列表）。
   * @param {string} taskId
   * @param {{ offset?: number, limit?: number, from_timestamp?: string }} [options]
   * @returns {Promise<{ entries: any[], pagination?: { has_more?: boolean } }>}
   */
  async getTaskOutput(taskId, options = {}) {
    const empty = { entries: [], pagination: { has_more: false } }
    try {
      const hist = await this.getExecutionHistory(taskId)
      const execs = Array.isArray(hist?.execution_history) ? hist.execution_history : []
      if (!execs.length) return empty
      const last = execs[execs.length - 1]
      const eid = String(last?.execution_id || last?.executionId || '').trim()
      if (!eid) return empty
      const data = await this.getExecutionOutput(taskId, eid, {
        limit: options?.limit ?? 50,
      })
      const entries = Array.isArray(data?.entries) ? data.entries : []
      return {
        entries,
        pagination: data?.pagination || { has_more: false },
      }
    } catch (e) {
      console.error(`Error fetching task output for ${taskId}:`, e)
      return empty
    }
  },

}

/**
 * 错误处理工具函数
 */
export class APIError extends Error {
  constructor(message, statusCode, data = null) {
    super(message)
    this.name = 'APIError'
    this.statusCode = statusCode
    this.data = data
  }
}

/**
 * 重试工具函数
 * @param {Function} fn - 要重试的函数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} delay - 重试间隔（毫秒）
 * @returns {Promise<any>}
 */
export async function withRetry(fn, maxRetries = 3, delay = 1000) {
  let lastError
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      
      // 如果是 4xx 错误，不重试
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        throw error
      }
      
      // 最后一次尝试失败
      if (attempt === maxRetries) {
        break
      }
      
      // 等待后重试（指数退避）
      const waitTime = delay * Math.pow(2, attempt - 1)
      console.warn(`Attempt ${attempt} failed, retrying in ${waitTime}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }
  }
  
  throw lastError
}

export default tasksAPI
