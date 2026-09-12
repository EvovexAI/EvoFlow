/**
 * 项目管理页面 - 多智能体协作
 */
import { api, invalidate } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm } from '../components/modal.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">多智能体协作</h1>
        <p class="page-desc">管理复杂任务规划与多 Agent 协同执行</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-new-project">新建项目</button>
        <button class="btn btn-secondary" id="btn-refresh-projects">刷新</button>
      </div>
    </div>
    <div class="page-content">
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
        <input class="form-input" id="projects-search" placeholder="搜索项目名称 / 描述" style="max-width:360px">
        <span id="projects-count" style="font-size:12px;color:var(--text-tertiary)"></span>
      </div>
      <div id="projects-list"></div>
    </div>
  `

  const state = { projects: [], filter: '' }
  loadProjects(page, state)

  page.querySelector('#btn-new-project').addEventListener('click', () => {
    showCreateProjectDialog(page, state)
  })

  page.querySelector('#btn-refresh-projects').addEventListener('click', async () => {
    invalidate('projects_list')
    await loadProjects(page, state)
    toast('项目列表已刷新', 'success')
  })

  page.querySelector('#projects-search').addEventListener('input', (e) => {
    state.filter = String(e.target.value || '').trim().toLowerCase()
    renderProjects(page, state)
  })

  return page
}

function renderSkeleton(container) {
  const item = () => `
    <div class="project-card" style="pointer-events:none">
      <div class="skeleton" style="width:60%;height:20px;border-radius:4px"></div>
      <div class="skeleton" style="width:80%;height:14px;border-radius:4px;margin-top:8px"></div>
      <div class="skeleton" style="width:40%;height:14px;border-radius:4px;margin-top:12px"></div>
    </div>`
  container.innerHTML = [item(), item(), item()].join('')
}

async function loadProjects(page, state) {
  const container = page.querySelector('#projects-list')
  const countEl = page.querySelector('#projects-count')
  if (countEl) countEl.textContent = '加载中...'
  renderSkeleton(container)

  try {
    state.projects = await api.listProjects()
    renderProjects(page, state)

    if (!state.eventsAttached) {
      attachProjectEvents(page, state)
      state.eventsAttached = true
    }
  } catch (e) {
    container.innerHTML = `<div style="color:var(--error);padding:20px">加载失败: ${escapeHtml(String(e))}</div>`
    if (countEl) countEl.textContent = '加载失败'
    toast('加载项目列表失败: ' + e, 'error')
  }
}

function renderProjects(page, state) {
  const container = page.querySelector('#projects-list')
  const countEl = page.querySelector('#projects-count')

  const list = state.projects.filter(p => {
    if (!state.filter) return true
    const text = [p.name, p.description, p.status].map(v => String(v || '').toLowerCase()).join(' ')
    return text.includes(state.filter)
  })

  if (countEl) countEl.textContent = `共 ${list.length} 个项目`

  if (!list.length) {
    container.innerHTML = '<div style="color:var(--text-tertiary);padding:40px;text-align:center"><p>暂无项目</p><p style="margin-top:8px;font-size:12px">点击「新建项目」创建一个多智能体协作任务</p></div>'
    return
  }

  container.innerHTML = `<div class="project-grid">${list.map(p => {
    const statusBadge = getStatusBadge(p.status)
    const taskCount = p.task_count || 0
    return `
      <div class="project-card" data-id="${p.id}">
        <div class="project-card-header">
          <div class="project-card-title">
            <span class="project-name">${escapeHtml(p.name || '未命名')}</span>
            ${statusBadge}
          </div>
        </div>
        <div class="project-card-body">
          <p class="project-desc">${escapeHtml(p.description || '无描述')}</p>
          <div class="project-meta">
            <span>任务: ${taskCount}</span>
            <span>创建: ${formatTime(p.created_at)}</span>
          </div>
        </div>
        <div class="project-card-footer">
          <button class="btn btn-sm btn-primary" data-action="open" data-id="${p.id}">打开</button>
          <button class="btn btn-sm btn-secondary" data-action="edit" data-id="${p.id}">编辑</button>
          <button class="btn btn-sm btn-secondary" data-action="delete" data-id="${p.id}">删除</button>
        </div>
      </div>
    `
  }).join('')}</div>`
}

function attachProjectEvents(page, state) {
  const container = page.querySelector('#projects-list')
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    const id = btn.dataset.id

    if (action === 'open') {
      window.location.hash = `#/project/${id}`
      setTimeout(() => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      }, 100)
    } else if (action === 'edit') {
      showEditProjectDialog(page, state, id)
    } else if (action === 'delete') {
      await deleteProject(page, state, id)
    }
  })
}

function showCreateProjectDialog(page, state) {
  showModal({
    title: '新建项目',
    fields: [
      { name: 'name', label: '项目名称', value: '', placeholder: '例如：竞品分析' },
      { name: 'description', label: '项目描述', value: '', placeholder: '简要描述项目目标' },
    ],
    onConfirm: async (result) => {
      const name = (result.name || '').trim()
      if (!name) {
        toast('请输入项目名称', 'error')
        return
      }

      try {
        const project = await api.createProject(name, result.description || '')
        toast('项目已创建', 'success')
        await loadProjects(page, state)
      } catch (e) {
        toast('创建失败: ' + e, 'error')
      }
    }
  })
}

function showEditProjectDialog(page, state, projectId) {
  const project = state.projects.find(p => p.id === projectId)
  if (!project) return

  showModal({
    title: '编辑项目',
    fields: [
      { name: 'name', label: '项目名称', value: project.name || '', placeholder: '项目名称' },
      { name: 'description', label: '项目描述', value: project.description || '', placeholder: '项目描述' },
    ],
    onConfirm: async (result) => {
      const name = (result.name || '').trim()
      if (!name) {
        toast('请输入项目名称', 'error')
        return
      }

      try {
        await api.updateProject(projectId, {
          name,
          description: result.description || ''
        })
        toast('项目已更新', 'success')
        await loadProjects(page, state)
      } catch (e) {
        toast('更新失败: ' + e, 'error')
      }
    }
  })
}

async function deleteProject(page, state, projectId) {
  const yes = await showConfirm(`确定删除该项目？\n\n此操作将删除项目及其所有任务数据。`)
  if (!yes) return

  try {
    await api.deleteProject(projectId)
    toast('已删除', 'success')
    await loadProjects(page, state)
  } catch (e) {
    toast('删除失败: ' + e, 'error')
  }
}

function getStatusBadge(status) {
  const badges = {
    'pending': '<span class="badge">待开始</span>',
    'planning': '<span class="badge badge-info">规划中</span>',
    'executing': '<span class="badge badge-primary">执行中</span>',
    'paused': '<span class="badge badge-warning">已暂停</span>',
    'completed': '<span class="badge badge-success">已完成</span>',
    'failed': '<span class="badge badge-danger">失败</span>',
    'cancelled': '<span class="badge">已取消</span>',
  }
  return badges[status] || `<span class="badge">${status}</span>`
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
