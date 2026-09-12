/**
 * 智能体员工 · 飞书扫码绑定（复用设置页同款 begin→poll→apply 流程）
 * apply 写入岗位合同，而非全局 channels.feishu 主凭证。
 *
 * 多岗位协作模型：每个员工各自专属飞书机器人；把机器人拉进同一群，同事 @ 对应岗位即可。
 * 个人助理（全局主机器人）≠ 已上架智能体。
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { ensureQrImgFallbackHandler, qrImageHtml } from './qr-image.js'

let _pollTimer = null
let _sessionId = null
let _lastQr = ''
let _activeModal = null
/** @type {{ agentCode: string, opts: Record<string, any> } | null} */
let _activeScanCtx = null

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Read feishu_binding from role.config (single source of truth).
 * Backend always stores binding under config.feishu_binding, never at root level.
 */
export function feishuBindingOf(role) {
  const b = role?.feishu_binding || role?.config?.feishu_binding || {}
  return {
    bound: !!b.bound,
    app_id: String(b.app_id || '').trim(),
    open_id: String(b.open_id || '').trim(),
    bound_at: String(b.bound_at || '').trim(),
  }
}

export function feishuBoundChipHtml(role) {
  const b = feishuBindingOf(role)
  if (b.bound) {
    const tip = b.app_id ? `已绑定飞书机器人 ${b.app_id}` : '已绑定飞书'
    return `<span class="pro-meta-chip pro-meta-chip--feishu" title="${esc(tip)}">飞书已绑</span>`
  }
  return `<span class="pro-meta-chip pro-meta-chip--warn" title="扫码绑定后，飞书里对该机器人的私聊/群聊会路由到本员工">飞书未绑</span>`
}

/** @param {any[]} roles */
export function listUnboundFeishuRoles(roles) {
  const list = Array.isArray(roles) ? roles : []
  return list.filter((r) => {
    const code = String(r?.agent_code || '').trim()
    if (!code) return false
    if (String(r?.status || '').toLowerCase() === 'archived') return false
    return !feishuBindingOf(r).bound
  })
}

/**
 * 自定义上架智能体是否适合「部署并绑飞书」（排除系统/子智能体）。
 * @param {any} agent
 * @param {Set<string>} hiredCodes
 */
export function isFeishuHireablePublishedAgent(agent, hiredCodes) {
  const code = String(agent?.agent_code || '').trim()
  if (!code) return false
  if (hiredCodes instanceof Set && hiredCodes.has(code)) return false
  if (code === 'main' || code === 'xiaomi') return false
  const type = String(agent?.agent_type || '').toLowerCase()
  if (type === 'subagent' || type === 'acp') return false
  return true
}

