/**
 * Smart-employee IM channel binding (Feishu / WeCom / Dingtalk / Weixin iLink).
 *
 * Cross-platform descendant of ``feishu-employee-bind.js`` (which still exists
 * and re-exports the legacy API as thin shims). The new public surface is
 * generic so the panel can call it with a ``channel`` argument without
 * duplicating glue per platform.
 *
 * Backend wiring (mirrors the Feishu set):
 *   POST   /api/channels/<channel>/registration/begin          (start QR)
 *   GET    /api/channels/<channel>/registration/<sid>/poll     (poll status)
 *   POST   /api/proactive/roles/<code>/<channel>/registration/<sid>/apply
 *                                                           (bind to employee)
 *   DELETE /api/proactive/roles/<code>/<channel>/binding      (unbind)
 *   GET    /api/proactive/roles/<code>/<channel>/binding      (status)
 *
 * Invariants locked down here:
 *   - ``channel`` ∈ {'feishu' | 'wecom' | 'dingtalk' | 'weixin'} (case-insensitive).
 *     Unknown channels throw.
 *   - The scan modal is single-instance per (channel, agentCode); starting a new
 *     scan cancels any prior poll and resets state so re-binding works cleanly.
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { ensureQrImgFallbackHandler, qrImageHtml } from './qr-image.js'

const KNOWN_CHANNELS = /** @type {const} */ (['feishu', 'wecom', 'dingtalk', 'weixin'])

const CHANNEL_LABELS = {
  feishu: '飞书',
  wecom: '企业微信',
  dingtalk: '钉钉',
  weixin: '微信公众号 (iLink)',
}

const CHANNEL_ICONS = {
  feishu: '💬',
  wecom: '💼',
  dingtalk: '🔔',
  weixin: '📱',
}

/** Per-channel overview text shown under the chip while scanning. */
const CHANNEL_HOWTO = {
  feishu:
    '打开飞书 App 扫描下方二维码，为该岗位创建专属机器人（不是右上角个人助理主机器人）',
  wecom:
    '用企业微信 App 扫描下方二维码，为该岗位创建一个专属 AI 机器人（每个员工一个机器人）',
  dingtalk: '用钉钉 App 扫描下方二维码，为该岗位创建一个专属机器人',
  weixin: '打开微信扫一扫下方二维码，为该岗位创建一个客服账号',
}

const CHANNEL_BIND_NEXT_HINT = {
  feishu:
    '拉群：飞书群 ··· → 设置 → 群机器人 → 添加「本岗专属机器人」（App ID 见渠道飞书名册，勿只加主机器人）。\n同事：@岗位名 帮我……',
  wecom:
    '拉群：企业微信群 ··· → 群机器人 → 添加本岗专属机器人（bot_id 后 4 位见员工详情）。\n同事：在群里 @本岗机器人 即可对话。',
  dingtalk:
    '拉群：钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 选择本岗专属机器人。\n同事：在群里 @本岗机器人 即可对话。',
  weixin:
    '微信公众号不支持群 @；员工详情里能拿到客服链接 / 关注二维码，分发给同事直接对话。',
}

let _pollTimer = null
let _sessionId = null
let _lastQr = ''
let _activeModal = null
let _activeChannel = null
let _activeScanCtx = null

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function _isKnownChannel(channel) {
  return KNOWN_CHANNELS.includes(String(channel || '').toLowerCase())
}

/**
 * Read binding snapshot from role.config for one channel.
 * Returns ``{ bound: boolean, ...display fields }`` (never includes secrets).
 *
 * Channel-specific shape:
 *   feishu: { bound, app_id_suffix, bound_at, intro_sent_at }
 *   wecom:  { bound, bot_id_suffix, bound_at, intro_sent_at }
 *   dingtalk: { bound, client_id_suffix, bound_at, intro_sent_at }
 *   weixin: { bound, account_id, bound_at, intro_sent_at }
 */
