/**
 * 工作过程 · #/runs/:runId
 * 不再渲染整页：解析 runId 后直接打开与员工页同款弹窗，关闭后回到上一页。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { decodeWorkProcessRunId } from '../lib/proactive-work-process.js'
import { ProactiveLiveProcessHost } from '../react/components/ProactiveLiveProcessHost.tsx'

/** @type {import('react-dom/client').Root | null} */
let _root = null
/** @type {HTMLElement | null} */
let _host = null

function parseRunIdFromHash() {
  const hash = window.location.hash.slice(1) || ''
  const path = hash.split('?')[0]
  const m = path.match(/^\/runs\/(.+)$/)
  return m ? m[1] : ''
}

function preferredTaskFromHash() {
  try {
    const hash = window.location.hash.slice(1) || ''
    const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
    return String(new URLSearchParams(q).get('task') || '').trim()
  } catch {
    return ''
  }
}

function leaveRunsRoute() {
  try {
    if (window.history.length > 1) {
      window.history.back()
      return
    }
  } catch {
    /* ignore */
  }
  window.location.hash = '#/proactive'
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'pro-wp-page-root pro-wp-page-root--modal-only'
  _host = page
  const runId = parseRunIdFromHash()
  const decoded = decodeWorkProcessRunId(runId)
  const code = String(decoded?.agentCode || '').trim()
  const roundId = String(decoded?.roundId || '').trim()
  const taskId = preferredTaskFromHash()

  _root = createRoot(page)
  if (!code) {
    _root.render(
      createElement(
        'div',
        { className: 'pro-wp-empty', style: { padding: 24 } },
        '无效的运行 ID，无法打开执行过程。',
      ),
    )
    return page
  }

  _root.render(
    createElement(ProactiveLiveProcessHost, {
      open: true,
      agentCode: code,
      roundId,
      taskId,
      title: '执行过程',
      onClose: leaveRunsRoute,
    }),
  )
  return page
}

export function cleanup() {
  try {
    _root?.unmount()
  } catch {
    /* ignore */
  }
  _root = null
  _host = null
}
