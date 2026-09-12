/**
 * 项目详情页面 - 多智能体协作任务执行与监控
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { notifyDesktopCompletion } from '../lib/desktop-notification.js'
import { showModal, showConfirm } from '../components/modal.js'

export async function render() {
  const projectId = extractProjectId()
  if (!projectId) {
    const page = document.createElement('div')
    page.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">无效的项目 ID，<a href="#/projects">返回项目列表</a></div>'
    return page
  }

  const page = document.createElement('div')
  page.className = 'page project-detail-page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <button class="btn btn-ghost" id="btn-back" style="margin-bottom:8px">
          <span>← 返回</span>
        </button>
        <h1 class="page-title" id="project-title">加载中...</h1>
        <p class="page-desc" id="project-desc"></p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-start-supervisor">启动 Supervisor</button>
        <button class="btn btn-secondary" id="btn-add-task">添加任务</button>
        <button class="btn btn-secondary" id="btn-refresh">刷新</button>
      </div>
    </div>

    <div class="project-detail-content">
      <div class="project-main">
        <div class="supervisor-panel" id="supervisor-panel" style="display:none">
          <div class="panel-header">
            <h3>🧠 Supervisor 面板</h3>
            <span class="supervisor-status" id="supervisor-status"></span>
          </div>
          <div class="supervisor-content" id="supervisor-content">
            <div class="supervisor-message" id="supervisor-message"></div>
            <div class="supervisor-actions" id="supervisor-actions"></div>
          </div>
        </div>

        <div class="tasks-section">
          <div class="section-header">
            <h3>📋 任务列表</h3>
            <div class="task-stats" id="task-stats"></div>
          </div>
          <div class="tasks-list" id="tasks-list"></div>
        </div>
      </div>

      <div class="project-sidebar">
        <div class="facts-panel">
          <h3>🧠 全局事实</h3>
          <div class="facts-search">
            <input class="form-input" id="facts-search" placeholder="搜索事实...">
          </div>
          <div class="facts-list" id="facts-list">
            <div class="facts-empty">暂无事实</div>
          </div>
        </div>

        <div class="agents-panel">
          <h3>🤖 Agent 状态</h3>
          <div class="agents-list" id="agents-list">
            <div class="agents-empty">暂无活跃 Agent</div>
          </div>
        </div>
      </div>
    </div>

    <div class="task-detail-modal" id="task-detail-modal" style="display:none">
      <div class="modal-backdrop" id="task-modal-backdrop"></div>
      <div class="task-detail-content">
        <div class="modal-header">
          <h3 id="task-detail-title">任务详情</h3>
          <button class="btn btn-ghost" id="task-detail-close">✕</button>
        </div>
        <div class="modal-body" id="task-detail-body"></div>
      </div>
    </div>
  `

  const state = {
    projectId,
    project: null,
    tasks: [],
    facts: [],
    agents: [],
    supervisorActive: false,
    eventSubscriptions: [],
  }

  page.querySelector('#btn-back').addEventListener('click', () => {
    window.location.hash = '#/projects'
  })

  page.querySelector('#btn-add-task').addEventListener('click', () => {
    showAddTaskDialog(page, state)
  })

  page.querySelector('#btn-start-supervisor').addEventListener('click', () => {
    startSupervisor(page, state)
  })

  page.querySelector('#btn-refresh').addEventListener('click', async () => {
    await loadProjectDetail(page, state)
    toast('已刷新', 'success')
  })

  page.querySelector('#facts-search').addEventListener('input', async (e) => {
    const keyword = e.target.value.trim()
    if (keyword) {
      const results = await api.searchProjectFacts(state.projectId, keyword)
      renderFacts(page, results.results || [])
    } else {
      renderFacts(page, state.facts)
    }
  })

  page.querySelector('#task-detail-close').addEventListener('click', () => {
    hideTaskDetail(page)
  })

  page.querySelector('#task-modal-backdrop').addEventListener('click', () => {
    hideTaskDetail(page)
  })

  await loadProjectDetail(page, state)
  setupEventSource(page, state)

  return page
}

async function loadProjectDetail(page, state) {
  try {
    state.project = await api.getProject(state.projectId)
    state.tasks = state.project.tasks || []

    page.querySelector('#project-title').textContent = state.project.name || '未命名项目'
    page.querySelector('#project-desc').textContent = state.project.description || ''

    try {
      const runtime = await api.getProjectRuntime(state.projectId)
      state.agents = runtime.agents || []
    } catch {
      state.agents = []
    }

    try {
      const factsData = await api.getProjectFacts(state.projectId)
      state.facts = factsData.facts || []
    } catch {
      state.facts = []
    }

    renderTasks(page, state)
    renderFacts(page, state.facts)
    renderAgents(page, state)
    updateTaskStats(page, state)
    updateSupervisorPanel(page, state)
  } catch (e) {
    toast('加载项目失败: ' + e, 'error')
  }
}

function renderTasks(page, state) {
  const container = page.querySelector('#tasks-list')

  if (!state.tasks.length) {
    container.innerHTML = '<div class="tasks-empty">暂无任务<br><br><button class="btn btn-primary btn-sm" onclick="document.getElementById(\'btn-add-task\').click()">添加任务</button></div>'
    return
  }

  const sortedTasks = [...state.tasks].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const taskTemplate = (task) => {
    const statusIcon = getTaskStatusIcon(task.status)
    const progressBar = task.progress > 0 ? `<div class="task-progress-bar"><div class="task-progress-fill" style="width:${task.progress}%"></div></div>` : ''
    const assignedBadge = task.assigned_to ? `<span class="task-assigned">🤖 ${escapeHtml(task.assigned_to)}</span>` : ''
    const depBadge = task.dependencies?.length ? `<span class="task-deps">依赖: ${task.dependencies.length}</span>` : ''

    return `
      <div class="task-item" data-task-id="${task.id}">
        <div class="task-item-header">
          <div class="task-status-icon">${statusIcon}</div>
          <div class="task-item-title">
            <span class="task-name">${escapeHtml(task.name || '未命名')}</span>
            ${assignedBadge}
            ${depBadge}
          </div>
          <div class="task-item-actions">
            <button class="btn btn-xs btn-ghost" data-action="detail" data-id="${task.id}">详情</button>
            <button class="btn btn-xs btn-ghost" data-action="assign" data-id="${task.id}">分配</button>
            ${task.status !== 'completed' && task.status !== 'failed' ? `<button class="btn btn-xs btn-ghost" data-action="delete" data-id="${task.id}">删除</button>` : ''}
          </div>
        </div>
        <div class="task-item-body">
          <p class="task-desc">${escapeHtml(task.description || '无描述')}</p>
          ${progressBar}
        </div>
        <div class="task-item-footer">
          <span class="task-status-text">${getTaskStatusText(task.status)}</span>
          ${task.progress > 0 ? `<span class="task-progress-text">${task.progress}%</span>` : ''}
          <span class="task-time">${formatTime(task.created_at)}</span>
        </div>
      </div>
    `
  }

  const executingTasks = sortedTasks.filter(t => t.status === 'executing')
  const pendingTasks = sortedTasks.filter(t => ['pending', 'planning', 'planned', 'paused'].includes(t.status))
  const completedTasks = sortedTasks.filter(t => t.status === 'completed')
  const failedTasks = sortedTasks.filter(t => t.status === 'failed')
  const cancelledTasks = sortedTasks.filter(t => t.status === 'cancelled')

  container.innerHTML = `
    <div class="tasks-columns">
      <div class="task-column" data-col="executing">
        <div class="task-column-title">执行中</div>
        ${executingTasks.map(taskTemplate).join('')}
      </div>
      <div class="task-column" data-col="pending">
        <div class="task-column-title">排队 / 规划</div>
        ${pendingTasks.map(taskTemplate).join('')}
      </div>
      <div class="task-column" data-col="completed">
        <div class="task-column-title">已完成</div>
        ${completedTasks.map(taskTemplate).join('')}
      </div>
      <div class="task-column" data-col="failed">
        <div class="task-column-title">失败</div>
        ${failedTasks.map(taskTemplate).join('')}
      </div>
      ${cancelledTasks.length ? `
        <div class="task-column" data-col="cancelled">
          <div class="task-column-title">已取消</div>
          ${cancelledTasks.map(taskTemplate).join('')}
        </div>
      ` : ''}
    </div>
  `

  container.querySelectorAll('[data-action="detail"]').forEach(btn => {
    btn.addEventListener('click', () => showTaskDetail(page, state, btn.dataset.id))
  })

  container.querySelectorAll('[data-action="assign"]').forEach(btn => {
    btn.addEventListener('click', () => showAssignTaskDialog(page, state, btn.dataset.id))
  })

  container.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteTask(page, state, btn.dataset.id))
  })
}

function renderFacts(page, facts) {
  const container = page.querySelector('#facts-list')

  if (!facts.length) {
    container.innerHTML = '<div class="facts-empty">暂无事实<br><span style="font-size:11px;color:var(--text-tertiary)">任务执行后会自动提取关键事实</span></div>'
    return
  }

  const categoryLabels = { finding: '发现', decision: '决策', data: '数据', conclusion: '结论' }
  const categoryColors = { finding: '#3b82f6', decision: '#f59e0b', data: '#10b981', conclusion: '#8b5cf6' }

  container.innerHTML = facts.map(fact => `
    <div class="fact-item">
      <div class="fact-header">
        <span class="fact-category" style="background:${categoryColors[fact.category] || '#6b7280'}">${categoryLabels[fact.category] || fact.category}</span>
        <span class="fact-confidence">${Math.round((fact.confidence || 0.5) * 100)}%</span>
      </div>
      <p class="fact-content">${escapeHtml(fact.content || '')}</p>
    </div>
  `).join('')
}

function renderAgents(page, state) {
  const container = page.querySelector('#agents-list')

  if (!state.agents.length) {
    container.innerHTML = '<div class="agents-empty">暂无活跃 Agent</div>'
    return
  }

  container.innerHTML = state.agents.map(agent => {
    const statusIcon = agent.status === 'busy' ? '🔴' : agent.status === 'failed' ? '⚫' : '🟢'
    return `
      <div class="agent-item">
        <div class="agent-info">
          <span class="agent-status-icon">${statusIcon}</span>
          <span class="agent-name">${escapeHtml(agent.agent_name || agent.agent_id)}</span>
        </div>
        ${agent.current_task_id ? `<div class="agent-task">任务: ${agent.current_task_id}</div>` : ''}
        ${agent.progress > 0 ? `<div class="agent-progress">进度: ${agent.progress}%</div>` : ''}
      </div>
    `
  }).join('')
}

function updateTaskStats(page, state) {
  const container = page.querySelector('#task-stats')
  const stats = {
    total: state.tasks.length,
    pending: state.tasks.filter(t => t.status === 'pending').length,
    executing: state.tasks.filter(t => t.status === 'executing').length,
    completed: state.tasks.filter(t => t.status === 'completed').length,
    failed: state.tasks.filter(t => t.status === 'failed').length,
  }

  container.innerHTML = `
    <span class="stat-item">总计: ${stats.total}</span>
    <span class="stat-item stat-pending">待处理: ${stats.pending}</span>
    <span class="stat-item stat-executing">执行中: ${stats.executing}</span>
    <span class="stat-item stat-completed">完成: ${stats.completed}</span>
    ${stats.failed > 0 ? `<span class="stat-item stat-failed">失败: ${stats.failed}</span>` : ''}
  `
}

function updateSupervisorPanel(page, state) {
  const panel = page.querySelector('#supervisor-panel')
  const status = page.querySelector('#supervisor-status')
  const message = page.querySelector('#supervisor-message')
  const actions = page.querySelector('#supervisor-actions')

  if (state.supervisorActive) {
    panel.style.display = 'block'
    status.textContent = '🟢 运行中'
    status.className = 'supervisor-status active'
    message.innerHTML = '<p>Supervisor 正在协调任务执行...</p>'
    actions.innerHTML = `
      <button class="btn btn-sm btn-warning" id="btn-stop-supervisor">停止 Supervisor</button>
    `
    actions.querySelector('#btn-stop-supervisor')?.addEventListener('click', () => {
      stopSupervisor(page, state)
    })
  } else {
    panel.style.display = 'block'
    status.textContent = '⚪ 空闲'
    status.className = 'supervisor-status idle'

    if (state.tasks.length > 0 && state.tasks.some(t => t.status === 'pending')) {
      message.innerHTML = '<p>有任务等待执行，点击「启动 Supervisor」开始协调</p>'
      actions.innerHTML = `
        <button class="btn btn-sm btn-primary" id="btn-start-now">立即开始</button>
      `
      actions.querySelector('#btn-start-now')?.addEventListener('click', () => {
        startSupervisor(page, state)
      })
    } else if (state.tasks.length === 0) {
      message.innerHTML = '<p>请先添加任务</p>'
      actions.innerHTML = ''
    } else {
      message.innerHTML = '<p>所有任务已完成或无待处理任务</p>'
      actions.innerHTML = ''
    }
  }
}

function startSupervisor(page, state) {
  state.supervisorActive = true
  toast('Supervisor 已启动', 'success')
  updateSupervisorPanel(page, state)
}

function stopSupervisor(page, state) {
  state.supervisorActive = false
  if (state.eventSubscriptions?.length) {
    for (const s of state.eventSubscriptions) {
      try {
        s.close()
      } catch {
        /* ignore */
      }
    }
    state.eventSubscriptions = []
  }
  toast('Supervisor 已停止', 'info')
  updateSupervisorPanel(page, state)
}

