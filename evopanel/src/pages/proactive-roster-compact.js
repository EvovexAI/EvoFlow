/**
 * 右栏 shell-page 精简员工列表：头像 · 名字 · 状态。
 * 多列紧凑格子（不一人占满一行）；头像走智能体目录（与员工墙同源）。
 */
import { api, getGatewayBaseUrl } from '../lib/tauri-api.js'
import { resolveEmployeeDisplayName } from '../react/lib/employee-display.js'
import { mountAgentAvatar } from '../lib/mount-agent-ui.js'
import { openShellPageInRightStage } from '../lib/right-stage/open-shell-page-stage.js'

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function displayName(role) {
  const code = String(role?.agent_code || '').trim()
  const name = resolveEmployeeDisplayName(code, {
    roles: [
      {
        agent_code: code,
        role_name: role?.role_name,
        agent_name: role?.agent_name,
      },
    ],
  })
  return name || code || '员工'
}

/** @returns {{ label: string, tone: 'run'|'ok'|'warn'|'muted' }} */
function statusOf(role, busySet) {
  const code = String(role?.agent_code || '')
  if (busySet.has(code)) return { label: '工作中', tone: 'run' }
  const st = String(role?.status || '')
  if (st === 'draft') return { label: '草稿', tone: 'warn' }
  if (st === 'paused') return { label: '请假', tone: 'muted' }
  if (st === 'active') {
    const suspended = !!(role?.auto_patrol_suspended || role?.config?.auto_patrol_suspended)
    if (suspended) return { label: '已停', tone: 'muted' }
    return { label: '在岗', tone: 'ok' }
  }
  return { label: '已停', tone: 'muted' }
}

function renderListHtml(roles, busySet) {
  if (!roles.length) {
    return `<div class="shell-roster-empty">
      <p class="shell-roster-empty-title">还没有员工</p>
      <p class="shell-roster-empty-desc">在对话里让我创建，或到左侧「员工」加人</p>
    </div>`
  }
  return (
    `<div class="shell-roster-grid" role="list">` +
    roles
      .map((r) => {
        const code = String(r.agent_code || '').trim()
        const name = displayName(r)
        const st = statusOf(r, busySet)
        return `<button type="button" class="shell-roster-tile" role="listitem" data-code="${esc(code)}" title="查看 ${esc(name)}">
          <span class="shell-roster-avatar" data-avatar-agent="${esc(code)}" aria-hidden="true"></span>
          <span class="shell-roster-name">${esc(name)}</span>
          <span class="shell-roster-status shell-roster-status--${st.tone}">${esc(st.label)}</span>
        </button>`
      })
      .join('') +
    `</div>`
  )
}

async function fetchBusyCodes(roles) {
  const codes = (roles || []).map((r) => String(r.agent_code || '').trim()).filter(Boolean)
  const busy = new Set()
  await Promise.all(
    codes.map(async (code) => {
      try {
        const res = await api.proactiveRoleBusy(code)
        if (res?.busy) busy.add(code)
      } catch {
        /* ignore */
      }
    }),
  )
  return busy
}

async function loadRoles() {
  const res = await api.proactiveListRoles().catch(() => ({ roles: [] }))
  const roles = Array.isArray(res?.roles) ? res.roles : Array.isArray(res) ? res : []
  const rank = (r) => {
    const st = String(r?.status || '')
    if (st === 'active') return 0
    if (st === 'draft') return 2
    if (st === 'paused') return 3
    return 1
  }
  return [...roles].sort((a, b) => rank(a) - rank(b) || displayName(a).localeCompare(displayName(b), 'zh'))
}

/** 与员工墙同源：listAgents → has_avatar_file / avatar_meta */
async function loadAgentsByCode() {
  const map = new Map()
  try {
    const agents = await api.listAgents()
    for (const a of agents || []) {
      const code = String(a?.agent_code || a?.name || '').trim().toLowerCase()
      if (code) map.set(code, a)
    }
  } catch {
    /* keep empty → initial fallback */
  }
  return map
}

function paintAvatars(root, agentsByCode) {
  void getGatewayBaseUrl()
    .then((baseUrl) => {
      root.querySelectorAll('[data-avatar-agent]').forEach((el) => {
        const code = String(el.getAttribute('data-avatar-agent') || '').trim()
        if (!code) return
        const agent = agentsByCode?.get(code.toLowerCase()) || { agent_code: code }
        mountAgentAvatar(el, {
          agent,
          agentCode: code,
          size: 44,
          baseUrl: baseUrl || '',
        })
      })
    })
    .catch(() => {
      root.querySelectorAll('[data-avatar-agent]').forEach((el) => {
        const code = String(el.getAttribute('data-avatar-agent') || '').trim()
        if (!code) return
        const agent = agentsByCode?.get(code.toLowerCase()) || { agent_code: code }
        mountAgentAvatar(el, { agent, agentCode: code, size: 44 })
      })
    })
}

