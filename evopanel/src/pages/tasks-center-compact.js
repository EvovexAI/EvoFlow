/**
 * 右栏 shell-page：任务列表 / 待办列表（精简版）。
 * 对齐 proactive-roster-compact：列表点进详情或主区任务中心。
 */
import { api } from '../lib/tauri-api.js'
import { formatUnifiedStatusZh, toUnifiedTaskStatus } from '../lib/task-status-label.js'
import { openShellPageInRightStage } from '../lib/right-stage/open-shell-page-stage.js'
import { navigatePlatformFeedbackRoute } from '../lib/right-stage/platform-feedback.js'

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toneForTaskStatus(status) {
  const u = toUnifiedTaskStatus(status)
  if (u === 'running' || u === 'executing') return 'run'
  if (u === 'completed' || u === 'done') return 'ok'
  if (u === 'failed' || u === 'error') return 'warn'
  return 'muted'
}

function toneForItemStatus(status) {
  const st = String(status || '').toLowerCase()
  if (st === 'done' || st === 'completed') return 'ok'
  if (st === 'dispatched' || st === 'in_progress') return 'run'
  if (st === 'cancelled' || st === 'deleted') return 'muted'
  return 'muted'
}

function renderTaskRows(tasks) {
  if (!tasks.length) {
    return `<div class="shell-roster-empty">
      <p class="shell-roster-empty-title">还没有任务</p>
      <p class="shell-roster-empty-desc">在对话里创建协作任务后会出现在这里</p>
    </div>`
  }
  return (
    `<div class="shell-tasks-list" role="list">` +
    tasks
      .map((t) => {
        const id = String(t.id || t.task_id || '').trim()
        const name = String(t.name || t.title || id || '未命名任务').trim()
        const st = formatUnifiedStatusZh(t.status)
        const tone = toneForTaskStatus(t.status)
        return `<button type="button" class="shell-tasks-row" role="listitem" data-task-id="${esc(id)}" title="查看 ${esc(name)}">
          <span class="shell-tasks-row-main">
            <span class="shell-tasks-row-title">${esc(name)}</span>
            <span class="shell-tasks-row-id">${esc(id)}</span>
          </span>
          <span class="shell-roster-status shell-roster-status--${tone}">${esc(st)}</span>
        </button>`
      })
      .join('') +
    `</div>`
  )
}

function renderItemRows(items, focusId) {
  if (!items.length) {
    return `<div class="shell-roster-empty">
      <p class="shell-roster-empty-title">还没有待办</p>
      <p class="shell-roster-empty-desc">对小V说「记一条待办」即可</p>
    </div>`
  }
  return (
    `<div class="shell-tasks-list" role="list">` +
    items
      .map((it) => {
        const id = String(it.id || it.item_id || '').trim()
        const title = String(it.title || it.name || id || '未命名事项').trim()
        const st = String(it.status || 'open')
        const tone = toneForItemStatus(st)
        const focused = focusId && id === focusId ? ' shell-tasks-row--focus' : ''
        return `<button type="button" class="shell-tasks-row${focused}" role="listitem" data-item-id="${esc(id)}" title="${esc(title)}">
          <span class="shell-tasks-row-main">
            <span class="shell-tasks-row-title">${esc(title)}</span>
            <span class="shell-tasks-row-id">${esc(id)}</span>
          </span>
          <span class="shell-roster-status shell-roster-status--${tone}">${esc(st)}</span>
        </button>`
      })
      .join('') +
    `</div>`
  )
}

// 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：asList 增加「往 data 信封里再找一层」，并容忍 data 本身是数组。
// 为什么：/api/tasks 返回的是 {success:true,data:{tasks:[...],total:n}}（见 tasks.js:2297 的解包
//   注释），而这里原来只在顶层找 tasks/items/results —— data 是对象不是数组，于是逐个 miss，
//   返回 []，右栏「任务」签恒显示「暂无任务」。实测现网 /api/tasks 有 40 条、任务中心主页正常，
//   唯独右栏空；同一个 asList 用在待办上却正常，因为 /api/items 回的是 {ok:true,items:[...]}（顶层）。
//   两边信封形状不同，这就是只有一侧坏掉的原因。
//   判据：改后右栏「任务」签条数必须与 /api/tasks 的 data.tasks 长度同源可比，不再是 0。
export function asList(payload, keys) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k]
    }
    return null
  }
  const direct = pick(payload)
  if (direct) return direct
  // 网关统一失败/成功信封：{success:true,data:{...}} 或 {ok:true,data:{...}}
  if (Array.isArray(payload.data)) return payload.data
  const nested = pick(payload.data)
  if (nested) return nested
  // 少数路由多包一层 {data:{data:[...]}}
  if (payload.data && typeof payload.data === 'object') {
    const deep = pick(payload.data.data)
    if (deep) return deep
  }
  return []
}