export function imBindingOf(role, channel) {
  const ch = String(channel || '').toLowerCase()
  const cfg = role?.config || role || {}
  if (ch === 'feishu') {
    const b = cfg.feishu_binding || {}
    const appId = String(b.app_id || '').trim()
    return {
      bound: !!b.bound,
      app_id_suffix: appId ? `…${appId.slice(-4)}` : '',
      bound_at: String(b.bound_at || '').trim(),
      intro_sent_at: String(b.intro_sent_at || '').trim(),
    }
  }
  if (ch === 'wecom') {
    const botId = String(cfg.wecom_bot_id || '').trim()
    const secret = String(cfg.wecom_secret || '').trim()
    const bound = Boolean(botId && secret)
    return {
      bound,
      bot_id_suffix: bound ? `…${botId.slice(-4)}` : '',
      bound_at: String(cfg.wecom_bound_at || '').trim(),
      intro_sent_at: String(cfg.wecom_intro_sent_at || '').trim(),
    }
  }
  if (ch === 'dingtalk') {
    const cid = String(cfg.dingtalk_client_id || '').trim()
    const sec = String(cfg.dingtalk_client_secret || '').trim()
    const bound = Boolean(cid && sec)
    return {
      bound,
      client_id_suffix: bound ? `…${cid.slice(-4)}` : '',
      bound_at: String(cfg.dingtalk_bound_at || '').trim(),
      intro_sent_at: String(cfg.dingtalk_intro_sent_at || '').trim(),
    }
  }
  if (ch === 'weixin') {
    const aid = String(cfg.weixin_account_id || '').trim()
    return {
      bound: !!aid,
      account_id: aid,
      bound_at: String(cfg.weixin_bound_at || '').trim(),
      intro_sent_at: String(cfg.weixin_intro_sent_at || '').trim(),
    }
  }
  return { bound: false }
}

/**
 * UI helper: how many distinct channels is the role currently bound to.
 * Used by the card button label "已绑 IM（N）".
 */
export function imBindingCount(role) {
  if (!role) return 0
  return KNOWN_CHANNELS.filter((ch) => imBindingOf(role, ch).bound).length
}

