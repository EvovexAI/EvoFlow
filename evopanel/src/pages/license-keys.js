/**
 * 激活码管理（运维台账）
 * 签发 / 列表 / 作废 — 对接 Gateway /api/license/codes*
 */
import '../style/license-keys.css'
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'

const esc = (s) =>
  !s
    ? ''
    : String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

/** @type {HTMLElement | null} */
let _pageEl = null
/** @type {any[]} */
let _items = []
/** @type {Record<string, number>} */
let _stats = { total: 0, active: 0, expired: 0, revoked: 0, expiring_soon: 0 }
let _canIssue = false
let _localMid = ''
let _q = ''
let _status = ''
/** @type {Set<string>} */
const _revealed = new Set()

function q(sel) {
  return _pageEl ? _pageEl.querySelector(sel) : null
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return String(iso)
  }
}

function maskCode(code) {
  const s = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (s.length <= 10) return s || '—'
  return `${s.slice(0, 3)}-****…${s.slice(-4)}`
}

function statusBadge(st) {
  const s = String(st || 'active')
  const map = {
    active: { text: '有效', cls: 'lk-badge--ok' },
    expired: { text: '已过期', cls: 'lk-badge--warn' },
    revoked: { text: '已作废', cls: 'lk-badge--muted' },
  }
  const m = map[s] || map.active
  return `<span class="lk-badge ${m.cls}">${m.text}</span>`
}

function bindLabel(row) {
  const mid = String(row?.machine_id || '').trim()
  if (!mid) return '<span class="lk-muted">浮动（首次激活绑定）</span>'
  return `<code class="lk-mono" title="${esc(mid)}">${esc(mid.slice(0, 8))}…</code>`
}

async function loadMeta() {
  try {
    const meta = await api.licenseCodesMeta()
    _canIssue = Boolean(meta?.can_issue)
    _localMid = String(meta?.machine_id || '')
  } catch {
    _canIssue = false
    _localMid = ''
  }
}

async function loadList() {
  /** @type {Record<string, string>} */
  const params = {}
  if (_q) params.q = _q
  if (_status) params.status = _status
  const data = await api.licenseCodesList(Object.keys(params).length ? params : null)
  _items = Array.isArray(data?.items) ? data.items : []
  _stats = {
    total: Number(data?.stats?.total || 0),
    active: Number(data?.stats?.active || 0),
    expired: Number(data?.stats?.expired || 0),
    revoked: Number(data?.stats?.revoked || 0),
    expiring_soon: Number(data?.stats?.expiring_soon || 0),
  }
}

function renderStats() {
  const s = _stats
  const pills = [
    { key: '', label: '全部', value: s.total },
    { key: 'active', label: '有效', value: s.active },
    { key: 'expiring_soon', label: '将到期', value: s.expiring_soon },
    { key: 'expired', label: '已过期', value: s.expired },
    { key: 'revoked', label: '已作废', value: s.revoked },
  ]
  return `
    <div class="lk-stat-strip" role="tablist">
      ${pills
        .map(
          (p) => `
        <button type="button" class="lk-stat ${ _status === p.key ? 'is-active' : '' }" data-act="filter-status" data-status="${esc(p.key)}">
          <span class="lk-stat__label">${esc(p.label)}</span>
          <span class="lk-stat__value">${p.value}</span>
        </button>`
        )
        .join('')}
    </div>`
}