function ensureModal() {
  let modal = document.getElementById('pro-feishu-scan-modal')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'pro-feishu-scan-modal'
  modal.className = 'im-scan-modal'
  modal.setAttribute('hidden', '')
  modal.innerHTML = `
    <div class="im-scan-overlay" id="pro-feishu-scan-overlay"></div>
    <div class="im-scan-dialog">
      <div class="im-scan-header">
        <strong id="pro-feishu-scan-title">员工飞书扫码绑定</strong>
        <button type="button" class="im-scan-close" id="pro-feishu-scan-close" aria-label="关闭">&times;</button>
      </div>
      <div class="im-scan-body">
        <div id="pro-feishu-scan-qr-wrap" class="im-scan-qr-wrap"><div>加载中...</div></div>
        <p id="pro-feishu-scan-hint" class="im-scan-hint">打开飞书 App 扫描下方二维码</p>
        <div id="pro-feishu-scan-status" class="im-scan-status" hidden></div>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  modal.querySelector('#pro-feishu-scan-close')?.addEventListener('click', () => closeFeishuEmployeeScan())
  modal.querySelector('#pro-feishu-scan-overlay')?.addEventListener('click', () => closeFeishuEmployeeScan())
  return modal
}

function cancelPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _sessionId = null
  _lastQr = ''
}

export function closeFeishuEmployeeScan() {
  cancelPoll()
  const modal = _activeModal || document.getElementById('pro-feishu-scan-modal')
  if (modal) modal.setAttribute('hidden', '')
  _activeModal = null
  _activeScanCtx = null
}

/**
 * 拉群 + 同事怎么用（产品内复用文案）
 */
export const FEISHU_COLLAB_HOWTO_SHORT =
  '管理员：各岗扫码绑定 → 飞书群 ··· → 设置 → 群机器人 → 添加（同一群加齐）。同事只需 @对应岗位 说话。'

export const FEISHU_COLLAB_HOWTO_HTML = `
<ol class="im-bindings-howto-steps">
  <li><strong>你来配</strong>：消息渠道 → 飞书 → 下方名册，给每个岗位「扫码绑定」（或「部署并绑飞书」）。每岗会创建<strong>专属</strong>机器人，App ID 与右上角主机器人不同。</li>
  <li><strong>拉进群</strong>：打开同事所在飞书群 → 右上角 ··· → 设置 → 群机器人 → 添加机器人 → 把刚绑的<strong>岗位机器人</strong>都加进同一个群（不要只加主机器人）。</li>
  <li><strong>同事只会这一句</strong>：在群里 <code>@岗位名 帮我……</code>（跟 @ 真人一样）。可在群公告写：「本群 AI：@研发助理、@运营助手」。</li>
</ol>
<p class="im-bindings-howto-note">右上角扫码 = 个人助理<strong>主机器人</strong>。下方名册扫码 = 各岗位专属机器人。若某岗 App ID 与主机器人相同，说明历史把员工凭证提升成了主连接，请解绑后按名册重绑该岗。</p>
`

/**
 * 绑完后询问是否继续下一个未绑岗位，并提示拉群协作。
 * @param {string} justBoundCode
 * @param {{ onBound?: (result: any) => void, onDone?: () => void }} [opts]
 */
export async function offerBindNextUnboundEmployee(justBoundCode, opts = {}) {
  let roles = []
  try {
    const data = await api.proactiveListRoles()
    roles = Array.isArray(data?.roles) ? data.roles : []
  } catch {
    roles = []
  }
  const unbound = listUnboundFeishuRoles(roles).filter(
    (r) => String(r.agent_code || '').trim() !== String(justBoundCode || '').trim(),
  )
  const pullHint =
    '拉群：飞书群 ··· → 设置 → 群机器人 → 添加「本岗专属机器人」（App ID 见渠道飞书名册，勿只加主机器人）。\n同事：@岗位名 帮我……'
  if (!unbound.length) {
    await showConfirm(
      `该岗位专属机器人已进飞书。\n\n${pullHint}\n\n点确定关闭。`,
    )
    opts.onDone?.()
    return
  }
  const next = unbound[0]
  const nextName = String(next.role_name || next.agent_code || '').trim()
  const go = await showConfirm(
    `已绑定专属机器人。\n\n${pullHint}\n\n还有 ${unbound.length} 个未绑岗位（下一位：「${nextName}」），是否继续扫码？`,
  )
  if (!go) {
    opts.onDone?.()
    return
  }
  void startFeishuEmployeeScan(String(next.agent_code || '').trim(), {
    roleName: nextName,
    onBound: opts.onBound,
    offerNext: true,
  })
}

/**
 * 部署为员工（若尚未雇佣）并扫码绑飞书。
 * @param {string} agentCode
 * @param {{ roleName?: string, onBound?: (result: any) => void, offerNext?: boolean }} [opts]
 */
export async function hireAndBindFeishu(agentCode, opts = {}) {
  const code = String(agentCode || '').trim()
  if (!code) {
    toast('缺少智能体标识', 'error')
    return
  }
  const name = String(opts.roleName || code).trim() || code
  try {
    await api.proactiveCreateRole({
      agent_code: code,
      role_name: name,
      responsibilities: [`在飞书中与同事协作`],
      autonomy_level: 'approval_for_risky',
      heartbeat_schedule: '0 9-19/2 * * *',
      approval_channels: ['desktop', 'feishu'],
      think_mode: 'agent_loop',
      status: 'active',
    })
  } catch (e) {
    const msg = String(e?.message || e || '')
    if (!/already exists|already hired|已存在|已雇佣|409/i.test(msg)) {
      toast('部署失败: ' + msg, 'error')
      return
    }
  }
  return startFeishuEmployeeScan(code, {
    roleName: name,
    onBound: opts.onBound,
    offerNext: opts.offerNext !== false,
  })
}

/**
 * @param {string} agentCode
 * @param {{ roleName?: string, onBound?: (result: any) => void, offerNext?: boolean }} [opts]
 */
export async function startFeishuEmployeeScan(agentCode, opts = {}) {
  const code = String(agentCode || '').trim()
  if (!code) {
    toast('缺少员工标识', 'error')
    return
  }
  const modal = ensureModal()
  _activeModal = modal
  _activeScanCtx = { agentCode: code, opts }
  cancelPoll()
  modal.removeAttribute('hidden')
  const title = modal.querySelector('#pro-feishu-scan-title')
  const hint = modal.querySelector('#pro-feishu-scan-hint')
  const statusEl = modal.querySelector('#pro-feishu-scan-status')
  const qrWrap = modal.querySelector('#pro-feishu-scan-qr-wrap')
  if (title) {
    title.textContent = opts.roleName
      ? `为岗位「${opts.roleName}」创建专属飞书机器人`
      : `为岗位「${code}」创建专属飞书机器人`
  }
  if (hint) hint.textContent = '正在获取二维码...'
  if (statusEl) {
    statusEl.removeAttribute('hidden')
    statusEl.textContent = '正在获取二维码…'
    statusEl.className = 'im-scan-status'
  }
  if (qrWrap) qrWrap.innerHTML = '<div>加载中...</div>'

  try {
    ensureQrImgFallbackHandler()
    const result = await api.beginFeishuRegistration()
    _sessionId = result.session_id
    const qrUrl = result.qr_url
    _lastQr = String(qrUrl || '')
    if (qrWrap && qrUrl) {
      qrWrap.innerHTML = await qrImageHtml(qrUrl, { size: 260, alt: '飞书扫码' })
    } else if (qrWrap) {
      qrWrap.innerHTML = '<p class="im-scan-error">未返回二维码链接</p>'
    }
    if (hint) {
      hint.textContent =
        '打开飞书 App 扫描下方二维码，为该岗位创建专属机器人（不是右上角个人助理主机器人）'
    }
    if (statusEl) {
      statusEl.removeAttribute('hidden')
      statusEl.textContent = '等待扫码…'
      statusEl.className = 'im-scan-status'
    }
    _pollTimer = setInterval(() => void pollFeishuEmployeeScan(code, opts), 2000)
  } catch (e) {
    if (hint) hint.textContent = '获取二维码失败'
    if (qrWrap) qrWrap.innerHTML = `<p class="im-scan-error">错误: ${esc(String(e.message || e))}</p>`
    toast('扫码失败: ' + e, 'error')
  }
}

async function pollFeishuEmployeeScan(agentCode, opts) {
  if (!_sessionId) return
  try {
    const result = await api.pollFeishuRegistration(_sessionId)
    const statusEl = document.getElementById('pro-feishu-scan-status')
    const qrWrap = document.getElementById('pro-feishu-scan-qr-wrap')

    if (result.qr_url && qrWrap && (result.status === 'pending' || result.status === 'scanning')) {
      const u = String(result.qr_url)
      if (u !== _lastQr) {
        _lastQr = u
        ensureQrImgFallbackHandler()
        qrWrap.innerHTML = await qrImageHtml(u, { size: 260, alt: '飞书扫码' })
      }
    }

    if (result.status === 'completed') {
      const sessionId = _sessionId
      cancelPoll()
      if (!sessionId) return
      toast('扫码成功，正在绑定到该员工...', 'success')
      try {
        const applyResult = await api.applyRoleFeishuRegistration(agentCode, sessionId)
        closeFeishuEmployeeScan()
        const appId = String(applyResult?.app_id || applyResult?.binding?.app_id || '').trim()
        const shortId = appId.length > 10 ? `…${appId.slice(-8)}` : appId
        const roleLabel = String(applyResult?.role_name || opts.roleName || agentCode).trim()
        toast(
          applyResult?.channel_running
            ? `「${roleLabel}」专属机器人已绑定${shortId ? `（App ${shortId}）` : ''}，已启动`
            : `「${roleLabel}」专属机器人已绑定${shortId ? `（App ${shortId}）` : ''}；重启 Gateway 后生效`,
          'success',
        )
        // 自我介绍引导：绑定成功即自动发一条自我介绍到扫码人飞书私聊；
        // 拉进群后，第一次 @ 本岗机器人也会自动自我介绍。
        try {
          const intro = `「${roleLabel}」已准备好自我介绍：\n· 扫码人的飞书私聊会收到一条自动自我介绍\n· 拉进群后第一次 @ 它，也会自动自我介绍（身份 + 职责 + 能力 + 示例指令）\n\n同事用一句「@${roleLabel} 帮我……」即可开工。`
          toast(intro, 'success', { duration: 6000 })
        } catch {
          /* ignore */
        }
        try {
          opts.onBound?.(applyResult)
        } catch {
          /* ignore */
        }
        if (opts.offerNext !== false) {
          void offerBindNextUnboundEmployee(agentCode, { onBound: opts.onBound })
        }
      } catch (e) {
        if (statusEl) {
          statusEl.removeAttribute('hidden')
          statusEl.textContent = '保存失败: ' + (e.message || e)
          statusEl.className = 'im-scan-status im-scan-status--error'
        }
        toast('绑定失败: ' + e, 'error')
      }
      return
    }

    if (result.status === 'failed') {
      cancelPoll()
      if (statusEl) {
        statusEl.removeAttribute('hidden')
        statusEl.textContent = '授权失败: ' + (result.error || '未知错误')
        statusEl.className = 'im-scan-status im-scan-status--error'
      }
      return
    }

    if (result.status === 'expired') {
      cancelPoll()
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
  } catch (_) {
    // keep polling
  }
}

/**
 * @param {string} agentCode
 * @param {{ onUnbound?: (result: any) => void }} [opts]
 */
export async function unbindFeishuEmployee(agentCode, opts = {}) {
  const code = String(agentCode || '').trim()
  if (!code) return
  try {
    const result = await api.unbindRoleFeishu(code)
    toast('已解除飞书绑定', 'success')
    opts.onUnbound?.(result)
  } catch (e) {
    toast('解绑失败: ' + e, 'error')
  }
}
