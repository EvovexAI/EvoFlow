/**
 * 嵌入式任务仪表板
 * 文件：evopanel/src/components/EmbeddedTaskDashboard.js
 * 
 * 显示在聊天页面中，当有 2 个及以上并行任务时自动显示
 * 实时展示任务进度和统计信息
 * 参考文档：EvoFlow 前端实现进度.md - Task 2.1
 */

import { tasksAPI } from '../lib/api-client.js'
import { EventStreamManager, EventTypes } from '../lib/event-stream.js'

/**
 * 嵌入式任务仪表板类
 */
export class EmbeddedTaskDashboard {
  /**
   * @param {HTMLElement} container - 容器元素
   * @param {Object} options - 配置选项
   * @param {boolean} [options.autoRefresh=true] - 是否自动刷新
   * @param {number} [options.refreshInterval=5000] - 刷新间隔（毫秒）
   */
  constructor(container, options = {}) {
    this.container = container
    this.options = {
      autoRefresh: true,
      refreshInterval: 5000,
      ...options
    }
    
    this.tasks = []
    this.eventStream = null
    this.refreshTimer = null
    this.streamTaskId = null
    this.isVisible = false
    this._loading = false
    
    this.render()
  }

  /**
   * 加载任务数据
   * @public
   * @async
   */
  async loadTasks() {
    if (this._loading) return
    this._loading = true
    try {
      const allTasks = await tasksAPI.listTasks()
      // 筛选执行中的任务（planning 和 executing 状态）
      this.tasks = allTasks.filter(task => 
        task.status === 'executing' || 
        task.status === 'planning' ||
        task.status === 'paused'
      )
      
      if (this.tasks.length > 0 && this.tasks[0].id) {
        this.streamTaskId = this.tasks[0].id
        this.connectEventStream(this.streamTaskId)
      }
      
      this.render()
    } catch (error) {
      console.error('[EmbeddedTaskDashboard] Failed to load tasks:', error)
      // 显示错误状态
      this.showError('加载任务失败')
    } finally {
      this._loading = false
    }
  }

  /**
   * 连接事件流
   * @private
   * @param {string} mainTaskId - 协作主任务 ID
   */
  connectEventStream(mainTaskId) {
    if (this.eventStream) {
      this.eventStream.disconnect()
    }

    this.eventStream = EventStreamManager.getInstance().getStream(mainTaskId)
    
    // 监听任务进度更新
    this.eventStream.on(EventTypes.TASK_PROGRESS, (data) => {
      this.updateTaskProgress(data.task_id, data.progress, data.current_step)
    })

    // 监听任务完成
    this.eventStream.on(EventTypes.TASK_COMPLETED, (data) => {
      this.updateTaskStatus(data.task_id, 'completed', data.result)
    })

    // 监听任务失败
    this.eventStream.on(EventTypes.TASK_FAILED, (data) => {
      this.updateTaskStatus(data.task_id, 'failed', data.error)
    })

    // 监听任务创建
    this.eventStream.on(EventTypes.TASK_CREATED, (data) => {
      this.handleTaskCreated(data.task)
    })

    this.eventStream.connect()
  }

  /**
   * 处理任务创建
   * @private
   * @param {Object} task - 任务对象
   */
  handleTaskCreated(task) {
    if (task.status === 'executing' || task.status === 'planning') {
      this.tasks.push(task)
      this.render()
    }
  }

  /**
   * 更新任务进度
   * @public
   * @param {string} taskId - 任务 ID
   * @param {number} progress - 进度百分比
   * @param {string} [currentStep] - 当前步骤描述
   */
  updateTaskProgress(taskId, progress, currentStep) {
    const task = this.tasks.find(t => t.id === taskId)
    if (task) {
      task.progress = progress
      if (currentStep) {
        task.current_step = currentStep
      }
      this.render()
    }
  }

  /**
   * 更新任务状态
   * @public
   * @param {string} taskId - 任务 ID
   * @param {string} status - 新状态
   * @param {any} [result] - 执行结果或错误信息
   */
  updateTaskStatus(taskId, status, result) {
    const task = this.tasks.find(t => t.id === taskId)
    if (task) {
      task.status = status
      if (result !== undefined) {
        task.result = result
      }
      
      // 如果任务完成或失败，从列表中移除
      if (status === 'completed' || status === 'failed') {
        setTimeout(() => {
          this.tasks = this.tasks.filter(t => t.id !== taskId)
          this.render()
        }, 2000) // 2 秒后移除，让用户看到完成状态
      } else {
        this.render()
      }
    }
  }

