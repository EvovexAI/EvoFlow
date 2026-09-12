/**
 * 浮动任务面板
 * 文件：evopanel/src/components/FloatingTaskPanel.js
 * 
 * 可拖动、可调整大小、支持快捷键的全局任务面板
 * 快捷键可在 设置 → 快捷键 中修改
 */

import { tasksAPI } from '../lib/api-client.js'
import { EventStreamManager, EventTypes } from '../lib/event-stream.js'
import {
  getShortcutBinding,
  shortcutMatchesEvent,
  formatShortcutDisplay,
} from '../lib/keyboard-shortcuts.js'

/**
 * 浮动任务面板类
 */
export class FloatingTaskPanel {
  /**
   * @param {Object} options - 配置选项
   * @param {Object} [options.position] - 初始位置
   * @param {number} [options.position.x=100] - X 坐标
   * @param {number} [options.position.y=100] - Y 坐标
   * @param {Object} [options.size] - 初始大小
   * @param {number} [options.size.width=450] - 宽度
   * @param {number} [options.size.height=550] - 高度
   */
  constructor(options = {}) {
    this.panelEl = null
    this.isOpen = false
    this.isMinimized = false
    this.position = {
      x: options.position?.x || 100,
      y: options.position?.y || 100
    }
    this.size = {
      width: options.size?.width || 450,
      height: options.size?.height || 550
    }
    this.isDragging = false
    this.isResizing = false
    this.dragStart = { x: 0, y: 0 }
    this.tasks = []
    this.eventStream = null
    this.streamTaskId = null
    this.onCloseCallback = null
    this._keydownHandler = null
    
    this.init()
  }

  /**
   * 初始化
   * @private
   */
  init() {
    this._keydownHandler = (e) => {
      const binding = getShortcutBinding('toggleTaskPanel')
      if (shortcutMatchesEvent(binding, e)) {
        e.preventDefault()
        this.toggle()
      }
      if (e.key === 'Escape' && this.isOpen && !this.isMinimized) {
        this.minimize()
      }
    }
    window.addEventListener('keydown', this._keydownHandler)
    this.restoreState()
  }

  /**
   * 打开面板
   * @public
   * @async
   */
  async open() {
    if (this.panelEl) {
      this.panelEl.style.display = 'flex'
      this.isOpen = true
      await this.update()
      return
    }

    this.panelEl = document.createElement('div')
    this.panelEl.className = 'floating-task-panel'
    this.panelEl.style.cssText = `
      position: fixed;
      z-index: 9999;
      left: ${this.position.x}px;
      top: ${this.position.y}px;
      width: ${this.size.width}px;
      height: ${this.size.height}px;
      background: var(--bg-primary, #1a1a1a);
      border: 1px solid var(--border-primary, #333);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `

    this.panelEl.innerHTML = this.renderHTML()
    document.body.appendChild(this.panelEl)

    this.setupEvents()
    this.isOpen = true
    
    // 连接事件流
    this.connectEventStream()
    
    await this.update()
    this.saveState()
  }

  /**
   * 连接事件流
   * @private
   */
  async connectEventStream() {
    try {
      // 取一个活跃任务的主任务 id 订阅 SSE（与网关 /api/events/tasks/{id}/stream 一致）
      const allTasks = await tasksAPI.listTasks()
      const activeTasks = allTasks.filter(t => 
        t.status === 'executing' || t.status === 'planning'
      )
      
      if (activeTasks.length > 0 && activeTasks[0].id) {
        this.streamTaskId = activeTasks[0].id

        this.eventStream = EventStreamManager.getInstance().getStream(this.streamTaskId)
        
        // 监听各类事件
        this.eventStream.on(EventTypes.TASK_PROGRESS, (data) => {
          this.updateTaskProgress(data.task_id, data.progress, data.current_step)
        })
        
        this.eventStream.on(EventTypes.TASK_COMPLETED, (data) => {
          this.updateTaskStatus(data.task_id, 'completed', data.result)
        })
        
        this.eventStream.on(EventTypes.TASK_CREATED, (data) => {
          this.handleTaskCreated(data.task)
        })
        
        this.eventStream.connect()
      }
    } catch (error) {
      console.error('[FloatingTaskPanel] Failed to connect event stream:', error)
    }
  }

