import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { ensureQrImgFallbackHandler, qrImageHtml } from '../lib/qr-image.js'
import {
  FEISHU_COLLAB_HOWTO_HTML,
  feishuBindingOf,
  hireAndBindFeishu,
  isFeishuHireablePublishedAgent,
  listUnboundFeishuRoles,
  startFeishuEmployeeScan,
  unbindFeishuEmployee,
} from '../lib/feishu-employee-bind.js'

function esc(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _shortMono(id, keep = 14) {
  const s = String(id || '').trim()
  if (!s) return '—'
  if (s.length <= keep) return s
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function _bindFeishuRosterActions(body) {
  if (!body || body.dataset.feishuRosterBound === '1') return
  body.dataset.feishuRosterBound = '1'
  body.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-feishu-act]') : null
    if (!btn) return
    const act = btn.getAttribute('data-feishu-act') || ''
    const code = String(btn.getAttribute('data-code') || '').trim()
    const name = String(btn.getAttribute('data-name') || code).trim() || code
    if (act === 'bind' && code) {
      void startFeishuEmployeeScan(code, {
        roleName: name,
        onBound: () => void refreshFeishuBindingsUi('feishu'),
      })
      return
    }
    if (act === 'hire-bind' && code) {
      void (async () => {
        const ok = await showConfirm(
          `将「${name}」部署为员工并扫码绑定飞书？\n\n绑定后把该机器人拉进同事所在群，即可协作。`,
        )
        if (!ok) return
        await hireAndBindFeishu(code, {
          roleName: name,
          onBound: () => void refreshFeishuBindingsUi('feishu'),
        })
      })()
      return
    }
    if (act === 'unbind' && code) {
      void (async () => {
        const ok = await showConfirm(
          `确定解除「${name}」的飞书机器人绑定？\n\n解绑后飞书侧将无法再对话到此员工。`,
        )
        if (!ok) return
        await unbindFeishuEmployee(code, {
          onUnbound: () => void refreshFeishuBindingsUi('feishu'),
        })
      })()
    }
  })
}

/** 飞书：员工/上架智能体协作名册（可扫码绑定、部署并绑）。 */
async function refreshFeishuBindingsUi(channelName) {
  const panel = document.getElementById('feishu-bindings-panel')
  const body = document.getElementById('feishu-bindings-body')
  if (!panel || !body) return
  if (channelName !== 'feishu') {
    panel.setAttribute('hidden', '')
    return
  }
  panel.removeAttribute('hidden')
  body.innerHTML = '<p class="im-field-hint" style="margin:0">加载中…</p>'
  try {
    const [rolesData, configData, agents] = await Promise.all([
      api.proactiveListRoles().catch(() => null),
      api.getChannelConfig('feishu').catch(() => null),
      api.listAgents().catch(() => []),
    ])
    const roles = Array.isArray(rolesData?.roles) ? rolesData.roles : []
    const accountsRaw = configData?.config?.accounts
    const accounts = accountsRaw && typeof accountsRaw === 'object' && !Array.isArray(accountsRaw)
      ? accountsRaw
      : {}
    const primaryAppId = String(configData?.config?.app_id || '').trim()
    const hiredCodes = new Set(
      roles.map((r) => String(r?.agent_code || '').trim()).filter(Boolean),
    )

    const employeeRows = []
    for (const role of roles) {
      const code = String(role?.agent_code || '').trim()
      if (!code) continue
      if (String(role?.status || '').toLowerCase() === 'archived') continue
      const binding = feishuBindingOf(role)
      const acc = accounts[code] && typeof accounts[code] === 'object' ? accounts[code] : null
      employeeRows.push({
        kind: 'employee',
        code,
        name: String(role.role_name || code),
        bound: binding.bound,
        appId: String(binding.app_id || acc?.app_id || '').trim(),
        openId: String(binding.open_id || acc?.open_id || '').trim(),
        boundAt: binding.bound_at,
        inChannel: Boolean(acc),
      })
    }

    const hireable = (Array.isArray(agents) ? agents : [])
      .filter((a) => isFeishuHireablePublishedAgent(a, hiredCodes))
      .map((a) => {
        const code = String(a.agent_code || '').trim()
        return {
          kind: 'hireable',
          code,
          name: String(a.agent_name || code),
          bound: false,
          appId: '',
          openId: '',
          boundAt: '',
          inChannel: false,
        }
      })

    const boundRows = employeeRows.filter((r) => r.bound)
    const unboundRows = employeeRows.filter((r) => !r.bound)
    const unboundCount = unboundRows.length

    // Orphan channel accounts not matching a role
    const orphans = []
    for (const [code, acc] of Object.entries(accounts)) {
      if (hiredCodes.has(code) || !acc || typeof acc !== 'object') continue
      orphans.push({
        kind: 'orphan',
        code,
        name: String(acc.name || code),
        bound: true,
        appId: String(acc.app_id || '').trim(),
        openId: String(acc.open_id || '').trim(),
        boundAt: '',
        inChannel: true,
      })
    }

    let html = ''
    html += '<div class="im-bindings-howto">'
    html += '<div class="im-bindings-howto-title">操作指南（给你配，不是给同事配）</div>'
    html += FEISHU_COLLAB_HOWTO_HTML
    html += '</div>'

    // Diagnose primary vs employee bots (shared App ID = historical bootstrap smell)
    const sharedWithPrimary = boundRows.filter(
      (r) => r.appId && primaryAppId && r.appId === primaryAppId,
    )
    const dedicated = boundRows.filter(
      (r) => r.appId && (!primaryAppId || r.appId !== primaryAppId),
    )
    html += '<div class="im-bindings-summary">'
    html += `<span>主机器人 App ID：<code title="${esc(primaryAppId)}">${esc(_shortMono(primaryAppId) || '（未配置）')}</code></span>`
    html += `<span>已绑定 ${boundRows.length} · 专属 ${dedicated.length} · 未绑定 ${unboundCount}</span>`
    if (hireable.length) html += `<span>可部署 ${hireable.length}</span>`
    if (orphans.length) html += `<span>仅通道账号 ${orphans.length}</span>`
    html += '</div>'
    if (!primaryAppId && boundRows.length) {
      html +=
        '<div class="im-bindings-warn" role="status">尚未配置右上角「个人助理主机器人」。当前仅有岗位专属机器人；入站会按岗位 App 路由，建议仍用右上角扫码配一只主机器人（与岗位 App ID 不同）。</div>'
    }
    if (sharedWithPrimary.length) {
      const names = sharedWithPrimary.map((r) => r.name).join('、')
      html += `<div class="im-bindings-warn im-bindings-warn--bad" role="status">以下岗位的 App ID 与主机器人相同（${esc(names)}）：看起来像「绑到主机器人」。请解绑后在本表重新「扫码绑定」创建<strong>专属</strong>应用，或确认群里 @ 的是岗位机器人而非主机器人。</div>`
    }

    const allRows = [...unboundRows, ...hireable, ...boundRows, ...orphans]
    if (!allRows.length) {
      html +=
        '<p class="im-field-hint" style="margin:0">暂无在岗员工。请先在「智能体」部署智能体，或点下方「部署并绑飞书」。本页右上角扫码仅配置全局主机器人（个人助理）。</p>'
      body.innerHTML = html
      _bindFeishuRosterActions(body)
      return
    }

    html += '<div class="im-bindings-table-wrap"><table class="im-bindings-table">'
    html += '<thead><tr><th>岗位 / 智能体</th><th>状态</th><th>App ID</th><th>专属</th><th>操作</th></tr></thead><tbody>'
    for (const row of allRows) {
      const title = `${row.name} (${row.code})`
      let statusHtml = ''
      let actionHtml = '—'
      if (row.kind === 'hireable') {
        statusHtml = '<span class="im-bindings-badge im-bindings-badge--warn">未部署</span>'
        actionHtml = `<button type="button" class="btn btn-sm btn-primary" data-feishu-act="hire-bind" data-code="${esc(row.code)}" data-name="${esc(row.name)}">部署并绑飞书</button>`
      } else if (row.kind === 'orphan') {
        statusHtml = '<span class="im-bindings-badge">仅通道</span>'
      } else if (row.bound) {
        statusHtml = row.inChannel
          ? '<span class="im-bindings-badge im-bindings-badge--ok">已绑定</span>'
          : '<span class="im-bindings-badge im-bindings-badge--warn">未同步</span>'
        actionHtml = `<button type="button" class="btn btn-sm btn-outline" data-feishu-act="unbind" data-code="${esc(row.code)}" data-name="${esc(row.name)}">解绑</button>`
      } else {
        statusHtml = '<span class="im-bindings-badge im-bindings-badge--warn">未绑定</span>'
        actionHtml = `<button type="button" class="btn btn-sm btn-primary" data-feishu-act="bind" data-code="${esc(row.code)}" data-name="${esc(row.name)}">扫码绑定</button>`
      }
      let dedicatedHtml = '—'
      if (row.bound && row.appId) {
        if (primaryAppId && row.appId === primaryAppId) {
          dedicatedHtml =
            '<span class="im-bindings-badge im-bindings-badge--warn" title="与主机器人同一 App ID">与主相同</span>'
        } else {
          dedicatedHtml =
            '<span class="im-bindings-badge im-bindings-badge--ok" title="独立 App，群里请 @ 此机器人">专属</span>'
        }
      }
      html += '<tr>'
      html += `<td><div class="im-bindings-name" title="${esc(title)}">${esc(row.name)}</div>`
      html += `<div class="im-bindings-code"><code>${esc(row.code)}</code></div></td>`
      html += `<td>${statusHtml}</td>`
      html += `<td><code title="${esc(row.appId)}">${esc(row.appId ? _shortMono(row.appId) : '—')}</code></td>`
      html += `<td>${dedicatedHtml}</td>`
      html += `<td class="im-bindings-actions">${actionHtml}</td>`
      html += '</tr>'
    }
    html += '</tbody></table></div>'

    const firstUnbound = listUnboundFeishuRoles(roles)[0]
    if (firstUnbound || hireable.length) {
      html += '<div class="im-bindings-footer">'
      if (firstUnbound) {
        const n = String(firstUnbound.role_name || firstUnbound.agent_code || '')
        html += `<button type="button" class="btn btn-sm btn-primary" data-feishu-act="bind" data-code="${esc(firstUnbound.agent_code)}" data-name="${esc(n)}">继续绑定未绑岗位</button>`
      }
      html += '</div>'
    }

    body.innerHTML = html
    _bindFeishuRosterActions(body)
  } catch (e) {
    body.innerHTML = `<p class="im-field-hint" style="margin:0">无法加载绑定关系：${esc(String(e?.message || e))}</p>`
  }
}