function renderRows() {
  if (!_items.length) {
    return `<tr><td colspan="7" class="lk-empty">暂无签发记录。点击「签发激活码」创建第一条。</td></tr>`
  }
  return _items
    .map((row) => {
      const id = String(row.id || '')
      const code = String(row.code || '')
      const revealed = _revealed.has(id)
      const codeHtml = revealed
        ? `<code class="lk-code-full">${esc(code)}</code>`
        : `<code class="lk-code-mask">${esc(maskCode(code))}</code>`
      const days =
        typeof row.days_remaining === 'number' && row.status === 'active'
          ? `<span class="lk-muted"> · 剩 ${row.days_remaining} 天</span>`
          : ''
      const canRevoke = row.status === 'active'
      return `
        <tr data-id="${esc(id)}">
          <td>
            <div class="lk-to">${esc(row.issued_to || '—')}</div>
            ${row.note ? `<div class="lk-note">${esc(row.note)}</div>` : ''}
          </td>
          <td>
            <div class="lk-code-cell">${codeHtml}</div>
            <div class="lk-code-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-act="toggle-code" data-id="${esc(id)}">${revealed ? '隐藏' : '显示'}</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="copy-code" data-id="${esc(id)}">复制</button>
            </div>
          </td>
          <td>${bindLabel(row)}</td>
          <td>${esc(fmtDate(row.issued_at))}</td>
          <td>${esc(fmtDate(row.expires_at))}${days}</td>
          <td>${statusBadge(row.status)}</td>
          <td class="lk-ops">
            ${
              canRevoke
                ? `<button type="button" class="btn btn-ghost btn-sm" data-act="revoke" data-id="${esc(id)}">作废</button>`
                : '<span class="lk-muted">—</span>'
            }
          </td>
        </tr>`
    })
    .join('')
}

function shellHtml() {
  return `
    <div class="page license-keys-page">
      <header class="lk-topbar">
        <div>
          <h1 class="lk-title">激活码管理</h1>
          <p class="lk-subtitle">签发短码、查看发给谁 / 到期 / 绑定信息（本机台账）</p>
        </div>
        <div class="lk-topbar-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="refresh">刷新</button>
          <button type="button" class="btn btn-primary" data-act="open-issue" ${_canIssue ? '' : 'disabled title="未配置签发私钥"'}>签发激活码</button>
        </div>
      </header>

      ${
        _canIssue
          ? ''
          : `<div class="lk-banner lk-banner--warn">当前无法签发：未找到私钥。请设置 <code>EVOFLOW_LICENSE_PRIVATE_KEY</code>，或放置 <code>backend/.evoflow-license-private.key</code> 后重启 Gateway。</div>`
      }

      ${renderStats()}

      <div class="lk-toolbar">
        <input type="search" class="form-input lk-search" id="lk-search" placeholder="搜索：发给谁 / 备注 / 机器码 / 激活码" value="${esc(_q)}" />
        <button type="button" class="btn btn-outline btn-sm" data-act="search">搜索</button>
      </div>

      <div class="lk-table-panel">
        <table class="lk-table">
          <thead>
            <tr>
              <th>发给谁</th>
              <th>激活码</th>
              <th>绑定</th>
              <th>签发时间</th>
              <th>到期时间</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="lk-tbody">
            ${renderRows()}
          </tbody>
        </table>
      </div>
    </div>
  `
}

function issueModalHtml() {
  const defaultDays = 30
  return `
    <div class="lk-modal-backdrop">
      <div class="lk-modal" role="dialog" aria-labelledby="lk-issue-title">
        <header class="lk-modal__head">
          <h2 id="lk-issue-title">签发激活码</h2>
          <button type="button" class="btn btn-ghost btn-sm" data-act="close-modal" aria-label="关闭">×</button>
        </header>
        <div class="lk-modal__body">
          <div class="form-group">
            <label class="form-label" for="lk-issued-to">发给谁</label>
            <input id="lk-issued-to" class="form-input" placeholder="客户名 / 团队 / 联系人" maxlength="200" />
          </div>
          <div class="form-group">
            <label class="form-label">有效期</label>
            <div class="lk-day-presets">
              ${[7, 30, 90, 365]
                .map(
                  (d) =>
                    `<button type="button" class="btn btn-outline btn-sm lk-day-btn${d === defaultDays ? ' is-active' : ''}" data-act="preset-days" data-days="${d}">${d} 天</button>`
                )
                .join('')}
            </div>
            <div class="lk-day-row">
              <input id="lk-days" class="form-input" type="number" min="1" max="3650" value="${defaultDays}" />
              <span class="lk-muted">天（或填下方到期日）</span>
            </div>
            <input id="lk-expires" class="form-input" type="date" style="margin-top:8px" />
          </div>
          <div class="form-group">
            <label class="form-label" for="lk-machine">预绑定机器码（可选）</label>
            <input id="lk-machine" class="form-input" placeholder="16 位十六进制；留空=浮动码" maxlength="64" spellcheck="false" />
            ${_localMid ? `<p class="form-hint">本机机器码：<code>${esc(_localMid)}</code> <button type="button" class="btn btn-ghost btn-sm" data-act="use-local-mid">填入本机</button></p>` : ''}
          </div>
          <div class="form-group">
            <label class="form-label" for="lk-note">备注</label>
            <textarea id="lk-note" class="form-input" rows="2" placeholder="合同号、联系方式等" maxlength="2000"></textarea>
          </div>
          <div id="lk-issue-result" class="lk-issue-result" hidden></div>
        </div>
        <footer class="lk-modal__foot">
          <button type="button" class="btn btn-ghost" data-act="close-modal">关闭</button>
          <button type="button" class="btn btn-primary" data-act="do-issue">签发</button>
        </footer>
      </div>
    </div>
  `
}