function setupEventSource(page, state) {
  if (state.eventSubscriptions?.length) {
    for (const s of state.eventSubscriptions) {
      try {
        s.close()
      } catch {
        /* ignore */
      }
    }
    state.eventSubscriptions = []
  }

  const mainTaskIds = (state.tasks || []).map((t) => t.id).filter(Boolean)
  if (!mainTaskIds.length) return

  const onPayload = (payload) => {
    const t = payload.type
    const d = payload.data || {}
    switch (t) {
      case 'task:created':
        if (d.task) {
          state.tasks.push(d.task)
          renderTasks(page, state)
          updateTaskStats(page, state)
          toast('新任务已添加', 'info')
        }
        break
      case 'task:started': {
        const task = state.tasks.find((x) => x.id === d.task_id)
        if (task) {
          task.status = 'executing'
          renderTasks(page, state)
          updateTaskStats(page, state)
        }
        break
      }
      case 'task:progress': {
        const task = state.tasks.find((x) => x.id === d.task_id)
        if (task) {
          task.progress = d.progress
          renderTasks(page, state)
          updateTaskStats(page, state)
        }
        break
      }
      case 'task:completed': {
        const task = state.tasks.find((x) => x.id === d.task_id)
        if (task) {
          task.status = 'completed'
          task.progress = 100
          renderTasks(page, state)
          updateTaskStats(page, state)
          toast(`任务「${task.name}」已完成`, 'success')
          void notifyDesktopCompletion({
            title: 'EvoFlow · 任务完成',
            body: `「${task.name}」已完成`,
            tag: `project-task:${d.task_id}:completed`,
          })
        }
        break
      }
      case 'task:failed': {
        const task = state.tasks.find((x) => x.id === d.task_id)
        if (task) {
          task.status = 'failed'
          task.error = d.error
          renderTasks(page, state)
          updateTaskStats(page, state)
          toast(`任务「${task.name}」失败: ${d.error}`, 'error')
          void notifyDesktopCompletion({
            title: 'EvoFlow · 任务失败',
            body: `「${task.name}」：${d.error || '执行失败'}`,
            tag: `project-task:${d.task_id}:failed`,
          })
        }
        break
      }
      case 'task_detail:updated':
        void (async () => {
          try {
            const factsData = await api.getProjectFacts(state.projectId)
            state.facts = factsData.facts || []
            renderFacts(page, state.facts)
          } catch {
            /* ignore */
          }
        })()
        break
      default:
        break
    }
  }

  // 已移除 /api/events/tasks/{id}/stream 订阅：改为轮询刷新（与实时对话走 LangGraph state/stream 的思路一致）
  state.eventSubscriptions = []
}