/** 飞书：展示网关记录的会话 chat_id（入站会话变化会更新；config 可固定覆盖），便于确认是否已提取。 */
async function refreshFeishuInboundChatIdUi(channelName) {
  const row = document.getElementById('feishu-inbound-chat-row')
  const idEl = document.getElementById('feishu-inbound-chat-id')
  const srcEl = document.getElementById('feishu-inbound-chat-source')
  if (!row || !idEl) return
  if (channelName !== 'feishu') {
    row.setAttribute('hidden', '')
    return
  }
  row.removeAttribute('hidden')
  idEl.textContent = '\u52a0\u8f7d\u4e2d\u2026'
  if (srcEl) srcEl.textContent = ''
  try {
    const r = await api.automationFeishuPushDefault()
    const cid = r && r.chat_id ? String(r.chat_id).trim() : ''
    if (cid) {
      idEl.textContent = cid
      if (srcEl) {
        if (r.from_config) {
          srcEl.textContent = '\u6765\u6e90\uff1achannels.feishu.automation_push_chat_id\uff08config\uff09'
        } else if (r.from_learned) {
          srcEl.textContent = '\u6765\u6e90\uff1a\u6839\u636e\u5165\u7ad9\u6d88\u606f\u81ea\u52a8\u8bb0\u5f55\uff08\u5207\u6362\u4f1a\u8bdd\u540e\u4f1a\u66f4\u65b0\uff09'
        } else {
          srcEl.textContent = '\u6765\u6e90\uff1a\u7f51\u5173\u9ed8\u8ba4\u63a8\u9001\u76ee\u6807'
        }
      }
    } else {
      idEl.textContent = '\uff08\u5c1a\u672a\u8bb0\u5f55\uff09'
      if (srcEl) {
        srcEl.textContent =
          '\u5728\u672a\u914d\u7f6e channels.feishu.automation_push_chat_id \u65f6\uff0c\u7f51\u5173\u4f1a\u7528\u60a8\u6700\u8fd1\u5728\u98de\u4e66\u5411\u673a\u5668\u4eba\u53d1\u6d88\u606f\u7684\u4f1a\u8bdd chat_id\uff08\u5207\u6362\u7fa4/\u5355\u804a\u540e\u4f1a\u968f\u4e4b\u66f4\u65b0\uff09\u3002'
      }
    }
  } catch (_) {
    idEl.textContent = '\uff08\u65e0\u6cd5\u83b7\u53d6\uff09'
    if (srcEl) srcEl.textContent = '\u8bf7\u786e\u8ba4 Gateway \u5df2\u542f\u52a8\u4e14\u672c\u673a\u53ef\u8bbf\u95ee /api/automation/feishu-push-default'
  }
}