/**
 * @param {unknown} container
 * @param {{ mode?: 'tasks' | 'items', focusId?: string, onClose?: () => void }} [opts]
 * @returns {{ destroy: () => void, title?: string }}
 */
export async function mountTasksCenterCompact(container, { mode = 'tasks', focusId, onClose } = {}) {
  const host = container
  if (!host) return { destroy: () => {} }

  const isItems = mode === 'items'
  const title = isItems ? '待办' : '任务'
  const page = document.createElement('div')
  page.className = 'page shell-roster-page shell-page-embed shell-tasks-compact'
  page.dataset.shellPageTitle = title
  page.innerHTML = `
    <header class="shell-roster-head">
      <div class="shell-roster-head-text">
        <h2 class="shell-roster-title">${esc(title)}</h2>
        <p class="shell-roster-sub" data-roster-count>加载中…</p>
      </div>
      <div class="shell-tasks-head-actions">
        <button type="button" class="shell-roster-refresh" data-act="open-main" title="在主区打开" aria-label="在主区打开">↗</button>
        <button type="button" class="shell-roster-refresh" data-act="refresh" title="刷新" aria-label="刷新">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke-linecap="round"/>
            <path d="M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </header>
    <div class="shell-roster-body" data-roster-body>
      <div class="shell-roster-loading">加载中…</div>
    </div>
  `
  host.replaceChildren(page)

  let destroyed = false
  const focus = String(focusId || '').trim()

  const setCount = (n) => {
    const el = page.querySelector('[data-roster-count]')
    if (!el) return
    if (isItems) el.textContent = n ? `${n} 条` : '暂无待办'
    else el.textContent = n ? `${n} 个` : '暂无任务'
  }

  const bindRows = (body) => {
    body.querySelectorAll('.shell-tasks-row[data-task-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = String(row.dataset.taskId || '').trim()
        if (!id) return
        const name = row.querySelector('.shell-tasks-row-title')?.textContent?.trim() || id
        openShellPageInRightStage(
          {
            path: `/task/${id}`,
            mountId: 'tasks.detail',
            title: name,
            entityLabel: name,
            layout: 'wide',
          },
          { forceExpand: true },
        )
      })
    })
    body.querySelectorAll('.shell-tasks-row[data-item-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = String(row.dataset.itemId || '').trim()
        navigatePlatformFeedbackRoute(
          id ? `/tasks?tab=items&focus=${encodeURIComponent(id)}` : '/tasks?tab=items',
        )
        onClose?.()
      })
    })
  }

  const render = async () => {
    const body = page.querySelector('[data-roster-body]')
    if (!body) return
    body.innerHTML = `<div class="shell-roster-loading">加载中…</div>`
    try {
      if (isItems) {
        const raw = await api.listUserItems({ limit: 40 })
        if (destroyed) return
        let items = asList(raw, ['items', 'data', 'results'])
        if (focus) {
          const hit = items.find((it) => String(it.id || it.item_id || '') === focus)
          if (hit) items = [hit, ...items.filter((it) => it !== hit)]
        }
        body.innerHTML = renderItemRows(items, focus)
        setCount(items.length)
      } else {
        const raw = await api.listAllTasks({ page: 1, page_size: 40, limit: 40 })
        if (destroyed) return
        const tasks = asList(raw, ['tasks', 'items', 'data', 'results'])
        body.innerHTML = renderTaskRows(tasks)
        setCount(tasks.length)
      }
      bindRows(body)
      if (focus) {
        body.querySelector('.shell-tasks-row--focus')?.scrollIntoView({ block: 'nearest' })
      }
    } catch (e) {
      if (destroyed) return
      body.innerHTML = `<div class="shell-roster-empty">
        <p class="shell-roster-empty-title">加载失败</p>
        <p class="shell-roster-empty-desc">${esc(e?.message || e || '请稍后重试')}</p>
      </div>`
      setCount(0)
    }
  }

  page.querySelector('[data-act="refresh"]')?.addEventListener('click', () => {
    void render()
  })
  page.querySelector('[data-act="open-main"]')?.addEventListener('click', () => {
    navigatePlatformFeedbackRoute(isItems ? '/tasks?tab=items' : '/tasks')
    onClose?.()
  })

  await render()

  return {
    title,
    destroy: () => {
      destroyed = true
      try {
        page.remove()
      } catch {
        /* ignore */
      }
    },
  }
}
