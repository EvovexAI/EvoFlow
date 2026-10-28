/**
 * Global pending-approval watcher (转交审核 / 员工审批).
 *
 * Backend pushes ``proactive_approval_request`` on channel ``proactive``, but the
 * panel never subscribed. Desktop notify previously only fired inside
 * ``proactive.js`` when that page was open. This module:
 * - polls pending approvals app-wide
 * - shows a bottom-left chip + OS notification on new items
 * - updates 任务中心 / 员工 nav badges
 */

import { navigate } from '../router.js'
import { toast } from '../components/toast.js'
import { notifyDesktopCompletion } from './desktop-notification.js'

const POLL_MS = 12_000
const EVENT_NAME = 'evopanel:approvals-pending'

/** @type {ReturnType<typeof setInterval> | null} */
let _timer = null
/** @type {Set<string>} */
let _seenIds = new Set()
let _bootstrapped = false
let _pendingCount = 0
/** @type {HTMLElement | null} */
let _chip = null

function approvalsFromRes(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.approvals)) return res.approvals
  return []
}

function approvalId(a) {
  return String(a?.id || a?.approval_id || '').trim()
}

function approvalHref(a) {
  const tid = String(a?.task_id || '').trim()
  const code = String(a?.role_agent_code || '').trim()
  const aid = approvalId(a)
  if (tid && code) return `/proactive/${encodeURIComponent(code)}/work/${encodeURIComponent(tid)}`
  if (tid) return `/task/${encodeURIComponent(tid)}`
  if (aid) return `/proactive?tab=approvals&highlight=${encodeURIComponent(aid)}`
  return '/proactive?tab=approvals'
}

function ensureChip() {
  if (_chip && _chip.isConnected) return _chip
  let el = document.getElementById('approval-corner-notify')
  if (!el) {
    el = document.createElement('button')
    el.id = 'approval-corner-notify'
    el.type = 'button'
    el.className = 'approval-corner-notify'
    el.hidden = true
    el.setAttribute('aria-live', 'polite')
    el.addEventListener('click', () => {
      const href = el.dataset.href || '/proactive?tab=approvals'
      navigate(href)
    })
    document.body.appendChild(el)
  }
  _chip = el
  return el
}

function renderChip(count, first) {
  const el = ensureChip()
  if (count <= 0) {
    el.hidden = true
    el.textContent = ''
    el.dataset.href = ''
    return
  }
  const role = String(first?.role_name || first?.role_agent_code || '').trim()
  const title = String(first?.initiative_title || first?.title || first?.task_id || '转交审核').trim()
  const label =
    count === 1
      ? `待审核${role ? ` · ${role}` : ''}`
      : `待审核 · ${count}`
  el.hidden = false
  el.dataset.href = approvalHref(first)
  el.title = title.slice(0, 120)
  el.innerHTML = `<span class="approval-corner-notify__dot" aria-hidden="true"></span><span class="approval-corner-notify__text">${escapeHtml(label)}</span>`
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {number} count
 */
export function setShellApprovalBadges(count) {
  const n = Math.max(0, Number(count) || 0)
  _pendingCount = n
  for (const sel of [
    '[data-shell-nav="/tasks"]',
    '[data-shell-nav="/proactive"]',
    '[data-premium-nav="tasks"]',
    '[data-premium-nav="proactive"]',
  ]) {
    document.querySelectorAll(sel).forEach((btn) => {
      let badge = btn.querySelector('.shell-nav-approval-badge')
      if (n <= 0) {
        if (badge) badge.remove()
        btn.removeAttribute('data-approval-pending')
        return
      }
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'shell-nav-approval-badge'
        badge.setAttribute('aria-hidden', 'true')
        btn.appendChild(badge)
      }
      badge.textContent = n > 99 ? '99+' : String(n)
      badge.title = `${n} 项待审核`
      btn.setAttribute('data-approval-pending', '1')
    })
  }
}

function emitPending(count, list) {
  try {
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: { count, approvals: list },
      }),
    )
  } catch {
    /* ignore */
  }
}

/**
 * @param {Array<Record<string, unknown>>} list
 * @param {{ notifyNew?: boolean }} [opts]
 */
function applyList(list, opts = {}) {
  const pending = (Array.isArray(list) ? list : []).filter(
    (a) => String(a?.status || '').toLowerCase() === 'pending',
  )
  const ids = pending.map(approvalId).filter(Boolean)
  const idSet = new Set(ids)

  const fresh = []
  if (_bootstrapped && opts.notifyNew !== false) {
    for (const a of pending) {
      const id = approvalId(a)
      if (id && !_seenIds.has(id)) fresh.push(a)
    }
  }

  _seenIds = idSet
  _bootstrapped = true
  setShellApprovalBadges(pending.length)
  renderChip(pending.length, pending[0] || null)
  emitPending(pending.length, pending)

  if (fresh.length) {
    const first = fresh[0]
    const role = String(first?.role_name || first?.role_agent_code || '').trim()
    const titleHint = String(first?.initiative_title || first?.title || '').trim()
    const n = fresh.length
    const title = n === 1 ? '转交审核 · 待你拍板' : `${n} 条待审核`
    const body = role
      ? `「${role}」${titleHint ? `：${titleHint}` : '需要同意后才派下游'}`
      : '打开任务中心或员工 → 待审批'

    void notifyDesktopCompletion({
      title,
      body,
      tag: `proactive-approval:${approvalId(first) || 'batch'}`,
      extra: { hash: `#${approvalHref(first)}` },
    })

    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'toast-action'
    action.textContent = '去处理'
    action.addEventListener('click', (e) => {
      e.stopPropagation()
      navigate(approvalHref(first))
    })
    toast.warning(n === 1 ? `待审核${role ? ` · ${role}` : ''}` : title, {
      duration: 8000,
      key: 'proactive-approval',
      action,
    })
  }
}

async function pollOnce() {
  try {
    const { api } = await import('./tauri-api.js')
    const res = await api.proactiveListApprovals('pending')
    applyList(approvalsFromRes(res), { notifyNew: true })
  } catch {
    /* offline / gateway down — keep last badge */
  }
}

export function getPendingApprovalCount() {
  return _pendingCount
}

export function startProactiveApprovalNotify() {
  if (_timer) return
  ensureChip()
  void pollOnce()
  _timer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void pollOnce()
  }, POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pollOnce()
  })
}

export function stopProactiveApprovalNotify() {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}

/** Force refresh after user approves/rejects on a detail page. */
export function refreshProactiveApprovalNotify() {
  return pollOnce()
}

export { EVENT_NAME as APPROVALS_PENDING_EVENT }