  /**
   * 渲染组件
   * @private
   */
  render() {
    // 如果任务少于 2 个，隐藏仪表板
    if (this.tasks.length < 2) {
      this.container.style.display = 'none'
      this.isVisible = false
      return
    }

    this.container.style.display = 'block'
    this.isVisible = true
    
    // 计算统计信息
    const completedCount = this.tasks.filter(t => t.status === 'completed').length
    const runningCount = this.tasks.filter(t => t.status === 'executing').length
    const pausedCount = this.tasks.filter(t => t.status === 'paused').length
    const totalCount = this.tasks.length
    const overallProgress = totalCount > 0 
      ? Math.round((completedCount / totalCount) * 100) 
      : 0

    this.container.innerHTML = `
      <div class="embedded-task-dashboard">
        <div class="task-dashboard-card">
          <div class="task-dashboard-header">
            <div class="task-dashboard-title">
              ${this.renderIcon()}
              <span>并行任务</span>
              <span class="task-dashboard-badge">${totalCount} 个任务</span>
            </div>
            <div class="task-dashboard-stats">
              <span class="task-stat completed">✓ ${completedCount} 完成</span>
              <span class="task-stat running">🔄 ${runningCount} 进行中</span>
              ${pausedCount > 0 ? `<span class="task-stat paused">⏸ ${pausedCount} 暂停</span>` : ''}
            </div>
          </div>
          
          <div class="task-dashboard-progress">
            <div class="task-progress-bar">
              <div class="task-progress-fill" style="width: ${overallProgress}%"></div>
            </div>
            <span class="task-progress-text">${overallProgress}%</span>
          </div>
          
          <div class="task-dashboard-overview">
            ${this.tasks.map(task => this.renderTaskOverview(task)).join('')}
          </div>
        </div>
      </div>
    `
  }

  /**
   * 渲染单个任务概览
   * @private
   * @param {Object} task - 任务对象
   * @returns {string} HTML 字符串
   */
  renderTaskOverview(task) {
    const statusClass = task.status.toLowerCase()
    const statusIcon = this.getStatusIcon(task.status)
    const taskName = this.escapeHtml(task.name || '未命名任务')
    const progress = task.progress || 0
    
    return `
      <div class="task-overview-item ${statusClass}">
        <div class="task-overview-left">
          ${statusIcon}
          <span class="task-overview-label">${taskName}</span>
        </div>
        <div class="task-overview-right">
          <div class="task-overview-progress-bar">
            <div class="task-overview-progress-fill" style="width: ${progress}%"></div>
          </div>
          <span class="task-overview-progress">${progress}%</span>
        </div>
        ${task.current_step ? `
          <div class="task-overview-step">${this.escapeHtml(task.current_step)}</div>
        ` : ''}
      </div>
    `
  }

  /**
   * 获取状态图标
   * @private
   * @param {string} status - 状态
   * @returns {string} SVG 图标 HTML
   */
  getStatusIcon(status) {
    switch(status) {
      case 'completed':
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="task-icon-success">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `
      case 'executing':
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="task-icon-spin">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        `
      case 'failed':
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="task-icon-error">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        `
      case 'paused':
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="task-icon-paused">
            <rect x="6" y="4" width="4" height="16"/>
            <rect x="14" y="4" width="4" height="16"/>
          </svg>
        `
      default:
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <circle cx="12" cy="12" r="10"/>
          </svg>
        `
    }
  }

  /**
   * 渲染图标
   * @private
   * @returns {string} SVG 图标 HTML
   */
  renderIcon() {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
      </svg>
    `
  }

  /**
   * 显示错误信息
   * @private
   * @param {string} message - 错误消息
   */
  showError(message) {
    this.container.innerHTML = `
      <div class="embedded-task-dashboard">
        <div class="task-dashboard-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24" class="error-icon">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p>${this.escapeHtml(message)}</p>
        </div>
      </div>
    `
  }

  /**
   * HTML 转义
   * @private
   * @param {string} text - 原始文本
   * @returns {string} 转义后的 HTML
   */
  escapeHtml(text) {
    if (!text) return ''
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * 启动自动刷新
   * @public
   */
  startAutoRefresh() {
    if (this.options.autoRefresh && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        this.loadTasks()
      }, this.options.refreshInterval)
    }
  }

  /**
   * 停止自动刷新
   * @public
   */
  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /**
   * 销毁组件
   * @public
   */
  destroy() {
    this.stopAutoRefresh()
    if (this.eventStream) {
      this.eventStream.disconnect()
      this.eventStream = null
    }
    if (this.container) {
      this.container.innerHTML = ''
      this.container.style.display = 'none'
    }
    this.tasks = []
    this.isVisible = false
  }

  /**
   * 获取可见性
   * @public
   * @returns {boolean} 是否可见
   */
  getIsVisible() {
    return this.isVisible
  }

  /**
   * 获取任务列表
   * @public
   * @returns {Array} 任务列表
   */
  getTasks() {
    return [...this.tasks]
  }
}

export default EmbeddedTaskDashboard