  /**
   * 渲染 HTML
   * @private
   * @returns {string} HTML 字符串
   */
  renderHTML() {
    return `
      <div class="task-panel-header">
        <div class="task-panel-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          <span>任务进度</span>
          <span class="task-panel-badge" id="task-panel-badge">0 个任务</span>
        </div>
        <div class="task-panel-actions">
          <button class="task-panel-btn" id="btn-panel-minimize" title="最小化 (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button class="task-panel-btn" id="btn-panel-close" title="关闭 (${formatShortcutDisplay(getShortcutBinding('toggleTaskPanel'))})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      
      <div class="task-panel-content">
        <div class="task-overall-progress">
          <div class="task-progress-header">
            <span>总进度</span>
            <span id="task-overall-percent">0%</span>
          </div>
          <div class="task-progress-bar">
            <div class="task-progress-fill" id="task-overall-fill" style="width: 0%"></div>
          </div>
        </div>
        
        <div class="task-stats-grid">
          <div class="task-stat-card completed">
            <div class="task-stat-value" id="task-stat-completed">0</div>
            <div class="task-stat-label">已完成</div>
          </div>
          <div class="task-stat-card running">
            <div class="task-stat-value" id="task-stat-running">0</div>
            <div class="task-stat-label">进行中</div>
          </div>
          <div class="task-stat-card total">
            <div class="task-stat-value" id="task-stat-total">0</div>
            <div class="task-stat-label">总计</div>
          </div>
        </div>
        
        <div class="task-list" id="task-list">
          <div class="task-list-empty">暂无任务</div>
        </div>
      </div>
      
      <div class="task-panel-resize" id="task-panel-resize"></div>
    `
  }

  /**
   * 设置事件监听
   * @private
   */
  setupEvents() {
    const header = this.panelEl.querySelector('.task-panel-header')
    const closeBtn = this.panelEl.querySelector('#btn-panel-close')
    const minimizeBtn = this.panelEl.querySelector('#btn-panel-minimize')
    const resizeHandle = this.panelEl.querySelector('#task-panel-resize')

    // 拖动功能
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.task-panel-actions')) return
      this.isDragging = true
      this.dragStart = {
        x: e.clientX - this.position.x,
        y: e.clientY - this.position.y
      }

      const onMouseMove = (e) => {
        if (!this.isDragging) return
        this.position.x = e.clientX - this.dragStart.x
        this.position.y = e.clientY - this.dragStart.y
        this.panelEl.style.left = `${this.position.x}px`
        this.panelEl.style.top = `${this.position.y}px`
      }

      const onMouseUp = () => {
        this.isDragging = false
        this.saveState()
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    })

    // 关闭按钮
    closeBtn.addEventListener('click', () => this.close())

    // 最小化按钮
    minimizeBtn.addEventListener('click', () => {
      this.minimize()
    })

    // 调整大小
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.isResizing = true
      this.dragStart = {
        x: e.clientX,
        y: e.clientY,
        width: this.size.width,
        height: this.size.height
      }

      const onMouseMove = (e) => {
        if (!this.isResizing) return
        const deltaX = e.clientX - this.dragStart.x
        const deltaY = e.clientY - this.dragStart.y
        this.size.width = Math.max(350, this.dragStart.width + deltaX)
        this.size.height = Math.max(400, this.dragStart.height + deltaY)
        this.panelEl.style.width = `${this.size.width}px`
        this.panelEl.style.height = `${this.size.height}px`
      }

