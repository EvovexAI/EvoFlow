/**
 * 智能体详情整页 — #/agents/:code
 * 替代原列表侧栏抽屉：点击卡片直接进入此页。
 */
import { api, getGatewayBaseUrl } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { escapeHtml } from './agents-shared.js'
import {
  attachAgentDetailEvents,
  buildAgentDetailSections,
  preloadRoleToolsMeta,
} from './agents-role-ui.js'
import { mountAgentAvatar } from '../lib/mount-agent-ui.js'

function agentCodeFromHash() {
  const raw = String(window.location.hash || '').replace(/^#/, '')
  const path = raw.split('?')[0] || ''
  const m = path.match(/^\/agents\/([^/]+)$/)
  if (!m) return ''
  try {
    return decodeURIComponent(m[1] || '').trim()
  } catch {
    return String(m[1] || '').trim()
  }
}

function collectCodesFromObject(obj, out) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    obj.forEach((x) => collectCodesFromObject(x, out))
    return
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || '').toLowerCase()
    if (
      (key === 'assigned_agent' || key === 'agent_code' || key === 'agent_id') &&
      typeof v === 'string' &&
      v.trim()
    ) {
      out.add(String(v).trim())
    } else if (v && typeof v === 'object') {
      collectCodesFromObject(v, out)
    }
  }
}

function collectAppAgentMap(apps) {
  const map = new Map()
  for (const app of apps || []) {
    const appId = String(app?.id || app?.app_id || '').trim()
    const appName = String(app?.name || app?.title || appId).trim()
    const codes = new Set()
    collectCodesFromObject(app, codes)
    for (const code of codes) {
      if (!map.has(code)) map.set(code, { appId, appName })
    }
  }
  return map
}

async function buildDetailContext(code) {
  const [agents, rolesRes, apps, automations] = await Promise.all([
    api.listAgents().catch(() => []),
    api.proactiveListRoles().catch(() => ({ roles: [] })),
    api.listApps().catch(() => []),
    api.automationList().catch(() => ({ automations: [] })),
  ])
  const list = Array.isArray(agents) ? agents : agents?.agents || []
  const roles = rolesRes?.roles || []
  const hiredCodes = new Set(
    roles
      .filter((r) => String(r.status || '') !== 'archived')
      .map((r) => String(r.agent_code || '').trim())
      .filter(Boolean),
  )
  const hiredRolesByCode = new Map(
    roles
      .filter((r) => String(r.agent_code || '').trim())
      .map((r) => [String(r.agent_code).trim(), r]),
  )
  const autoList =
    automations?.automations || automations?.tasks || (Array.isArray(automations) ? automations : [])
  const automationAgentCodes = new Set()
  for (const t of autoList) {
    const c = String(t?.agent_code || '').trim()
    if (c) automationAgentCodes.add(c)
  }
  const state = {
    agents: list,
    hiredCodes,
    hiredRolesByCode,
    appAgentCodes: collectAppAgentMap(Array.isArray(apps) ? apps : apps?.apps || []),
    automationAgentCodes,
    toolsMeta: null,
    selectedId: code,
    onRefresh: null,
  }
  await preloadRoleToolsMeta(state)
  return state
}

export async function render() {
  const code = agentCodeFromHash()
  const page = document.createElement('div')
  page.className = 'page role-page role-page--agent-detail'
  page.innerHTML = `
    <div class="role-detail-shell">
      <header class="role-detail-top">
        <button type="button" class="btn btn-ghost role-detail-back" data-action="back">← 返回智能体</button>
        <div class="role-detail-heading">
          <div class="role-detail-avatar" id="agentDetailAvatar" aria-hidden="true"></div>
          <div class="role-detail-titles">
            <h1 class="role-detail-title" id="agentDetailTitle">加载中…</h1>
            <div class="role-detail-sub" id="agentDetailSub"></div>
          </div>
        </div>
      </header>
      <div class="role-detail-body" id="agentDetailBody">
        <div class="role-drawer-loading">加载详情…</div>
      </div>
      <footer class="role-detail-foot" id="agentDetailFoot"></footer>
    </div>
  `

  if (!code) {
    page.querySelector('#agentDetailBody').innerHTML =
      '<div class="role-drawer-error">缺少智能体标识</div>'
    return page
  }

  const state = await buildDetailContext(code).catch((e) => {
    toast('加载上下文失败: ' + (e?.message || e), 'error')
    return {
      agents: [],
      hiredCodes: new Set(),
      hiredRolesByCode: new Map(),
      appAgentCodes: new Map(),
      automationAgentCodes: new Set(),
      toolsMeta: null,
      selectedId: code,
    }
  })

  const reload = async () => {
    const titleEl = page.querySelector('#agentDetailTitle')
    const subEl = page.querySelector('#agentDetailSub')
    const body = page.querySelector('#agentDetailBody')
    const foot = page.querySelector('#agentDetailFoot')
    const avatarHost = page.querySelector('#agentDetailAvatar')
    if (body) body.innerHTML = '<div class="role-drawer-loading">加载详情…</div>'
    if (foot) foot.innerHTML = ''
    try {
      Object.assign(state, await buildDetailContext(code))
      const sections = await buildAgentDetailSections(code, state)
      if (titleEl) titleEl.textContent = sections.name
      if (subEl) subEl.innerHTML = sections.subtitleHtml
      if (body) body.innerHTML = sections.bodyHtml
      if (foot) foot.innerHTML = sections.footHtml
      if (avatarHost) {
        avatarHost.innerHTML = ''
        const baseUrl = await getGatewayBaseUrl().catch(() => '')
        mountAgentAvatar(avatarHost, {
          agent: sections.agent,
          agentCode: code,
          size: 56,
          baseUrl,
        })
      }
    } catch (e) {
      if (titleEl) titleEl.textContent = code
      if (body) {
        body.innerHTML = `<div class="role-drawer-error">加载失败：${escapeHtml(e?.message || e)}</div>`
      }
    }
  }

  state.onRefresh = reload
  attachAgentDetailEvents(page, state)
  void reload()
  return page
}