function closeModal() {
  q('.lk-modal-backdrop')?.remove()
}

function openIssueModal() {
  if (!_canIssue) {
    toast('未配置签发私钥，无法签发', 'error')
    return
  }
  closeModal()
  const wrap = document.createElement('div')
  wrap.innerHTML = issueModalHtml()
  const node = wrap.firstElementChild
  if (!node || !_pageEl) return
  _pageEl.appendChild(node)
  bindModal(node)
}

/**
 * @param {HTMLElement} root backdrop element
 */
function bindModal(root) {
  root.addEventListener('click', (e) => {
    // Click dimmed backdrop (not the card) → close
    if (e.target === root) {
      closeModal()
      return
    }
    const t = /** @type {HTMLElement} */ (e.target)
    const btn = t.closest('[data-act]')
    if (!btn || !root.contains(btn)) return
    e.preventDefault()
    const act = btn.getAttribute('data-act')
    if (act === 'close-modal') {
      closeModal()
      return
    }
    if (act === 'preset-days') {
      const days = btn.getAttribute('data-days') || '30'
      const daysInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#lk-days'))
      const expInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#lk-expires'))
      if (daysInput) daysInput.value = days
      if (expInput) expInput.value = ''
      root.querySelectorAll('.lk-day-btn').forEach((el) => el.classList.remove('is-active'))
      btn.classList.add('is-active')
      return
    }
    if (act === 'use-local-mid') {
      const midInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#lk-machine'))
      if (midInput && _localMid) midInput.value = _localMid
      return
    }
    if (act === 'do-issue') {
      void doIssue(root)
      return
    }
    if (act === 'copy-issued') {
      const code = btn.getAttribute('data-code') || ''
      void navigator.clipboard.writeText(code).then(
        () => toast('已复制激活码', 'success'),
        () => toast('复制失败', 'error')
      )
    }
  })
}

/**
 * @param {HTMLElement} root
 */
async function doIssue(root) {
  const issuedTo = /** @type {HTMLInputElement} */ (root.querySelector('#lk-issued-to'))?.value?.trim() || ''
  const daysRaw = /** @type {HTMLInputElement} */ (root.querySelector('#lk-days'))?.value
  const expires = /** @type {HTMLInputElement} */ (root.querySelector('#lk-expires'))?.value?.trim() || ''
  const machineId = /** @type {HTMLInputElement} */ (root.querySelector('#lk-machine'))?.value?.trim() || ''
  const note = /** @type {HTMLTextAreaElement} */ (root.querySelector('#lk-note'))?.value?.trim() || ''
  const days = Number(daysRaw) || 30

  const payload = {
    issued_to: issuedTo,
    note,
    machine_id: machineId,
  }
  if (expires) payload.expires = expires
  else payload.days = days

  const issueBtn = root.querySelector('[data-act="do-issue"]')
  if (issueBtn) issueBtn.setAttribute('disabled', '')
  try {
    const res = await api.licenseCodesIssue(payload)
    const code = String(res?.code || res?.item?.code || '')
    const result = root.querySelector('#lk-issue-result')
    if (result) {
      result.hidden = false
      result.innerHTML = `
        <p class="lk-result-label">签发成功，请复制发给对方：</p>
        <code class="lk-code-full">${esc(code)}</code>
        <button type="button" class="btn btn-primary btn-sm" data-act="copy-issued" data-code="${esc(code)}">复制激活码</button>
      `
    }
    toast('已签发并写入台账', 'success')
    // 清掉筛选，确保新记录出现在列表里
    _q = ''
    _status = ''
    const searchInput = q('#lk-search')
    if (searchInput) searchInput.value = ''
    await refresh()
  } catch (e) {
    const detail = e?.detail
    const msg =
      (typeof detail === 'object' && detail?.message) ||
      (typeof detail === 'string' && detail) ||
      e?.message ||
      String(e)
    toast(String(msg), 'error')
  } finally {
    if (issueBtn) issueBtn.removeAttribute('disabled')
  }
}