      const onMouseUp = () => {
        this.isResizing = false
        this.saveState()
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    })
  }

  /**
   * 更新面板数据
   * @public
   * @async
   */
  async update() {
    if (!this.isOpen || !this.panelEl) return

    try {
      const allTasks = await tasksAPI.listTasks()
      const { syncPlanExecHoldFromTaskList } = await import('../lib/gateway-exec-hold.js')
      syncPlanExecHoldFromTaskList(allTasks)
      this.tasks = allTasks.filter(t =>
        t.status === 'planned' ||
        t.status === 'executing' ||
        t.status === 'planning' ||
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'pending'
      )

      const completedCount = this.tasks.filter(t => t.status === 'completed').length
      const runningCount = this.tasks.filter(t => !['completed', 'failed', 'cancelled'].includes(t.status)).length
      const totalCount = this.tasks.length
      const overallProgress = totalCount > 0 
        ? Math.round((completedCount / totalCount) * 100) 
        : 0

      // 更新统计
      const completedEl = this.panelEl.querySelector('#task-stat-completed')
      const runningEl = this.panelEl.querySelector('#task-stat-running')
      const totalEl = this.panelEl.querySelector('#task-stat-total')
      const overallPercentEl = this.panelEl.querySelector('#task-overall-percent')
      const overallFillEl = this.panelEl.querySelector('#task-overall-fill')
      const badgeEl = this.panelEl.querySelector('#task-panel-badge')

      if (completedEl) completedEl.textContent = completedCount
      if (runningEl) runningEl.textContent = runningCount
      if (totalEl) totalEl.textContent = totalCount
      if (overallPercentEl) overallPercentEl.textContent = `${overallProgress}%`
      if (overallFillEl) overallFillEl.style.width = `${overallProgress}%`
      if (badgeEl) badgeEl.textContent = `${totalCount} 个任务`

      // 更新任务列表
      const taskListEl = this.panelEl.querySelector('#task-list')
      if (totalCount === 0) {
        taskListEl.innerHTML = '<div class="task-list-empty">暂无任务</div>'
      } else {
        taskListEl.innerHTML = this.tasks.map(task => this.renderTaskItem(task)).join('')
      }
    } catch (error) {
      console.error('[FloatingTaskPanel] Failed to update:', error)
    }
  }

  /**
   * 渲染单个任务项
   * @private
   * @param {Object} task - 任务对象
   * @returns {string} HTML 字符串
   */
  renderTaskItem(task) {
    const statusIcon = this.getStatusIcon(task.status)
    const taskName = this.escapeHtml(task.name || '未命名任务')
    const progress = task.progress || 0
    const statusClass = task.status.toLowerCase()
    
    return `
      <div class="task-panel-item ${statusClass}">
        <div class="task-item-header">
          ${statusIcon}
          <span class="task-item-title">${taskName}</span>
        </div>
        <div class="task-item-progress">
          <div class="task-progress-bar">
            <div class="task-progress-fill" style="width: ${progress}%"></div>
          </div>
          <span class="task-progress-text">${progress}%</span>
        </div>
        ${task.current_step ? `
          <div class="task-item-step">${this.escapeHtml(task.current_step)}</div>
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
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="text-green-500"><polyline points="20 6 9 17 4 12"/></svg>'
      case 'executing':
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="animate-spin text-blue-500"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>'
      case 'failed':
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="text-red-500"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      default:
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/></svg>'
    }
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
   * 更新任务进度
   * @public
   * @param {string} taskId - 任务 ID
   * @param {number} progress - 进度百分比
   * @param {string} [currentStep] - 当前步骤
   */
  updateTaskProgress(taskId, progress, currentStep) {
    const task = this.tasks.find(t => t.id === taskId)
    if (task) {
      task.progress = progress
      if (currentStep) {
        task.current_step = currentStep
      }
      this.update()
    }
  }

  /**
   * 更新任务状态
   * @public
   * @param {string} taskId - 任务 ID
   * @param {string} status - 新状态
   * @param {any} [result] - 结果
   */
  updateTaskStatus(taskId, status, result) {
    const task = this.tasks.find(t => t.id === taskId)
    if (task) {
      task.status = status
      if (result !== undefined) {
        task.result = result
      }
      this.update()
    }
  }

  /**
   * 处理任务创建
   * @private
   * @param {Object} task - 任务对象
   */
  handleTaskCreated(task) {
    if (task.status === 'executing' || task.status === 'planning') {
      this.tasks.push(task)
      this.update()
    }
  }

  /**
   * 最小化面板
   * @public
   */
  minimize() {
    if (!this.panelEl) return
    
    this.isMinimized = !this.isMinimized
    const content = this.panelEl.querySelector('.task-panel-content')
    const resizeHandle = this.panelEl.querySelector('#task-panel-resize')
    const minimizeBtn = this.panelEl.querySelector('#btn-panel-minimize')
    
    if (this.isMinimized) {
      content.style.display = 'none'
      resizeHandle.style.display = 'none'
      minimizeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="8 4 12 8 8 12"/></svg>'
    } else {
      content.style.display = 'block'
      resizeHandle.style.display = 'block'
      minimizeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="5" y1="12" x2="19" y2="12"/></svg>'
    }
  }

  /**
   * 关闭面板
   * @public
   */
  close() {
    if (this.panelEl) {
      this.panelEl.style.display = 'none'
    }
    this.isOpen = false
    this.saveState()
    
    if (this.onCloseCallback) {
      this.onCloseCallback()
    }
  }

  /**
   * 切换面板状态
   * @public
   * @async
   */
  async toggle() {
    if (this.isOpen) {
      this.close()
    } else {
      await this.open()
    }
  }

  /**
   * 保存状态到 localStorage
   * @private
   */
  saveState() {
    try {
      const state = {
        isOpen: this.isOpen,
        position: this.position,
        size: this.size,
        isMinimized: this.isMinimized
      }
      localStorage.setItem('evoflow_panel_state', JSON.stringify(state))
    } catch (error) {
      console.error('[FloatingTaskPanel] Failed to save state:', error)
    }
  }

  /**
   * 从 localStorage 恢复状态
   * @private
   */
  restoreState() {
    try {
      const cached = localStorage.getItem('evoflow_panel_state')
      if (!cached) return
      
      const state = JSON.parse(cached)
      if (state.position) {
        this.position = state.position
      }
      if (state.size) {
        this.size = state.size
      }
      if (state.isMinimized !== undefined) {
        this.isMinimized = state.isMinimized
      }
    } catch (error) {
      console.error('[FloatingTaskPanel] Failed to restore state:', error)
    }
  }

  /**
   * 销毁面板
   * @public
   */
  destroy() {
    if (this.panelEl) {
      this.panelEl.remove()
    }
    if (this.eventStream) {
      this.eventStream.disconnect()
    }
    this.panelEl = null
    this.isOpen = false
  }

  /**
   * 设置关闭回调
   * @public
   * @param {Function} callback - 回调函数
   */
  onClose(callback) {
    this.onCloseCallback = callback
  }
}

export default FloatingTaskPanel