function ensureModal(channel) {
  const id = 'pro-im-scan-modal'
  let modal = document.getElementById(id)
  if (modal) {
    modal.dataset.channel = channel
    return modal
  }
  modal = document.createElement('div')
  modal.id = id
  modal.className = 'im-scan-modal'
  modal.dataset.channel = channel
  modal.setAttribute('hidden', '')
  modal.innerHTML = `
    <div class="im-scan-overlay" id="pro-im-scan-overlay"></div>
    <div class="im-scan-dialog">
      <div class="im-scan-header">
        <strong id="pro-im-scan-title">扫码绑定 IM</strong>
        <span id="pro-im-scan-channel-tag" class="im-scan-channel-tag"></span>
        <button type="button" class="im-scan-close" id="pro-im-scan-close" aria-label="关闭">&times;</button>
      </div>
      <div class="im-scan-body">
        <div id="pro-im-scan-qr-wrap" class="im-scan-qr-wrap"><div>加载中...</div></div>
        <p id="pro-im-scan-hint" class="im-scan-hint">打开对应 App 扫描下方二维码</p>
        <div id="pro-im-scan-status" class="im-scan-status" hidden></div>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  modal.querySelector('#pro-im-scan-close')?.addEventListener('click', () =>
    closeIMChannelScan(),
  )
  modal.querySelector('#pro-im-scan-overlay')?.addEventListener('click', () =>
    closeIMChannelScan(),
  )
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

export function closeIMChannelScan() {
  cancelPoll()
  const modal = _activeModal || document.getElementById('pro-im-scan-modal')
  if (modal) modal.setAttribute('hidden', '')
  _activeModal = null
  _activeChannel = null
  _activeScanCtx = null
}

function _beginRegistrationApi(channel) {
  const c = String(channel || '').toLowerCase()
  if (c === 'feishu') return () => api.beginFeishuRegistration()
  if (c === 'wecom') return () => api.beginWecomRegistration()
  if (c === 'dingtalk') return () => api.beginDingtalkRegistration()
  if (c === 'weixin') return () => api.beginWeixinRegistration()
  throw new Error(`Unknown channel: ${channel}`)
}

function _pollRegistrationApi(channel) {
  const c = String(channel || '').toLowerCase()
  if (c === 'feishu') return (sid) => api.pollFeishuRegistration(sid)
  if (c === 'wecom') return (sid) => api.pollWecomRegistration(sid)
  if (c === 'dingtalk') return (sid) => api.pollDingtalkRegistration(sid)
  if (c === 'weixin') return (sid) => api.pollWeixinRegistration(sid)
  throw new Error(`Unknown channel: ${channel}`)
}

function _applyRoleRegistrationApi(channel) {
  const c = String(channel || '').toLowerCase()
  if (c === 'feishu') return (code, sid) => api.applyRoleFeishuRegistration(code, sid)
  if (c === 'wecom') return (code, sid) => api.applyRoleWecomRegistration(code, sid)
  if (c === 'dingtalk') return (code, sid) => api.applyRoleDingtalkRegistration(code, sid)
  if (c === 'weixin') return (code, sid) => api.applyRoleWeixinRegistration(code, sid)
  throw new Error(`Unknown channel: ${channel}`)
}

/**
 * Hire the agent (if not yet hired) and start an IM-channel scan for it.
 *
 * @param {object} args
 * @param {'feishu'|'wecom'|'dingtalk'|'weixin'} args.channel
 * @param {string} args.agentCode
 * @param {string} [args.roleName]
 * @param {(result: any) => void} [args.onBound]
 * @param {boolean} [args.offerNext] default true
 */
export async function hireAndBindIMChannel({
  channel,
  agentCode,
  roleName,
  onBound,
  offerNext = true,
}) {
  if (!_isKnownChannel(channel)) {
    toast(`暂不支持渠道 ${channel}`, 'error')
    return
  }
  const code = String(agentCode || '').trim()
  if (!code) {
    toast('缺少智能体标识', 'error')
    return
  }
  const name = String(roleName || code).trim() || code
  try {
    await api.proactiveCreateRole({
      agent_code: code,
      role_name: name,
      responsibilities: [`在 ${CHANNEL_LABELS[channel.toLowerCase()]} 中与同事协作`],
      autonomy_level: 'approval_for_risky',
      heartbeat_schedule: '0 9-19/2 * * *',
      approval_channels: ['desktop', channel.toLowerCase()],
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
  return startIMChannelScan({ channel, agentCode: code, roleName: name, onBound, offerNext })
}

/**
 * Open the scan modal for the given channel + employee.
 *
 * @param {object} args
 * @param {'feishu'|'wecom'|'dingtalk'|'weixin'} args.channel
 * @param {string} args.agentCode
 * @param {string} [args.roleName]
 * @param {(result: any) => void} [args.onBound]
 * @param {boolean} [args.offerNext] default true
 */
export async function startIMChannelScan({
  channel,
  agentCode,
  roleName,
  onBound,
  offerNext = true,
} = {}) {
  if (!_isKnownChannel(channel)) {
    toast(`暂不支持渠道 ${channel}`, 'error')
    return
  }
  const ch = channel.toLowerCase()
  const code = String(agentCode || '').trim()
  if (!code) {
    toast('缺少员工标识', 'error')
    return
  }
  const modal = ensureModal(ch)
  _activeModal = modal
  _activeChannel = ch
  _activeScanCtx = { agentCode: code, channel: ch, onBound, offerNext, roleName }
  cancelPoll()
  modal.removeAttribute('hidden')

  const title = modal.querySelector('#pro-im-scan-title')
  const hint = modal.querySelector('#pro-im-scan-hint')
  const statusEl = modal.querySelector('#pro-im-scan-status')
  const qrWrap = modal.querySelector('#pro-im-scan-qr-wrap')
  const tagEl = modal.querySelector('#pro-im-scan-channel-tag')
  const label = CHANNEL_LABELS[ch] || ch
  const icon = CHANNEL_ICONS[ch] || '💬'

  if (title) {
    title.textContent = roleName
      ? `为岗位「${roleName}」创建专属${label}机器人`
      : `为岗位「${code}」创建专属${label}机器人`
  }
  if (tagEl) {
    tagEl.textContent = `${icon} ${label}`
    tagEl.dataset.channel = ch
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
    const begin = _beginRegistrationApi(ch)
    const result = await begin()
    _sessionId = result.session_id
    const qrUrl = result.qr_url
    _lastQr = String(qrUrl || '')
    if (qrWrap && qrUrl) {
      qrWrap.innerHTML = await qrImageHtml(qrUrl, { size: 260, alt: `${label}扫码` })
    } else if (qrWrap) {
      qrWrap.innerHTML = '<p class="im-scan-error">未返回二维码链接</p>'
    }
    if (hint) hint.textContent = CHANNEL_HOWTO[ch] || '扫描二维码完成绑定'
    if (statusEl) {
      statusEl.removeAttribute('hidden')
      statusEl.textContent = '等待扫码…'
      statusEl.className = 'im-scan-status'
    }
    _pollTimer = setInterval(
      () => void _pollIMChannelScan({ agentCode: code, channel: ch, onBound, offerNext, roleName }),
      2000,
    )
  } catch (e) {
    if (hint) hint.textContent = '获取二维码失败'
    if (qrWrap) qrWrap.innerHTML = `<p class="im-scan-error">错误: ${esc(String(e.message || e))}</p>`
    toast('扫码失败: ' + e, 'error')
  }
}

async function _pollIMChannelScan({ agentCode, channel, onBound, offerNext, roleName }) {
  if (!_sessionId) return
  try {
    const poll = _pollRegistrationApi(channel)
    const result = await poll(_sessionId)
    const statusEl = document.getElementById('pro-im-scan-status')
    const qrWrap = document.getElementById('pro-im-scan-qr-wrap')

    if (result.qr_url && qrWrap && (result.status === 'pending' || result.status === 'scanning')) {
      const u = String(result.qr_url)
      if (u !== _lastQr) {
        _lastQr = u
        ensureQrImgFallbackHandler()
        const label = CHANNEL_LABELS[channel] || channel
        qrWrap.innerHTML = await qrImageHtml(u, { size: 260, alt: `${label}扫码` })
      }
    }

    if (result.status === 'completed') {
      const sessionId = _sessionId
      cancelPoll()
      if (!sessionId) return
      toast('扫码成功，正在绑定到该员工...', 'success')
      try {
        const apply = _applyRoleRegistrationApi(channel)
        const applyResult = await apply(agentCode, sessionId)
        closeIMChannelScan()
        const roleLabel = String(applyResult?.role_name || roleName || agentCode).trim()
        const idTail = channel === 'feishu'
          ? applyResult?.app_id?.slice?.(-8) || ''
          : applyResult?.bot_id?.slice?.(-4) || ''
        const idText = idTail ? `${channel === 'feishu' ? '（App …' + idTail + '）' : '（…' + idTail + '）'}` : ''
        toast(
          applyResult?.channel_running
            ? `「${roleLabel}」专属机器人已绑定${idText}，已启动`
            : `「${roleLabel}」专属机器人已绑定${idText}；重启 Gateway 后生效`,
          'success',
        )
        if (channel === 'feishu') {
          try {
            const intro =
              `「${roleLabel}」已准备好自我介绍：\n· 扫码人的飞书私聊会收到一条自动自我介绍\n· 拉进群后第一次 @ 它，也会自动自我介绍（身份 + 职责 + 能力 + 示例指令）\n\n同事用一句「@${roleLabel} 帮我……」即可开工。`
            toast(intro, 'success', { duration: 6000 })
          } catch {
            /* ignore */
          }
        }
        try {
          onBound?.(applyResult)
        } catch {
          /* ignore */
        }
        if (offerNext) {
          void offerBindNextUnboundIMChannel(channel, agentCode, { onBound })
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
        statusEl.textContent = '已扫码，请在对应 App 中确认授权…'
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
 * After a successful bind, offer to continue with the next unbound employee
 * (skipping the one just bound). Used by the panel to walk new admins through
 * the per-employee binding loop one channel at a time.
 */
export async function offerBindNextUnboundIMChannel(channel, justBoundCode, opts = {}) {
  if (!_isKnownChannel(channel)) return
  const ch = channel.toLowerCase()
  let roles = []
  try {
    const data = await api.proactiveListRoles()
    roles = Array.isArray(data?.roles) ? data.roles : []
  } catch {
    roles = []
  }
  const unbound = roles.filter((r) => {
    const code = String(r?.agent_code || '').trim()
    if (!code) return false
    if (String(r?.status || '').toLowerCase() === 'archived') return false
    if (code === String(justBoundCode || '').trim()) return false
    return !imBindingOf(r, ch).bound
  })
  const pullHint = CHANNEL_BIND_NEXT_HINT[ch] || ''
  if (!unbound.length) {
    await showConfirm(`该岗位专属机器人已绑定。\n\n${pullHint}\n\n点确定关闭。`)
    opts.onDone?.()
    return
  }
  const next = unbound[0]
  const nextName = String(next.role_name || next.agent_code || '').trim()
  const label = CHANNEL_LABELS[ch] || ch
  const go = await showConfirm(
    `已绑定专属机器人。\n\n${pullHint}\n\n还有 ${unbound.length} 个未绑岗位（下一位：「${nextName}」），是否继续扫码？`,
  )
  if (!go) {
    opts.onDone?.()
    return
  }
  void startIMChannelScan({
    channel: ch,
    agentCode: String(next.agent_code || '').trim(),
    roleName: nextName,
    onBound: opts.onBound,
    offerNext: true,
  })
}

/**
 * @param {string} channel
 * @param {string} agentCode
 * @param {{ onUnbound?: (result: any) => void }} [opts]
 */
export async function unbindIMChannel(channel, agentCode, opts = {}) {
  const ch = String(channel || '').toLowerCase()
  const code = String(agentCode || '').trim()
  if (!_isKnownChannel(ch)) {
    toast(`暂不支持渠道 ${channel}`, 'error')
    return
  }
  if (!code) return
  try {
    let result
    if (ch === 'feishu') result = await api.unbindRoleFeishu(code)
    else if (ch === 'wecom') result = await api.unbindRoleWecom(code)
    else if (ch === 'dingtalk') result = await api.unbindRoleDingtalk(code)
    else if (ch === 'weixin') result = await api.unbindRoleWeixin(code)
    const label = CHANNEL_LABELS[ch] || ch
    toast(`已解除${label}绑定`, 'success')
    opts.onUnbound?.(result)
  } catch (e) {
    toast('解绑失败: ' + e, 'error')
  }
}

/**
 * Cross-channel apply helper for one employee. Wraps channel-specific
 * ``unbindIMChannel`` callers in a single API for the detail-pane "解绑" button.
 */
export async function unbindIMChannelForRole(channel, agentCode) {
  return unbindIMChannel(channel, agentCode, {})
}

export const IM_CHANNELS = KNOWN_CHANNELS.slice()
export const IM_CHANNEL_LABELS = { ...CHANNEL_LABELS }
export const IM_CHANNEL_ICONS = { ...CHANNEL_ICONS }