async function refresh() {
  if (!_pageEl) return
  try {
    await loadList()
    const tbody = q('#lk-tbody')
    if (tbody) tbody.innerHTML = renderRows()
    const strip = q('.lk-stat-strip')
    if (strip) {
      const tmp = document.createElement('div')
      tmp.innerHTML = renderStats()
      const next = tmp.firstElementChild
      if (next) strip.replaceWith(next)
    }
  } catch (e) {
    toast(String(e?.message || e), 'error')
  }
}

function findRow(id) {
  return _items.find((r) => String(r.id) === String(id))
}

function bindPage() {
  if (!_pageEl) return
  _pageEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target)
    const btn = t.closest('[data-act]')
    if (!btn || !_pageEl.contains(btn)) return
    if (btn.closest('.lk-modal-backdrop') || btn.closest('.lk-modal')) return
    const act = btn.getAttribute('data-act')
    if (act === 'refresh') {
      void (async () => {
        await loadMeta()
        await refresh()
        toast('已刷新', 'success')
      })()
      return
    }
    if (act === 'open-issue') {
      openIssueModal()
      return
    }
    if (act === 'search') {
      const input = /** @type {HTMLInputElement | null} */ (q('#lk-search'))
      _q = (input?.value || '').trim()
      void refresh()
      return
    }
    if (act === 'filter-status') {
      _status = btn.getAttribute('data-status') || ''
      void refresh()
      return
    }
    if (act === 'toggle-code') {
      const id = btn.getAttribute('data-id') || ''
      if (_revealed.has(id)) _revealed.delete(id)
      else _revealed.add(id)
      const tbody = q('#lk-tbody')
      if (tbody) tbody.innerHTML = renderRows()
      return
    }
    if (act === 'copy-code') {
      const id = btn.getAttribute('data-id') || ''
      const row = findRow(id)
      const code = String(row?.code || '')
      if (!code) return
      void navigator.clipboard.writeText(code).then(
        () => toast('已复制激活码', 'success'),
        () => toast('复制失败', 'error')
      )
      return
    }
    if (act === 'revoke') {
      const id = btn.getAttribute('data-id') || ''
      void (async () => {
        const ok = await showConfirm(
          '仅在台账中标记作废，无法吊销已在客户设备上激活的授权。确定作废？'
        )
        if (!ok) return
        try {
          await api.licenseCodesRevoke(id)
          toast('已作废', 'success')
          await refresh()
        } catch (err) {
          toast(String(err?.message || err), 'error')
        }
      })()
    }
  })

  q('#lk-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      _q = /** @type {HTMLInputElement} */ (e.target).value.trim()
      void refresh()
    }
  })
}

export async function render() {
  const page = document.createElement('div')
  _pageEl = page
  _q = ''
  _status = ''
  _revealed.clear()
  page.innerHTML = `<div class="page license-keys-page"><div class="lk-loading">加载台账…</div></div>`

  try {
    await loadMeta()
    await loadList()
    page.innerHTML = shellHtml()
    bindPage()
  } catch (e) {
    page.innerHTML = `
      <div class="page license-keys-page">
        <header class="lk-topbar"><h1 class="lk-title">激活码管理</h1></header>
        <div class="lk-banner lk-banner--warn">加载失败：${esc(e?.message || e)}</div>
      </div>`
  }

  return page
}

export function cleanup() {
  closeModal()
  _pageEl = null
  _items = []
}
