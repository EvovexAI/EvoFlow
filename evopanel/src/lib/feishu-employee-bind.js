/**
 * 智能体员工 · 飞书扫码绑定（兼容层 · legacy API shim）
 *
 * 实际实现已迁移到 :mod:`im-employee-bind.js`。本文件保留所有 legacy API
 * （``feishuBindingOf`` / ``hireAndBindFeishu`` / ``startFeishuEmployeeScan`` /
 * ``unbindFeishuEmployee`` / ``feishuBoundChipHtml`` / ``listUnboundFeishuRoles`` /
 * ``isFeishuHireablePublishedAgent`` / ``FEISHU_COLLAB_HOWTO_*`` 等）作为薄壳
 * 转发给新的 ``im-employee-bind.js``，保证所有现存调用点零改动。
 *
 * 多岗位协作模型：每个员工各自专属飞书机器人；把机器人拉进同一群，同事 @ 对应岗位即可。
 * 个人助理（全局主机器人）≠ 已上架智能体。
 */
import {
  imBindingOf as _feishuBindingOfViaIM,
  imBindingCount as _imBindingCount,
  hireAndBindIMChannel as _hireAndBindIMChannel,
  startIMChannelScan as _startIMChannelScan,
  closeIMChannelScan as _closeIMChannelScan,
  unbindIMChannelForRole as _unbindIMChannelForRole,
  unbindIMChannel as _unbindIMChannel,
  offerBindNextUnboundIMChannel as _offerBindNextUnboundIMChannel,
  IM_CHANNELS,
  IM_CHANNEL_LABELS,
  IM_CHANNEL_ICONS,
} from './im-employee-bind.js'

// Re-export the new channel-generic surface so legacy call-sites that already
// import from this file can keep doing so. Avoids the "does not provide an
// export named 'IM_CHANNELS'" error when callers upgrade in place.
export { IM_CHANNELS, IM_CHANNEL_LABELS, IM_CHANNEL_ICONS }
export {
  _imBindingCount as imBindingCount,
  _hireAndBindIMChannel as hireAndBindIMChannel,
  _startIMChannelScan as startIMChannelScan,
  _unbindIMChannel as unbindIMChannel,
}

/** Convenience wrapper: call site does ``imBindingOf(role, 'feishu')`` etc.
 *  Delegates straight to the cross-platform helper.
 */
export const imBindingOf = (role, channel) => _feishuBindingOfViaIM(role, channel)

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Legacy: keep returning the feishu-bound snapshot.
 *  Reads from role.feishu_binding || role.config.feishu_binding (whichever the
 *  backend populates) so old callers that look up ``role.config.feishu_binding``
 *  keep working.
 */
export function feishuBindingOf(role) {
  const legacy = role?.feishu_binding || role?.config?.feishu_binding || {}
  const bound = !!legacy.bound
  const appId = String(legacy.app_id || '').trim()
  const openId = String(legacy.open_id || '').trim()
  return {
    bound,
    app_id: appId,
    open_id: openId,
    bound_at: String(legacy.bound_at || '').trim(),
  }
}

/** Legacy HTML chip emitter kept for callers still importing this name.
 *  Now channel-aware: shows the bound-channel count instead of a feishu-only
 *  status string, so older call-sites don't lag behind the new "扫码绑定 IM"
 *  wording. New callers should prefer ``im-employee-bind.js#imBindingCount``.
 */
export function feishuBoundChipHtml(role) {
  const legacy = feishuBindingOf(role)
  if (legacy.bound) {
    const tip = legacy.app_id ? `已绑定飞书机器人 ${legacy.app_id}` : '已绑定飞书'
    return `<span class="pro-meta-chip pro-meta-chip--feishu" title="${esc(tip)}">IM 已绑</span>`
  }
  return `<span class="pro-meta-chip pro-meta-chip--warn" title="扫码绑定 IM（飞书 / 企业微信 / 钉钉）后，群里对该机器人的 @ 会路由到本员工">IM 未绑</span>`
}

/** Legacy list-filter helper kept for callers still importing this name. */
export function listUnboundFeishuRoles(roles) {
  const list = Array.isArray(roles) ? roles : []
  return list.filter((r) => !feishuBindingOf(r).bound)
}

/** Legacy hire-and-bind eligibility predicate. */
export function isFeishuHireablePublishedAgent(agent, hiredCodes) {
  const code = String(agent?.agent_code || '').trim()
  if (!code) return false
  if (hiredCodes instanceof Set && hiredCodes.has(code)) return false
  if (code === 'main' || code === 'xiaomi') return false
  const type = String(agent?.agent_type || '').toLowerCase()
  if (type === 'subagent' || type === 'acp') return false
  return true
}

/** Legacy: close scan modal. Delegates to the new generic helper. */
export function closeFeishuEmployeeScan() {
  return _closeIMChannelScan()
}

/** Legacy "拉群+同事怎么用" short text kept for callers still importing this name. */
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

/** Legacy: hire + bind. Delegates to the new generic helper. */
export async function hireAndBindFeishu(agentCode, opts = {}) {
  return _hireAndBindIMChannel({
    channel: 'feishu',
    agentCode,
    roleName: opts.roleName,
    onBound: opts.onBound,
    offerNext: opts.offerNext,
  })
}

/** Legacy: open scan modal. Delegates to the new generic helper. */
export async function startFeishuEmployeeScan(agentCode, opts = {}) {
  return _startIMChannelScan({
    channel: 'feishu',
    agentCode,
    roleName: opts.roleName,
    onBound: opts.onBound,
    offerNext: opts.offerNext,
  })
}

/** Legacy: offer-next-unbound-employee chain. Delegates. */
export function offerBindNextUnboundEmployee(justBoundCode, opts = {}) {
  return _offerBindNextUnboundIMChannel('feishu', justBoundCode, opts)
}

/** Legacy: unbind. Delegates. */
export async function unbindFeishuEmployee(agentCode, opts = {}) {
  return _unbindIMChannelForRole('feishu', agentCode, opts)
}
