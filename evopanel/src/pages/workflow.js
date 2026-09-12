/**
 * 工作流页面 - 独立的全屏工作流查看页面
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskDetailWorkbench } from '../react/components/TaskDetailWorkbench.js'
import { toast } from '../components/toast.js'

let root = null
let workbenchRefreshToken = 0

function renderWorkbench(mountHost, taskId, initialSubtaskId, actions = {}) {
  if (!mountHost) return
  if (!root) {
    root = createRoot(mountHost)
  }
  root.render(
    createElement(TaskDetailWorkbench, {
      taskId,
      refreshToken: workbenchRefreshToken,
      initialSubtaskId,
      onBack: actions.onBack,
      onRefresh: actions.onRefresh,
    }),
  )
}

export async function render() {
  const taskId = extractTaskId()
  if (!taskId) {
    const page = document.createElement('div')
    page.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">无效的任务 ID,<a href="#/tasks">返回任务列表</a></div>'
    return page
  }

  const page = document.createElement('div')
  page.className = 'page workflow-page'

  page.innerHTML = `<div class="workflow-page-content" id="workflow-mount-host"></div>`

  const mountHost = page.querySelector('#workflow-mount-host')

  const workbenchActions = {
    onBack: () => {
      window.location.hash = `#/task/${taskId}`
    },
    onRefresh: () => {
      workbenchRefreshToken += 1
      renderWorkbench(mountHost, taskId, extractInitialSubtaskId(), workbenchActions)
      toast('已刷新', 'success')
    },
  }

  renderWorkbench(mountHost, taskId, extractInitialSubtaskId(), workbenchActions)

  return page
}

export function cleanup() {
  if (root) {
    root.unmount()
    root = null
  }
}

function extractInitialSubtaskId() {
  const hash = window.location.hash.slice(1) || ''
  const q = hash.split('?')[1] || ''
  return new URLSearchParams(q).get('subtask') || ''
}

function extractTaskId() {
  const hash = window.location.hash.slice(1) || ''
  const path = hash.split('?')[0]
  // 解析 /workflow/:id
  const match = path.match(/^\/workflow\/([^/]+)$/)
  return match ? match[1] : null
}