let _loadSeq = 0

/** Sidebar / API channel order (飞书 first, 微信 second). */
const CHANNEL_DISPLAY_ORDER = ['feishu', 'weixin', 'dingtalk', 'slack', 'telegram', 'discord', 'qqbot']

function sortChannelEntries(entries) {
  const rank = new Map(CHANNEL_DISPLAY_ORDER.map((name, i) => [name, i]))
  return [...entries].sort((a, b) => {
    const ra = rank.has(a[0]) ? rank.get(a[0]) : 999
    const rb = rank.has(b[0]) ? rank.get(b[0]) : 999
    if (ra !== rb) return ra - rb
    return String(a[0]).localeCompare(String(b[0]))
  })
}

function channelsShellHtml(settingsModal) {
  if (settingsModal) {
    return `
      <div class="settings-modal-pane-body settings-modal-pane-body--channels">
        <div id="channels-loading" class="settings-modal-pane-loading" role="status"><span>loading...</span></div>
        <div id="channels-content" class="settings-modal-pane-fill channels-page-inner" hidden></div>
        <div id="channels-error" class="settings-modal-pane-fill settings-modal-pane-error" hidden></div>
      </div>
    `
  }
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">IM Channels</h1>
        <p class="page-desc">Manage EvoFlow multi-channel (Feishu, Weixin, Slack, Telegram, etc)</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-reload">Reload</button>
      </div>
    </div>
    <div class="page-content channels-page">
      <div id="channels-loading" class="channels-phase-loading" role="status">loading...</div>
      <div id="channels-content" class="channels-page-inner" style="display:none"></div>
      <div id="channels-error" class="channels-phase-error" style="display:none"></div>
    </div>
  `
}

function setChannelsPhase(page, phase) {
  const loadingEl = page.querySelector('#channels-loading')
  const contentEl = page.querySelector('#channels-content')
  const errorEl = page.querySelector('#channels-error')
  const modal = !!page.querySelector('.settings-modal-pane-body--channels')
  if (modal) {
    if (phase === 'loading') { loadingEl?.removeAttribute('hidden'); contentEl?.setAttribute('hidden', ''); errorEl?.setAttribute('hidden', '') }
    else if (phase === 'content') { loadingEl?.setAttribute('hidden', ''); contentEl?.removeAttribute('hidden'); errorEl?.setAttribute('hidden', '') }
    else if (phase === 'error') { loadingEl?.setAttribute('hidden', ''); contentEl?.setAttribute('hidden', ''); errorEl?.removeAttribute('hidden') }
    return
  }
  if (loadingEl) loadingEl.style.display = phase === 'loading' ? 'block' : 'none'
  if (contentEl) contentEl.style.display = phase === 'content' ? 'block' : 'none'
  if (errorEl) errorEl.style.display = phase === 'error' ? 'block' : 'none'
}

export function createChannelsRoot(settingsModal) {
  const root = document.createElement('div')
  root.className = settingsModal ? 'settings-modal-pane settings-modal-pane--channels' : 'page channels-page'
  root.innerHTML = channelsShellHtml(settingsModal)
  return root
}

export async function render() {
  const page = createChannelsRoot(false)
  bindEvents(page)
  loadChannels(page)
  return page
}

export function mountChannelsForSettingsModal(container) {
  const root = createChannelsRoot(true)
  container.replaceChildren(root)
  bindEvents(root)
  loadChannels(root)
}

async function loadChannels(page) {
  const errorEl = page.querySelector('#channels-error')
  setChannelsPhase(page, 'loading')
  const seq = ++_loadSeq
  try {
    const data = await api.getChannelsStatus()
    if (seq !== _loadSeq) return
    if (!data || typeof data !== 'object' || typeof data.channels !== 'object') {
      throw new Error('频道接口返回异常（可能命中了页面缓存，请硬刷新或重启 Gateway）')
    }
    setChannelsPhase(page, 'content')
    renderChannels(page, data)
  } catch (e) {
    if (seq !== _loadSeq) return
    setChannelsPhase(page, 'error')
    if (errorEl) errorEl.textContent = 'Failed to load: ' + e
    toast('Failed: ' + e, 'error')
  }
}

const CHANNEL_ICONS = {
  feishu: '<img src="/assets/feishu-logo.png" width="20" height="20" alt="Feishu" style="border-radius:4px">',
  dingtalk: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#0083FF"><path d="M10.64 2.68a1.33 1.33 0 0 1 1.72 0l6.87 5.84c.53.45.59 1.24.14 1.77L16.07 13H19a1 1 0 0 1 .89.55l2 4A1 1 0 0 1 21 19h-5.62l-3.38 2.86a1.33 1.33 0 0 1-1.72 0L3.41 16.02a1.33 1.33 0 0 1-.14-1.77L7.93 9H5a1 1 0 0 1-.89-.55l-2-4A1 1 0 0 1 3 3h5.62l3.38-2.86z"/></svg>',
  slack: '<img src="/icons/slack.svg" width="20" height="20" alt="Slack">',
  telegram: '<img src="/icons/telegram.svg" width="20" height="20" alt="Telegram">',
  weixin: '<svg viewBox="0 0 24 24" width="20" height="20" aria-label="WeChat"><path fill="#07C160" d="M8.5 9.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zm7 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"/><path fill="#07C160" d="M12 2C6.5 2 2 5.6 2 10c0 2.2 1.1 4.2 2.9 5.7L3 22l6.5-2.1c.8.2 1.6.3 2.5.3 5.5 0 10-3.6 10-8.2S17.5 2 12 2z"/></svg>',
}

const CHANNEL_LABELS = {
  feishu: '\u98de\u4e66',
  dingtalk: '\u9489\u9489',
  slack: 'Slack',
  telegram: 'Telegram',
  weixin: '\u5fae\u4fe1',
  wecom: '\u4f01\u4e1a\u5fae\u4fe1',
  qq: 'QQ',
  yunxin: '\u4fe1\u606f',
  xiaomifeng: '\u5c0f\u8702\u8702',
  wechat: '\u5fae\u4fe1',
}

const CHANNEL_TIPS = {
  feishu: '<p style="margin:0 0 6px">\ud83d\udcf1 \u70b9\u51fb\u53f3\u4e0a\u65b9\u300c<b>\u626b\u7801\u7ed1\u5b9a</b>\u300d\u914d\u7f6e<strong>\u5168\u5c40\u4e3b\u673a\u5668\u4eba</strong>\uff1b\u5458\u5de5\u4e2a\u4eba\u673a\u5668\u4eba\u8bf7\u5728\u540d\u518c\u626b\u7801\uff0c\u7ed1\u5b9a\u5173\u7cfb\u89c1\u4e0b\u65b9\u5217\u8868\uff08\u542b open_id\uff09\u3002</p><ol><li>\u524d\u5f80 <a href="https://open.feishu.cn/" target="_blank" rel="noopener">\u98de\u4e66\u5f00\u653e\u5e73\u53f0</a> \u521b\u5efa\u673a\u5668\u4eba\u5e94\u7528</li><li>\u83b7\u53d6 App ID \u548c App Secret</li><li>\u5f00\u542f\u673a\u5668\u4eba\u80fd\u529b\uff0c\u586b\u5199\u4e0b\u65b9\u914d\u7f6e</li><li>\u5f00\u542f\u5de6\u4fa7\u5f00\u5173\uff0c\u673a\u5668\u4eba\u5c06\u901a\u8fc7 Stream \u6a21\u5f0f\u8fde\u63a5</li></ol><a href="https://open.feishu.cn/document/home/introduction-to-custom-bot-development/bot-info-obtain-client-credentials" target="_blank" rel="noopener" class="im-setup-link">\u67e5\u770b\u6587\u6863</a>',
  weixin: '<p style="margin:0 0 6px">\ud83d\udcf1 \u70b9\u51fb\u53f3\u4e0a\u65b9\u300c<b>\u5fae\u4fe1\u626b\u7801\u7ed1\u5b9a</b>\u300d\uff0c\u901a\u8fc7\u817e\u8baf iLink Bot \u63a5\u5165\u4e2a\u4eba\u5fae\u4fe1\uff08\u957f\u8f6e\u8be2\uff0c\u65e0\u9700\u516c\u7f51 webhook\uff09\u3002</p><ol><li>\u7528\u624b\u673a\u5fae\u4fe1\u626b\u63cf\u5f39\u7a97\u4e2d\u7684\u4e8c\u7ef4\u7801\u5e76\u5728\u5fae\u4fe1\u5185\u786e\u8ba4\u767b\u5f55</li><li>\u6210\u529f\u540e\u4f1a\u81ea\u52a8\u5199\u5165\u51ed\u8bc1\u5e76\u53ef\u5f00\u542f\u6e20\u9053</li><li>\u4e5f\u53ef\u624b\u52a8\u586b\u5199 Account ID \u4e0e Bot Token</li></ol><p style="margin:8px 0 0;font-size:12px;color:var(--text-tertiary, #888)">\u4e2a\u4eba\u5fae\u4fe1\u63a5\u5165\u6709\u98ce\u63a7\u98ce\u9669\uff0c\u5efa\u8bae\u4f7f\u7528\u5c0f\u53f7\u3002</p>',
  dingtalk: '<ol><li>\u524d\u5f80 <a href="https://open-dev.dingtalk.com/" target="_blank" rel="noopener">\u9489\u9489\u5f00\u653e\u5e73\u53f0</a> \u521b\u5efa\u673a\u5668\u4eba\u5e94\u7528</li><li>\u83b7\u53d6 Client ID \u548c Client Secret</li><li>\u5f00\u542f\u673a\u5668\u4eba\u80fd\u529b\uff0c\u586b\u5199\u4e0b\u65b9\u914d\u7f6e</li><li>\u5f00\u542f\u5de6\u4fa7\u5f00\u5173\uff0c\u673a\u5668\u4eba\u5c06\u81ea\u52a8\u8fde\u63a5</li></ol><a href="https://open.dingtalk.com/document/orgapp/custom-robot-access" target="_blank" rel="noopener" class="im-setup-link">\u67e5\u770b\u6587\u6863</a>',
  default: '<ol><li>\u5728\u5bf9\u5e94\u5e73\u53f0\u521b\u5efa\u673a\u5668\u4eba\u5e94\u7528\u5e76\u83b7\u53d6\u51ed\u8bc1</li><li>\u586b\u5199\u4e0b\u65b9 Client ID \u548c Client Secret</li><li>\u5f00\u542f\u5de6\u4fa7\u5f00\u5173\u5373\u53ef\u5efa\u7acb\u8fde\u63a5</li></ol>',
}

/** Labels / placeholders for the shared credential fields (Feishu vs Weixin). */
function syncImCredentialUi(channelName) {
  const p = document.getElementById('im-primary-label')
  const s = document.getElementById('im-secondary-label')
  const idInput = document.getElementById('im-app-id')
  const secInput = document.getElementById('im-app-secret')
  if (!p || !s || !idInput || !secInput) return
  if (channelName === 'weixin') {
    p.textContent = 'Account ID'
    s.textContent = 'Bot Token'
    idInput.placeholder = 'iLink bot id'
    secInput.placeholder = 'bot token'
  } else {
    p.textContent = 'App ID'
    s.textContent = 'App Secret'
    idInput.placeholder = 'cli_xxxxxxxx'
    secInput.placeholder = ''
  }
}

function renderChannels(page, data) {
  const contentEl = page.querySelector('#channels-content')
  const channels = data?.channels || {}
  const channelList = sortChannelEntries(Object.entries(channels))

  if (!channelList.length) {
    const serviceDown = data?.service_running === false
    contentEl.innerHTML = `
      <div class="channels-empty">
        <p class="channels-empty-title">${serviceDown ? '频道服务未就绪' : '暂无频道'}</p>
        <p class="channels-empty-desc">${
          serviceDown
            ? 'Gateway 的 IM 频道服务尚未启动。请确认 Gateway 已完全启动，或点击下方重试。'
            : '请在配置中添加 IM 频道（飞书、微信等）。'
        }</p>
        <button type="button" class="btn btn-secondary btn-sm" id="channels-empty-retry">重新加载</button>
      </div>`
    contentEl.querySelector('#channels-empty-retry')?.addEventListener('click', () => loadChannels(page))
    return
  }

  const firstChannel = channelList[0][0]

  let html = '<div class="im-split-layout">'
  // Sidebar
  html += '<aside class="im-sidebar"><nav class="im-channel-list" id="im-channel-list">'

  for (const [name, status] of channelList) {
    const label = CHANNEL_LABELS[name] || name
    const icon = CHANNEL_ICONS[name] || ''
    const enabled = status.enabled
    const running = status.running
    const isSelected = name === firstChannel

    html += '<div class="im-channel-item' + (isSelected ? ' im-channel-item--active' : '') + '" data-channel="' + esc(name) + '">'
    html += '<div class="im-item-left"><span class="im-item-icon">' + icon + '</span>'
    html += '<span class="im-item-name">' + esc(label) + '</span></div>'
    html += '<label class="im-toggle"><input type="checkbox" class="channel-toggle im-toggle-input" data-channel="' + esc(name) + '"' + (enabled ? ' checked' : '') + '>'
    html += '<span class="im-toggle-track" aria-hidden="true"></span></label>'
    if (running) html += '<span class="im-item-status im-item-status--on" title="Running"></span>'
    html += '</div>'
  }

  html += '</nav></aside>'

  // Main panel
  const selName = firstChannel
  const selLabel = CHANNEL_LABELS[selName] || selName
  const selIcon = CHANNEL_ICONS[selName] || ''
  const selStatus = channelList.find(([n]) => n === selName)?.[1]
  const selRunning = selStatus?.running || false

  html += '<main class="im-main" id="im-main-panel">'
  // Title bar: title left, status + scan + test on the right
  html += '<div class="im-title-bar">'
  html += '<span class="im-title-icon">' + selIcon + '</span>'
  html += '<strong>' + esc(selLabel) + '\u8bbe\u7f6e</strong>'
  html += '<div class="im-title-trailing">'
  html += '<span class="im-title-status' + (selRunning ? '' : ' im-title-status--off') + '">' + (selRunning ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5') + '</span>'
  html += '<button type="button" class="im-scan-btn" id="feishu-scan-btn" style="display:' + (selName === 'feishu' ? '' : 'none') + '">\ud83d\udcf1 \u626b\u7801\u7ed1\u5b9a</button>'
  html += '<button type="button" class="im-scan-btn" id="weixin-scan-btn" style="display:' + (selName === 'weixin' ? '' : 'none') + '">\ud83d\udcf1 \u5fae\u4fe1\u626b\u7801\u7ed1\u5b9a</button>'
  html += '<button type="button" class="btn btn-sm btn-outline im-title-test-btn" id="im-test-btn"><span class="im-signal-icon">\uD83D\uDCE1</span> \u6d4b\u8bd5\u8fde\u901a\u6027</button>'
  html += '</div></div>'

  // Tips
  const tips = CHANNEL_TIPS[selName] || CHANNEL_TIPS.default
  html += '<div class="im-tips">' + tips + '</div>'

  // Form
  html += '<form class="im-form" id="im-config-form" data-channel="' + esc(selName) + '">'
  html += '<div class="im-field-group"><label class="im-label" for="im-app-id" id="im-primary-label">App ID</label>'
  html += '<input class="im-input" id="im-app-id" name="app_id" type="text" placeholder="cli_xxxxxxxx"></div>'
  html += '<div class="im-field-group"><label class="im-label" for="im-app-secret" id="im-secondary-label">App Secret</label>'
  html += '<div class="im-secret-wrap"><input class="im-input" id="im-app-secret" name="app_secret" type="password">'
  html += '<button type="button" class="im-eye-btn" aria-label="toggle visibility">\uD83D\uDC41\uFE0F</button></div></div>'
  html += '<div class="im-field-group im-feishu-inbound-chat-row" id="feishu-inbound-chat-row" hidden>'
  html += '<label class="im-label" id="feishu-inbound-chat-label">\u4f1a\u8bdd chat_id\uff08\u9ed8\u8ba4\u63a8\u9001\uff0c\u968f\u6700\u65b0\u5165\u7ad9\u4f1a\u8bdd\u66f4\u65b0\uff09</label>'
  html += '<div class="im-readonly-mono" id="feishu-inbound-chat-id" aria-live="polite">\u2014</div>'
  html += '<p class="im-field-hint" id="feishu-inbound-chat-source" style="margin:0"></p>'
  html += '</div>'
  html += '<div class="im-field-group im-feishu-bindings" id="feishu-bindings-panel" hidden>'
  html += '<div class="im-bindings-head">'
  html += '<label class="im-label" style="margin:0">上岗智能体 · 飞书协作</label>'
  html += '<button type="button" class="btn btn-sm btn-outline" id="feishu-bindings-refresh">刷新</button>'
  html += '</div>'
  html +=
    '<p class="im-field-hint" style="margin:0">右上角「扫码绑定」= 个人助理主机器人。下方名册 = 各岗位专属机器人。拉群与同事用法见下方操作指南。</p>'
  html += '<div id="feishu-bindings-body" class="im-bindings-body" aria-live="polite">—</div>'
  html += '</div>'
  html += '</form></main></div>'

  // Feishu QR scan modal (hidden by default)
  html += '<div class="im-scan-modal" id="feishu-scan-modal" hidden>'
  html += '<div class="im-scan-overlay" id="feishu-scan-overlay"></div>'
  html += '<div class="im-scan-dialog">'
  html += '<div class="im-scan-header"><strong>飞书扫码绑定</strong><button type="button" class="im-scan-close" id="feishu-scan-close" aria-label="关闭">&times;</button></div>'
  html += '<div class="im-scan-body">'
  html += '<div id="feishu-scan-qr-wrap" class="im-scan-qr-wrap"><div id="feishu-scan-loading">加载中...</div></div>'
  html += '<p id="feishu-scan-hint" class="im-scan-hint">打开飞书 App 扫描下方二维码</p>'
  html += '<div id="feishu-scan-status" class="im-scan-status" hidden></div>'
  html += '</div></div></div>'

  html += '<div class="im-scan-modal" id="weixin-scan-modal" hidden>'
  html += '<div class="im-scan-overlay" id="weixin-scan-overlay"></div>'
  html += '<div class="im-scan-dialog">'
  html += '<div class="im-scan-header"><strong>微信扫码绑定（iLink）</strong><button type="button" class="im-scan-close" id="weixin-scan-close" aria-label="关闭">&times;</button></div>'
  html += '<div class="im-scan-body">'
  html += '<div id="weixin-scan-qr-wrap" class="im-scan-qr-wrap"><div id="weixin-scan-loading">加载中...</div></div>'
  html += '<p id="weixin-scan-hint" class="im-scan-hint">使用手机微信扫描下方二维码</p>'
  html += '<div id="weixin-scan-status" class="im-scan-status" hidden></div>'
  html += '</div></div></div>'

  contentEl.innerHTML = html
  syncImCredentialUi(selName)
  loadChannelConfig(selName)
  void refreshFeishuInboundChatIdUi(selName)
  void refreshFeishuBindingsUi(selName)
  contentEl.querySelector('#feishu-bindings-refresh')?.addEventListener('click', () => {
    void refreshFeishuBindingsUi('feishu')
  })

  // Channel selection
  contentEl.querySelectorAll('.im-channel-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.im-toggle')) return
      contentEl.querySelectorAll('.im-channel-item').forEach(i => i.classList.remove('im-channel-item--active'))
      item.classList.add('im-channel-item--active')
      const ch = item.dataset.channel
      updateRightPanel(ch, CHANNEL_LABELS[ch], CHANNEL_ICONS[ch] || '', channelList.find(([n]) => n === ch)?.[1])
    })
  })

  // Toggle enable/disable
  contentEl.querySelectorAll('.channel-toggle').forEach(checkbox => {
    checkbox.onchange = async () => {
      const name = checkbox.dataset.channel
      const enabled = checkbox.checked
      try {
        const result = await api.enableChannel(name, enabled)
        if (result.success) {
          toast('Channel ' + name + (enabled ? ' enabled' : ' disabled'), 'success')
          loadChannels(page)
        } else {
          toast(result.message || 'Failed', 'error')
          checkbox.checked = !enabled
        }
      } catch (e) {
        toast('Error: ' + e, 'error')
        checkbox.checked = !enabled
      }
    }
  })

  // Eye toggle
  const eyeBtn = contentEl.querySelector('#im-app-secret')?.parentElement?.querySelector('.im-eye-btn')
  if (eyeBtn) {
    eyeBtn.onclick = () => {
      const input = contentEl.querySelector('#im-app-secret')
      input.type = input.type === 'password' ? 'text' : 'password'
    }
  }

  // Auto-save on input blur
  const configForm = contentEl.querySelector('#im-config-form')
  let _saveTimer = null
  async function autoSave() {
    const ch = configForm.dataset.channel
    const idVal = configForm.querySelector('[name="app_id"]').value.trim()
    const secVal = configForm.querySelector('[name="app_secret"]').value.trim()
    const newConfig = {}
    if (ch === 'weixin') {
      if (idVal) newConfig.account_id = idVal
      if (secVal) newConfig.token = secVal
    } else {
      if (idVal) newConfig.app_id = idVal
      if (secVal) newConfig.app_secret = secVal
    }
    try {
      const result = await api.updateChannelConfig(ch, newConfig)
      if (result.success) {
        toast('\u5df2\u4fdd\u5b58', 'success')
      } else {
        toast(result.message || '\u4fdd\u5b58\u5931\u8d25', 'error')
      }
    } catch (ex) {
      toast('\u4fdd\u5b58\u9519\u8bef: ' + ex, 'error')
    }
  }
  configForm.querySelectorAll('.im-input').forEach(input => {
    input.addEventListener('blur', () => { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(autoSave, 300) })
  })

  // Test connectivity
  const testBtn = contentEl.querySelector('#im-test-btn')
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const ch = configForm.dataset.channel
      const idVal = configForm.querySelector('[name="app_id"]').value.trim()
      const secVal = configForm.querySelector('[name="app_secret"]').value.trim()
      if (ch === 'weixin') {
        if (!idVal || !secVal) {
          toast('\u8bf7\u5148\u586b\u5199 Account ID \u548c Bot Token', 'warning')
          return
        }
      } else if (!idVal || !secVal) {
        toast('\u8bf7\u5148\u586b\u5199 App ID \u548c App Secret', 'warning')
        return
      }
      testBtn.disabled = true
      const origText = testBtn.innerHTML
      testBtn.innerHTML = '<span class="im-signal-icon">\uD83D\uDCE1</span> \u6d4b\u8bd5\u4e2d...'
      try {
        const patch = ch === 'weixin' ? { account_id: idVal, token: secVal } : { app_id: idVal, app_secret: secVal }
        try {
          await api.updateChannelConfig(ch, patch)
        } catch (saveEx) {
          toast('\u274C \u4fdd\u5b58\u51ed\u636e\u5931\u8d25\uff1a' + saveEx, 'error')
          return
        }
        const result = await api.restartChannel(ch)
        if (result.success) {
          toast('\u2705 \u8fde\u63a5\u6b63\u5e38\uff08\u6e20\u9053\u5df2\u5c31\u7eea\uff09', 'success')
          if (ch === 'feishu') void refreshFeishuInboundChatIdUi('feishu')
          setTimeout(() => loadChannels(page), 1000)
        } else {
          toast(
            '\u274C \u8fde\u63a5\u5931\u8d25\uff1a' + (result.message || '\u65e0\u6cd5\u542f\u52a8\u6e20\u9053\uff0c\u8bf7\u68c0\u67e5\u51ed\u636e\u6216\u7f51\u7edc'),
            'error',
          )
        }
      } catch (ex) {
        toast('\u274C \u8fde\u63a5\u5931\u8d25\uff1a' + ex, 'error')
      } finally {
        testBtn.disabled = false
        testBtn.innerHTML = origText
      }
    })
  }

  // Feishu QR scan button
  const scanBtn = contentEl.querySelector('#feishu-scan-btn')
  if (scanBtn) {
    scanBtn.addEventListener('click', () => startFeishuScan(page, configForm))
  }
  const closeBtn = contentEl.querySelector('#feishu-scan-close')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => { cancelFeishuScan(); closeFeishuScanModal(contentEl) })
  }
  const overlay = contentEl.querySelector('#feishu-scan-overlay')
  if (overlay) {
    overlay.addEventListener('click', () => { cancelFeishuScan(); closeFeishuScanModal(contentEl) })
  }
  const wxClose = contentEl.querySelector('#weixin-scan-close')
  if (wxClose) {
    wxClose.addEventListener('click', () => { cancelWeixinScan(); closeWeixinScanModal(contentEl) })
  }
  const wxOverlay = contentEl.querySelector('#weixin-scan-overlay')
  if (wxOverlay) {
    wxOverlay.addEventListener('click', () => { cancelWeixinScan(); closeWeixinScanModal(contentEl) })
  }
  const wxScanBtn = contentEl.querySelector('#weixin-scan-btn')
  if (wxScanBtn) {
    wxScanBtn.addEventListener('click', () => startWeixinScan(page, configForm))
  }
}

// -- Feishu QR scan flow ---------------------------------------------------

let _scanPollTimer = null
let _scanSessionId = null
let _feishuLastPollQr = ''

async function startFeishuScan(page, configForm) {
  const modal = document.getElementById('feishu-scan-modal')
  const qrWrap = document.getElementById('feishu-scan-qr-wrap')
  const hint = document.getElementById('feishu-scan-hint')
  const statusEl = document.getElementById('feishu-scan-status')

  if (!modal) return
  // 先清理旧的轮询和 session，避免多个轮询同时运行
  cancelFeishuScan()
  _scanSessionId = null
  _feishuLastPollQr = ''
  modal.removeAttribute('hidden')
  hint.textContent = '正在获取二维码...'
  if (statusEl) {
    statusEl.removeAttribute('hidden')
    statusEl.textContent = '正在获取二维码…'
    statusEl.className = 'im-scan-status'
  }
  if (qrWrap) qrWrap.innerHTML = '<div id="feishu-scan-loading">加载中...</div>'

  try {
    ensureQrImgFallbackHandler()
    const result = await api.beginFeishuRegistration()
    _scanSessionId = result.session_id
    const qrUrl = result.qr_url
    _feishuLastPollQr = String(qrUrl || '')

    if (qrWrap) {
      qrWrap.innerHTML = qrUrl
        ? await qrImageHtml(qrUrl, { size: 260, alt: '飞书扫码' })
        : '<p class="im-scan-error">未返回二维码链接</p>'
    }
    if (hint) hint.textContent = '打开飞书 App 扫描下方二维码'
    if (statusEl) {
      statusEl.removeAttribute('hidden')
      statusEl.textContent = '等待扫码…'
      statusEl.className = 'im-scan-status'
    }

    // Start polling
    _scanPollTimer = setInterval(() => pollFeishuScan(page, configForm), 2000)
  } catch (e) {
    if (hint) hint.textContent = '获取二维码失败'
    if (qrWrap) qrWrap.innerHTML = `<p class="im-scan-error">错误: ${e.message || e}</p>`
    toast('扫码失败: ' + e, 'error')
  }
}

async function pollFeishuScan(page, configForm) {
  if (!_scanSessionId) return

  try {
    const result = await api.pollFeishuRegistration(_scanSessionId)
    const statusEl = document.getElementById('feishu-scan-status')
    const qrWrap = document.getElementById('feishu-scan-qr-wrap')

    // 轮询时检查二维码是否更新
    if (result.qr_url && qrWrap && (result.status === 'pending' || result.status === 'scanning')) {
      const u = String(result.qr_url)
      if (u !== _feishuLastPollQr) {
        _feishuLastPollQr = u
        ensureQrImgFallbackHandler()
        qrWrap.innerHTML = await qrImageHtml(u, { size: 260, alt: '飞书扫码' })
      }
    }

    if (result.status === 'completed') {
      const sessionId = _scanSessionId
      _scanSessionId = null
      cancelFeishuScan()
      if (!sessionId) return
      closeFeishuScanModal(document.getElementById('channels-content'))

      // Auto-fill the form
      const appIdInput = document.getElementById('im-app-id')
      const secretInput = document.getElementById('im-app-secret')
      if (appIdInput && result.app_id) appIdInput.value = result.app_id
      if (secretInput && result.app_secret) secretInput.value = result.app_secret

      // Auto-save and restart
      toast('扫码成功，正在保存配置...', 'success')
      try {
        const applyResult = await api.applyFeishuRegistration(sessionId, true)
        if (applyResult.success) {
          toast(applyResult.message + (applyResult.channel_running ? '，机器人已启动' : '，重启后生效'), 'success')
          // Reload channels to refresh status
          setTimeout(() => loadChannels(page), 1000)
        } else {
          toast('保存失败: ' + applyResult.message, 'error')
        }
      } catch (e) {
        // Fallback: save manually via updateChannelConfig
        toast('保存中...', 'info')
        try {
          await api.updateChannelConfig('feishu', { app_id: result.app_id, app_secret: result.app_secret, enabled: true })
          await api.restartChannel('feishu')
          toast('配置已保存并启动', 'success')
          setTimeout(() => loadChannels(page), 1000)
        } catch (e2) {
          toast('保存失败: ' + e2, 'error')
        }
      }

      return
    }

    if (result.status === 'failed') {
      cancelFeishuScan()
      _scanSessionId = null
      if (statusEl) {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '授权失败: ' + (result.error || '未知错误')
        statusEl.className = 'im-scan-status im-scan-status--error'
      }
      return
    }

    if (result.status === 'expired') {
      cancelFeishuScan()
      _scanSessionId = null
      if (statusEl) {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '二维码已过期，请重新扫码'
        statusEl.className = 'im-scan-status im-scan-status--error'
      }
      return
    }

    if (statusEl) {
      if (result.status === 'scanning') {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '已扫码，请在飞书中确认授权…'
        statusEl.className = 'im-scan-status im-scan-status--waiting'
      } else if (result.status === 'pending') {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '等待扫码…'
        statusEl.className = 'im-scan-status'
      }
    }
  } catch (e) {
    // Poll error — keep trying
  }
}

function cancelFeishuScan() {
  if (_scanPollTimer) {
    clearInterval(_scanPollTimer)
    _scanPollTimer = null
  }
  _scanSessionId = null
  _feishuLastPollQr = ''
}

function closeFeishuScanModal(contentEl) {
  const modal = contentEl?.querySelector('#feishu-scan-modal')
  if (modal) modal.setAttribute('hidden', '')
}

// -- Weixin iLink QR scan flow ---------------------------------------------

let _weixinScanPollTimer = null
let _weixinScanSessionId = null
let _weixinLastPollQr = ''

async function startWeixinScan(page, configForm) {
  const modal = document.getElementById('weixin-scan-modal')
  const qrWrap = document.getElementById('weixin-scan-qr-wrap')
  const hint = document.getElementById('weixin-scan-hint')
  const statusEl = document.getElementById('weixin-scan-status')

  if (!modal) return
  cancelWeixinScan()
  _weixinScanSessionId = null
  modal.removeAttribute('hidden')
  if (hint) hint.textContent = '\u6b63\u5728\u83b7\u53d6\u4e8c\u7ef4\u7801...'
  if (statusEl) statusEl.setAttribute('hidden', '')
  if (qrWrap) qrWrap.innerHTML = '<div id="weixin-scan-loading">\u52a0\u8f7d\u4e2d...</div>'

  try {
    const result = await api.beginWeixinRegistration()
    _weixinScanSessionId = result.session_id
    const qrUrl = result.qr_url
    _weixinLastPollQr = String(qrUrl || '')

    if (qrWrap && qrUrl) {
      qrWrap.innerHTML = await qrImageHtml(qrUrl, { size: 260, alt: '微信扫码' })
    }
    if (hint) hint.textContent = '\u4f7f\u7528\u624b\u673a\u5fae\u4fe1\u626b\u63cf\u4e0b\u65b9\u4e8c\u7ef4\u7801'

    _weixinScanPollTimer = setInterval(() => pollWeixinScan(page, configForm), 2000)
  } catch (e) {
    if (hint) hint.textContent = '\u83b7\u53d6\u4e8c\u7ef4\u7801\u5931\u8d25'
    if (qrWrap) qrWrap.innerHTML = `<p class="im-scan-error">\u9519\u8bef: ${esc(String(e.message || e))}</p>`
    toast('\u5fae\u4fe1\u626b\u7801\u5931\u8d25: ' + e, 'error')
  }
}

async function pollWeixinScan(page, configForm) {
  if (!_weixinScanSessionId) return

  try {
    const result = await api.pollWeixinRegistration(_weixinScanSessionId)
    const statusEl = document.getElementById('weixin-scan-status')
    const qrWrap = document.getElementById('weixin-scan-qr-wrap')

    if (result.qr_url && qrWrap && (result.status === 'pending' || result.status === 'scanning')) {
      const u = String(result.qr_url)
      if (u !== _weixinLastPollQr) {
        _weixinLastPollQr = u
        qrWrap.innerHTML = await qrImageHtml(u, { size: 260, alt: '微信扫码' })
      }
    }

    if (result.status === 'completed') {
      const sid = _weixinScanSessionId
      _weixinScanSessionId = null
      cancelWeixinScan()
      if (!sid) return
      closeWeixinScanModal(document.getElementById('channels-content'))

      const appIdInput = document.getElementById('im-app-id')
      const secretInput = document.getElementById('im-app-secret')
      if (appIdInput && result.account_id) appIdInput.value = result.account_id
      if (secretInput && result.token) secretInput.value = result.token

      toast('\u626b\u7801\u6210\u529f\uff0c\u6b63\u5728\u4fdd\u5b58\u914d\u7f6e...', 'success')
      try {
        const applyResult = await api.applyWeixinRegistration(sid, true)
        if (applyResult.success) {
          toast(applyResult.message + (applyResult.channel_running ? '\uff0c\u6e20\u9053\u5df2\u542f\u52a8' : '\uff0c\u91cd\u542f\u540e\u751f\u6548'), 'success')
          setTimeout(() => loadChannels(page), 1000)
        } else {
          toast('\u4fdd\u5b58\u5931\u8d25: ' + applyResult.message, 'error')
        }
      } catch (e) {
        toast('\u4fdd\u5b58\u4e2d...', 'info')
        try {
          await api.updateChannelConfig('weixin', {
            account_id: result.account_id,
            token: result.token,
            base_url: result.base_url || '',
            enabled: true,
          })
          await api.restartChannel('weixin')
          toast('\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u542f\u52a8', 'success')
          setTimeout(() => loadChannels(page), 1000)
        } catch (e2) {
          toast('\u4fdd\u5b58\u5931\u8d25: ' + e2, 'error')
        }
      }
      return
    }

    if (result.status === 'failed') {
      cancelWeixinScan()
      _weixinScanSessionId = null
      if (statusEl) {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '\u6388\u6743\u5931\u8d25: ' + (result.error || '\u672a\u77e5\u9519\u8bef')
        statusEl.className = 'im-scan-status im-scan-status--error'
      }
      return
    }

    if (result.status === 'expired') {
      cancelWeixinScan()
      _weixinScanSessionId = null
      if (statusEl) {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '\u4f1a\u8bdd\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u626b\u7801'
        statusEl.className = 'im-scan-status im-scan-status--error'
      }
      return
    }

    if (statusEl && result.status === 'scanning') {
      statusEl.removeAttribute('hidden')
      statusEl.textContent = '\u5df2\u626b\u7801\uff0c\u8bf7\u5728\u5fae\u4fe1\u4e2d\u786e\u8ba4\u767b\u5f55...'
      statusEl.className = 'im-scan-status im-scan-status--waiting'
    }
  } catch (e) {
    // keep polling
  }
}

function cancelWeixinScan() {
  if (_weixinScanPollTimer) {
    clearInterval(_weixinScanPollTimer)
    _weixinScanPollTimer = null
  }
  _weixinLastPollQr = ''
  _weixinScanSessionId = null
}

function closeWeixinScanModal(contentEl) {
  const modal = contentEl?.querySelector('#weixin-scan-modal')
  if (modal) modal.setAttribute('hidden', '')
}

function updateRightPanel(name, label, icon, status) {
  cancelFeishuScan()
  cancelWeixinScan()
  _weixinScanSessionId = null
  closeFeishuScanModal(document.getElementById('channels-content'))
  closeWeixinScanModal(document.getElementById('channels-content'))

  const main = document.getElementById('im-main-panel')
  if (!main) return
  const running = status?.running || false
  main.querySelector('.im-title-bar strong').textContent = label + '\u8bbe\u7f6e'
  main.querySelector('.im-title-icon').innerHTML = icon
  const st = main.querySelector('.im-title-status')
  st.textContent = running ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5'
  st.classList.toggle('im-title-status--off', !running)
  main.querySelector('#im-config-form').dataset.channel = name

  const feishuBtn = main.querySelector('#feishu-scan-btn')
  if (feishuBtn) feishuBtn.style.display = name === 'feishu' ? '' : 'none'
  const weixinBtn = main.querySelector('#weixin-scan-btn')
  if (weixinBtn) weixinBtn.style.display = name === 'weixin' ? '' : 'none'

  const tipsEl = main.querySelector('.im-tips')
  if (tipsEl) {
    tipsEl.innerHTML = CHANNEL_TIPS[name] || CHANNEL_TIPS.default
  }

  syncImCredentialUi(name)
  main.querySelector('#im-app-id').value = ''
  main.querySelector('#im-app-secret').value = ''
  loadChannelConfig(name)
  void refreshFeishuInboundChatIdUi(name)
  void refreshFeishuBindingsUi(name)
}

async function loadChannelConfig(name) {
  const main = document.getElementById('im-main-panel')
  if (!main) return
  try {
    const configData = await api.getChannelConfig(name)
    const config = configData.config || {}
    const idInput = main.querySelector('#im-app-id')
    const secInput = main.querySelector('#im-app-secret')
    if (name === 'weixin') {
      if (idInput) idInput.value = config.account_id || ''
      if (secInput) secInput.value = config.token || ''
    } else {
      if (idInput) idInput.value = config.app_id || ''
      if (secInput) secInput.value = config.app_secret || ''
    }
  } catch (e) {
    // silent
  }
}

function bindEvents(page) {
  const btn = page.querySelector('#btn-reload')
  if (btn) btn.onclick = () => loadChannels(page)
}