async function showTaskDetail(page, state, taskId) {
  const task = state.tasks.find(t => t.id === taskId)
  if (!task) return

  const modal = page.querySelector('#task-detail-modal')
  const title = page.querySelector('#task-detail-title')
  const body = page.querySelector('#task-detail-body')

  title.textContent = `任务详情: ${task.name || taskId}`

  let memoryData
  try {
    memoryData = await api.getTaskMemory(taskId)
  } catch {
    memoryData = null
  }

  body.innerHTML = `
    <div class="task-detail-section">
      <h4>基本信息</h4>
      <div class="task-detail-row">
        <span class="label">状态:</span>
        <span class="value">${getTaskStatusText(task.status)}</span>
      </div>
      <div class="task-detail-row">
        <span class="label">进度:</span>
        <span class="value">${task.progress || 0}%</span>
      </div>
      <div class="task-detail-row">
        <span class="label">分配给:</span>
        <span class="value">${task.assigned_to || '未分配'}</span>
      </div>
      <div class="task-detail-row">
        <span class="label">创建时间:</span>
        <span class="value">${formatTime(task.created_at)}</span>
      </div>
      ${task.started_at ? `<div class="task-detail-row"><span class="label">开始时间:</span><span class="value">${formatTime(task.started_at)}</span></div>` : ''}
      ${task.completed_at ? `<div class="task-detail-row"><span class="label">完成时间:</span><span class="value">${formatTime(task.completed_at)}</span></div>` : ''}
    </div>

    <div class="task-detail-section">
      <h4>描述</h4>
      <p class="task-detail-desc">${escapeHtml(task.description || '无描述')}</p>
    </div>

    ${task.dependencies?.length ? `
    <div class="task-detail-section">
      <h4>依赖任务</h4>
      <ul class="task-detail-deps">
        ${task.dependencies.map(depId => {
          const depTask = state.tasks.find(t => t.id === depId)
          return `<li>${depTask?.name || depId}</li>`
        }).join('')}
      </ul>
    </div>
    ` : ''}

    ${memoryData?.facts?.length ? `
    <div class="task-detail-section">
      <h4>关键事实 (${memoryData.facts.length})</h4>
      <div class="task-facts">
        ${memoryData.facts.map(f => `
          <div class="fact-item">
            <span class="fact-category">${f.category}</span>
            <p>${escapeHtml(f.content)}</p>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${memoryData?.current_step ? `
    <div class="task-detail-section">
      <h4>当前步骤</h4>
      <p>${escapeHtml(memoryData.current_step)}</p>
    </div>
    ` : ''}

    ${task.error ? `
    <div class="task-detail-section">
      <h4>错误信息</h4>
      <p class="task-error">${escapeHtml(task.error)}</p>
    </div>
    ` : ''}

    ${task.result ? `
    <div class="task-detail-section">
      <h4>执行结果</h4>
      <pre class="task-result">${escapeHtml(typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2))}</pre>
    </div>
    ` : ''}
  `

  modal.style.display = 'flex'
}

function hideTaskDetail(page) {
  page.querySelector('#task-detail-modal').style.display = 'none'
}

function showAddTaskDialog(page, state) {
  const dependencies = state.tasks.filter(t => t.status !== 'completed' && t.status !== 'failed').map(t => ({
    value: t.id,
    label: t.name || t.id,
  }))

  showModal({
    title: '添加任务',
    fields: [
      { name: 'name', label: '任务名称', value: '', placeholder: '例如：调研竞品' },
      { name: 'description', label: '任务描述', value: '', placeholder: '详细描述任务内容' },
      ...(dependencies.length > 0 ? [{ name: 'dependencies', label: '依赖任务', type: 'multiselect', options: dependencies, value: [] }] : []),
    ],
    onConfirm: async (result) => {
      const name = (result.name || '').trim()
      if (!name) {
        toast('请输入任务名称', 'error')
        return
      }

      try {
        await api.addTask(state.projectId, name, result.description || '', result.dependencies || [])
        toast('任务已添加', 'success')
        await loadProjectDetail(page, state)
      } catch (e) {
        toast('添加失败: ' + e, 'error')
      }
    }
  })
}

function showAssignTaskDialog(page, state, taskId) {
  const agents = [
    { value: 'researcher', label: '研究员 Agent' },
    { value: 'writer', label: '写作 Agent' },
    { value: 'coder', label: '代码 Agent' },
    { value: 'general', label: '通用 Agent' },
  ]

  showModal({
    title: '分配任务',
    fields: [
      { name: 'agent', label: '选择 Agent', type: 'select', options: agents, value: '' },
    ],
    onConfirm: async (result) => {
      if (!result.agent) {
        toast('请选择 Agent', 'error')
        return
      }

      try {
        await api.updateTask(state.projectId, taskId, { assigned_to: result.agent, status: 'pending' })
        await loadProjectDetail(page, state)
        toast('任务已分配', 'success')
      } catch (e) {
        toast('分配失败: ' + e, 'error')
      }
    }
  })
}

async function deleteTask(page, state, taskId) {
  const yes = await showConfirm('确定删除该任务？')
  if (!yes) return

  try {
    await api.deleteTask(state.projectId, taskId)
    toast('任务已删除', 'success')
    await loadProjectDetail(page, state)
  } catch (e) {
    toast('删除失败: ' + e, 'error')
  }
}

function getTaskStatusIcon(status) {
  const icons = {
    pending: '⚪',
    planning: '🔵',
    planned: '🔵',
    executing: '🔴',
    paused: '🟡',
    completed: '✅',
    failed: '❌',
    cancelled: '⚫',
  }
  return icons[status] || '⚪'
}

function getTaskStatusText(status) {
  const texts = {
    pending: '待处理',
    planning: '规划中',
    planned: '已计划',
    executing: '执行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return texts[status] || status
}

function formatTime(timestamp) {
  if (!timestamp) return '-'
  try {
    const date = new Date(timestamp)
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return timestamp
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function extractProjectId() {
  const hash = window.location.hash || ''
  const match = hash.match(/^#\/project\/([^/?]+)/)
  return match ? match[1] : null
}