function bindTiles(root) {
  const open = (code, name) => {
    const c = String(code || '').trim()
    if (!c) return
    openShellPageInRightStage({
      path: `/proactive/${encodeURIComponent(c)}`,
      mountId: 'employees.detail',
      title: name || '员工',
      entityLabel: name || undefined,
      layout: 'wide',
    })
  }
  root.querySelectorAll('.shell-roster-tile[data-code]').forEach((tile) => {
    tile.addEventListener('click', () => {
      const code = tile.dataset.code
      const name = tile.querySelector('.shell-roster-name')?.textContent?.trim() || ''
      open(code, name)
    })
  })
}

/**
 * @returns {{ destroy: () => void, title?: string }}
 */
export async function mountProactiveRosterCompact(container, { onClose } = {}) {
  const host = container
  if (!host) return { destroy: () => {} }

  const page = document.createElement('div')
  page.className = 'page shell-roster-page shell-page-embed'
  page.dataset.shellPageTitle = '员工'
  page.innerHTML = `
    <header class="shell-roster-head">
      <div class="shell-roster-head-text">
        <h2 class="shell-roster-title">员工</h2>
        <p class="shell-roster-sub" data-roster-count>加载中…</p>
      </div>
      <button type="button" class="shell-roster-refresh" data-act="refresh" title="刷新" aria-label="刷新">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke-linecap="round"/>
          <path d="M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </header>
    <div class="shell-roster-body" data-roster-body>
      <div class="shell-roster-loading">加载中…</div>
    </div>
  `
  host.replaceChildren(page)

  let destroyed = false
  let busyTimer = null
  /** @type {Map<string, any>} */
  let agentsByCode = new Map()

  const setCount = (n) => {
    const el = page.querySelector('[data-roster-count]')
    if (el) el.textContent = n ? `${n} 人` : '暂无员工'
  }

  const applyList = (roles, busySet) => {
    const body = page.querySelector('[data-roster-body]')
    if (!body) return
    body.innerHTML = renderListHtml(roles, busySet)
    setCount(roles.length)
    paintAvatars(body, agentsByCode)
    bindTiles(body)
  }

  const patchStatusBadges = (roles, busySet) => {
    const byCode = new Map(roles.map((r) => [String(r.agent_code || ''), r]))
    page.querySelectorAll('.shell-roster-tile[data-code]').forEach((tile) => {
      const code = String(tile.dataset.code || '')
      const badge = tile.querySelector('.shell-roster-status')
      const role = byCode.get(code)
      if (!badge || !role) return
      const st = statusOf(role, busySet)
      badge.className = `shell-roster-status shell-roster-status--${st.tone}`
      badge.textContent = st.label
    })
  }

  const render = async ({ quiet } = {}) => {
    const body = page.querySelector('[data-roster-body]')
    if (!body) return
    if (quiet && body.querySelector('.shell-roster-tile')) {
      try {
        const roles = await loadRoles()
        if (destroyed) return
        const busySet = await fetchBusyCodes(roles)
        if (destroyed) return
        const tiles = [...body.querySelectorAll('.shell-roster-tile')]
        const sameCodes =
          roles.length === tiles.length &&
          roles.every((r, i) => tiles[i] && String(tiles[i].dataset.code) === String(r.agent_code || ''))
        if (!sameCodes) applyList(roles, busySet)
        else {
          patchStatusBadges(roles, busySet)
          setCount(roles.length)
        }
      } catch {
        /* quiet 失败忽略 */
      }
      return
    }
    body.innerHTML = `<div class="shell-roster-loading">加载中…</div>`
    try {
      const [roles, agentsMap] = await Promise.all([loadRoles(), loadAgentsByCode()])
      if (destroyed) return
      agentsByCode = agentsMap
      const busySet = await fetchBusyCodes(roles)
      if (destroyed) return
      applyList(roles, busySet)
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

  await render()
  busyTimer = window.setInterval(() => {
    if (destroyed || !page.isConnected) return
    void render({ quiet: true })
  }, 20000)

  return {
    title: '员工',
    destroy: () => {
      destroyed = true
      if (busyTimer) {
        clearInterval(busyTimer)
        busyTimer = null
      }
      try {
        page.remove()
      } catch {
        /* ignore */
      }
    },
  }
}
