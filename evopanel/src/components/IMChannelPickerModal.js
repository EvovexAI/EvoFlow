/**
 * Channel picker modal for employee IM binding.
 *
 * Pure DOM modal (no framework). Surfaces 4 chips — 飞书 / 企业微信 / 钉钉 /
 * 微信公众号 — with a "this employee already bound X" affordance and a
 * "coming soon" toast for channels whose backend glue is not yet wired.
 *
 * Returns the chosen channel id ('feishu' | 'wecom' | 'dingtalk' | 'weixin')
 * via a Promise, or ``null`` on cancel.
 */
import { IM_CHANNELS, IM_CHANNEL_LABELS, IM_CHANNEL_ICONS } from '../lib/im-employee-bind.js'
import { imBindingOf } from '../lib/im-employee-bind.js'
import { toast } from './toast.js'

/** Channels whose apply-to-role backend is implemented in this PR. */
const ENABLED_CHANNELS = new Set(['feishu', 'wecom'])

/** Per-channel one-liner used as the chip description. */
const CHANNEL_BLURBS = {
  feishu: '飞书 App 扫码，给该员工建专属机器人',
  wecom: '企业微信 App 扫码，给该员工建专属 AI 机器人',
  dingtalk: '钉钉 App 扫码，给该员工建专属机器人',
  weixin: '微信扫一扫，给该员工建一个客服账号（不支持群 @）',
}

let _modalEl = null
let _resolve = null

function ensureModal() {
  if (_modalEl && _modalEl.isConnected) return _modalEl
  const root = document.createElement('div')
  root.id = 'im-channel-picker-modal'
  // Reuse the existing `im-scan-modal` layout + dialog CSS so the picker
  // matches the QR scan modal's visual contract (centered dialog, dimmed
  // page overlay, header / body / footer slots). The picker-specific tweaks
  // for the chip grid live in `pages.css` under `.im-channel-picker`.
  root.className = 'im-scan-modal im-channel-picker'
  root.setAttribute('hidden', '')
  root.innerHTML = `
    <div class="im-scan-overlay" data-picker-overlay></div>
    <div class="im-scan-dialog im-channel-picker__dialog" role="dialog" aria-modal="true" aria-label="选择扫码绑定的 IM 渠道">
      <div class="im-scan-header">
        <strong id="im-channel-picker-title">扫码绑定 IM</strong>
        <button type="button" class="im-scan-close" data-picker-close aria-label="关闭">&times;</button>
      </div>
      <div class="im-scan-body">
        <p id="im-channel-picker-hint" class="im-channel-picker__hint">为该员工选择一个 IM 渠道进行扫码绑定</p>
        <div class="im-channel-picker__chips" data-picker-chips></div>
        <p class="im-channel-picker__note">每个员工一个机器人；不同的渠道互不影响。一岗一机器人。</p>
      </div>
      <div class="im-channel-picker__footer">
        <button type="button" class="btn btn-secondary" data-picker-close>取消</button>
      </div>
    </div>
  `
  document.body.appendChild(root)
  root.querySelectorAll('[data-picker-close]').forEach((el) =>
    el.addEventListener('click', () => _dismiss(null)),
  )
  root.querySelector('[data-picker-overlay]').addEventListener('click', () => _dismiss(null))
  _modalEl = root
  return root
}

function _dismiss(value) {
  if (!_modalEl) return
  _modalEl.setAttribute('hidden', '')
  if (_resolve) {
    const r = _resolve
    _resolve = null
    r(value)
  }
}

function _renderChips(host, { roleName, currentBindings }) {
  host.innerHTML = ''
  for (const ch of IM_CHANNELS) {
    const bound = currentBindings ? imBindingOf(currentBindings, ch).bound : false
    const enabled = ENABLED_CHANNELS.has(ch)
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'im-channel-picker__chip'
    chip.dataset.channel = ch
    chip.disabled = !enabled
    if (!enabled) chip.classList.add('im-channel-picker__chip--disabled')
    if (bound) chip.classList.add('im-channel-picker__chip--bound')
    chip.setAttribute(
      'title',
      bound
        ? `该员工已绑${IM_CHANNEL_LABELS[ch]}；可再绑其他渠道`
        : CHANNEL_BLURBS[ch] || `扫码绑定${IM_CHANNEL_LABELS[ch]}`,
    )
    chip.innerHTML = `
      <span class="im-channel-picker__chip-icon" aria-hidden="true">${IM_CHANNEL_ICONS[ch] || '💬'}</span>
      <span class="im-channel-picker__chip-label">${IM_CHANNEL_LABELS[ch] || ch}</span>
      <span class="im-channel-picker__chip-state">${
        bound ? '已绑' : enabled ? '可扫码' : '即将开放'
      }</span>
    `
    chip.addEventListener('click', () => {
      if (!enabled) {
        toast(`「${IM_CHANNEL_LABELS[ch]}」扫码绑员工功能即将上线；当前仅飞书 / 企业微信可用`, 'info')
        return
      }
      _dismiss(ch)
    })
    host.appendChild(chip)
  }
}

/**
 * Open the picker. Resolves with the chosen channel id or null if cancelled.
 *
 * @param {{ roleName?: string, currentBindings?: any }} [opts]
 * @returns {Promise<'feishu'|'wecom'|'dingtalk'|'weixin'|null>}
 */
export function showIMChannelPicker(opts = {}) {
  const modal = ensureModal()
  const titleEl = modal.querySelector('#im-channel-picker-title')
  const hintEl = modal.querySelector('#im-channel-picker-hint')
  const chipsHost = modal.querySelector('[data-picker-chips]')
  const name = String(opts.roleName || '该员工').trim() || '该员工'
  if (titleEl) titleEl.textContent = `为「${name}」选择 IM 渠道`
  if (hintEl) hintEl.textContent = `选一个 IM 渠道扫码绑定 · 当前 ${name} 已绑的渠道会标「已绑」`
  _renderChips(chipsHost, { roleName: name, currentBindings: opts.currentBindings })
  modal.removeAttribute('hidden')
  return new Promise((resolve) => {
    _resolve = resolve
  })
}
