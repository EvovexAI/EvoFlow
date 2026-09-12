/** Per-person downstream handlers on a Task (处理人 + 内容 + 参考产物引用).
 *
 * Canonical handler field: ``read_outputs`` (what the assignee should read).
 * Legacy ``outputs`` / ``artifacts`` are accepted on normalize.
 * Child tasks store those refs as ``input_refs`` (never as their own ``outputs``).
 */

/**
 * Try JSON.parse, then repair common LLM / pseudo-JSON (unquoted keys/values).
 * Never fall back to comma-splitting object-like blobs — that turns one handler
 * into many fake agent_code rows in the 交工待验收 UI.
 */
export function tryParseHandlersJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    /* continue */
  }

  let s = raw
  s = s.replace(/([{,\[]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
  s = s.replace(/:\s*([A-Za-z_][\w./-]*)(?=\s*[,}\]])/g, ':"$1"')
  try {
    return JSON.parse(s)
  } catch {
    /* continue */
  }

  s = s.replace(
    /("(?:content|label|value|description|work|task|path|url|title)"\s*:\s*)(?!")([^]*?)(?=\s*,\s*"[A-Za-z_][\w]*"\s*:|\s*[,}\]])/g,
    (_, prefix, val) => {
      const cleaned = String(val)
        .trim()
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
      return `${prefix}"${cleaned}"`
    },
  )
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function looksLikeHandlerObjectBlob(text) {
  const s = String(text || '')
  return (
    /[{}\[\]]/.test(s) ||
    /agent_code\s*:/i.test(s) ||
    /"agent_code"/i.test(s) ||
    /(?:read_)?outputs\s*:/i.test(s)
  )
}

function tryReassembleHandlerFragments(parts) {
  if (!Array.isArray(parts) || parts.length < 2) return null
  if (!parts.every((p) => typeof p === 'string')) return null
  const joined = parts.join(',')
  if (!looksLikeHandlerObjectBlob(joined)) return null
  let body = joined.trim()
  if (!body.startsWith('[')) body = `[${body}`
  if (!body.endsWith(']')) body = `${body}]`
  return tryParseHandlersJson(body)
}

function normalizeHandlerOutputs(raw) {
  if (!raw) return []
  let items = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    const parsed = tryParseHandlersJson(text)
    if (parsed != null) {
      items = parsed
    } else if (looksLikeHandlerObjectBlob(text)) {
      return []
    } else {
      items = text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((value, i) => ({ type: 'file', key: `artifact_${i + 1}`, value }))
    }
  }
  if (!Array.isArray(items)) {
    items = items && typeof items === 'object' ? [items] : []
  }
  return items
    .map((item, i) => {
      if (typeof item === 'string') {
        const value = item.trim()
        if (!value) return null
        return { type: 'file', key: `artifact_${i + 1}`, value }
      }
      if (!item || typeof item !== 'object') return null
      const value = String(item.value || item.path || item.url || item.content || '').trim()
      if (!value) return null
      const row = {
        type: String(item.type || 'file').trim() || 'file',
        key: String(item.key || item.name || `artifact_${i + 1}`).trim() || `artifact_${i + 1}`,
        value,
      }
      const label = String(item.label || item.title || '').trim()
      if (label) row.label = label
      return row
    })
    .filter(Boolean)
}

export function normalizeTaskHandlers(raw) {
  if (!raw) return []
  let items = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    const parsed = tryParseHandlersJson(text)
    if (parsed != null) {
      items = parsed
    } else if (looksLikeHandlerObjectBlob(text)) {
      return []
    } else {
      items = text
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  if (!Array.isArray(items)) {
    items = items && typeof items === 'object' ? [items] : []
  }

  const reassembled = tryReassembleHandlerFragments(items)
  if (reassembled != null) {
    items = Array.isArray(reassembled) ? reassembled : [reassembled]
  }

  const out = []
  for (const item of items) {
    if (typeof item === 'string') {
      const code = item.trim()
      if (!code || /^(content|read_outputs|outputs|type|key|value|label)\s*:/i.test(code)) continue
      if (/^[{}\[\]]/.test(code) || code.includes('{') || code.includes('[')) continue
      out.push({ agent_code: code, content: '', read_outputs: [] })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const code = String(item.agent_code || item.assignee || item.handler || item.code || '').trim()
    if (!code) continue
    const content = String(item.content || item.description || item.work || item.task || '').trim()
    const role = String(item.role || item.assigned_role || item.role_name || '').trim()
    const readRaw =
      item.read_outputs != null ? item.read_outputs : item.outputs != null ? item.outputs : item.artifacts
    const read_outputs = normalizeHandlerOutputs(readRaw)
    const row = { agent_code: code, content, read_outputs }
    if (role) row.role = role
    out.push(row)
  }
  return out
}

export function taskHandlersOf(task) {
  if (!task || typeof task !== 'object') return []
  const direct = normalizeTaskHandlers(task.handlers)
  if (direct.length) return direct
  return normalizeTaskHandlers(task.suggested_handlers)
}

/** Upstream read refs on a child task (distinct from deliverable ``outputs``). */
export function taskInputRefsOf(task) {
  if (!task || typeof task !== 'object') return []
  return normalizeHandlerOutputs(task.input_refs)
}

function outputsToLines(outputs) {
  return (outputs || [])
    .map((o) => String(o?.value || '').trim())
    .filter(Boolean)
    .join('\n')
}

export function handlerDisplayName(h, roles = []) {
  const code = String(h?.agent_code || '').trim()
  const role = String(h?.role || '').trim()
  if (role) return role
  const hit = roles.find((r) => String(r.agent_code || '').trim() === code)
  if (hit?.role_name) return String(hit.role_name).trim()
  return code || '未选'
}

function previewText(text, max = 28) {
  const s = String(text || '').trim().replace(/\s+/g, ' ')
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Compact one-line summary for collapsed header. */
export function handlersSummaryText(handlers, roles = []) {
  const rows = normalizeTaskHandlers(handlers).filter((h) => String(h.agent_code || '').trim())
  if (!rows.length) return '未指定 · 确认后仅结案'
  const names = rows.map((h) => handlerDisplayName(h, roles))
  const namePart = names.slice(0, 3).join('、') + (names.length > 3 ? ` 等${names.length}人` : '')
  const firstContent = previewText(rows[0]?.content, 24)
  if (rows.length === 1) {
    return firstContent ? `${namePart} · ${firstContent}` : `${namePart} · 1 人接手`
  }
  return `${rows.length} 人接手 · ${namePart}`
}

function reportsToOfRole(role) {
  return String(role?.reports_to || role?.config?.reports_to || '').trim()
}

/** Roles whose直属上级 is ``managerCode`` (active only). */
export function filterDirectReportRoles(roster, managerCode) {
  const mgr = String(managerCode || '').trim()
  if (!mgr) return []
  return (Array.isArray(roster) ? roster : []).filter((r) => {
    const code = String(r.agent_code || '').trim()
    if (!code || code === mgr) return false
    const st = String(r.status || '').toLowerCase()
    if (st === 'archived' || st === 'draft') return false
    return reportsToOfRole(r) === mgr
  })
}

function roleOptionsHtml(roles, selected, esc, { emptyLabel = '选择处理人…' } = {}) {
  const opts = [`<option value="">${esc(emptyLabel)}</option>`]
  for (const r of roles) {
    const code = String(r.agent_code || '').trim()
    if (!code) continue
    const name = String(r.role_name || code).trim()
    const sel = code === selected ? ' selected' : ''
    opts.push(`<option value="${esc(code)}"${sel}>${esc(name)} (${esc(code)})</option>`)
  }
  if (selected && !roles.some((r) => String(r.agent_code || '') === selected)) {
    opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}（当前指定）</option>`)
  }
  return opts.join('')
}

function renderHandlerCardHtml(h, i, roles, esc) {
  const code = String(h.agent_code || '').trim()
  const content = String(h.content || '')
  const outs = outputsToLines(h.read_outputs || h.outputs)
  const emptyLabel = roles.length ? '选择直属下级…' : '暂无直属下级'
  return `
    <div class="task-handler-card" data-handler-row="${i}">
      <div class="task-handler-card-head">
        <span class="task-handler-card-idx">#${i + 1}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-handler-remove="${i}" title="移除">移除</button>
      </div>
      <div class="task-handler-fields">
        <label class="task-handler-field">
          <span class="task-handler-label">谁处理</span>
          <select class="form-input task-handler-agent" data-handler-agent>
            ${roleOptionsHtml(roles, code, esc, { emptyLabel })}
          </select>
        </label>
        <label class="task-handler-field">
          <span class="task-handler-label">对应内容</span>
          <textarea class="form-input task-handler-content" data-handler-content rows="2" placeholder="该人要做什么">${esc(content)}</textarea>
        </label>
        <label class="task-handler-field">
          <span class="task-handler-label">参考产物 <em>每行一个路径（只读引用，非下游自己的交付）</em></span>
          <textarea class="form-input task-handler-outputs" data-handler-outputs rows="2" placeholder="docs/roles/…/report.md">${esc(outs)}</textarea>
        </label>
      </div>
    </div>`
}

/**
 * Editable handlers block for 交工待验收 — default collapsed with summary.
 * @param {{ handlers?: any[], roles?: any[], esc: Function, expanded?: boolean, fromAgentCode?: string, allowReassignAll?: boolean }} opts
 */
export function renderHandlersEditorHtml({
  handlers = [],
  roles = [],
  esc,
  expanded = false,
  fromAgentCode = '',
  allowReassignAll = false,
} = {}) {
  const roster = Array.isArray(roles) ? roles : []
  const from = String(fromAgentCode || '').trim()
  const direct = from ? filterDirectReportRoles(roster, from) : []
  const useAll = Boolean(allowReassignAll) || !from
  const pickRoles = useAll
    ? roster.filter((r) => String(r.status || '').toLowerCase() !== 'archived')
    : direct
  const filled = normalizeTaskHandlers(handlers).filter((h) => String(h.agent_code || '').trim())
  const editRows = filled.length ? filled : [{ agent_code: '', content: '', read_outputs: [] }]
  const cards = editRows.map((h, i) => renderHandlerCardHtml(h, i, pickRoles, esc)).join('')
  const count = filled.length
  const headLine = handlersSummaryText(filled, roster)
  const openAttr = expanded ? ' open' : ''
  const reassignChecked = useAll && from ? ' checked' : ''
  const emptyHint =
    !useAll && !direct.length
      ? `<p class="task-handlers-body-warn">本岗暂无直属下级。请先在组织架构配置下级，或勾选下方「用户改派」选同组织同事；同级日常协作请用派发/叫醒。</p>`
      : ''

  return `
    <details class="task-handlers-editor" data-handlers-editor data-from-agent="${esc(from)}"${openAttr}>
      <summary class="task-handlers-summary" data-handlers-toggle>
        <span class="task-handlers-summary-main">
          <span class="task-handlers-summary-title">处理人</span>
          ${
            count
              ? `<span class="task-handlers-summary-badge">${count}</span>`
              : `<span class="task-handlers-summary-badge task-handlers-summary-badge--muted">0</span>`
          }
          <span class="task-handlers-summary-text" data-handlers-summary-text>${esc(headLine)}</span>
        </span>
        <span class="task-handlers-summary-action" data-handlers-action-label>${expanded ? '收起' : '展开编辑'}</span>
      </summary>
      <div class="task-handlers-body">
        <p class="task-handlers-body-hint">默认只能选<strong>直属下级</strong>。同级对齐请用派发/叫醒。你（用户）可勾选改派到同组织任意同事。</p>
        ${
          from
            ? `<label class="task-handlers-reassign">
          <input type="checkbox" data-handler-reassign-all${reassignChecked} />
          <span>用户改派：显示同组织全部在岗同事</span>
        </label>`
            : ''
        }
        ${emptyHint}
        <div class="task-handlers-list" data-handlers-list>${cards}</div>
        <button type="button" class="btn btn-sm btn-secondary" data-handler-add>+ 添加处理人</button>
      </div>
    </details>`
}

/** Read-only list for completed / outcome cards (also collapsible). */
export function renderHandlersReadonlyHtml(handlers, esc, opts = {}) {
  const rows = normalizeTaskHandlers(handlers)
  if (!rows.length) return ''
  const roles = Array.isArray(opts.roles) ? opts.roles : []
  const headLine = handlersSummaryText(rows, roles)
  const openAttr = opts.open ? ' open' : ''
  const cards = rows
    .map((h) => {
      const code = String(h.agent_code || '').trim()
      const name = handlerDisplayName(h, roles)
      const who = name && name !== code ? `${name}（${code}）` : code || name
      const outs = (h.read_outputs || h.outputs || [])
        .map((o) => `<li><code>${esc(o.value || '')}</code>${o.label ? ` · ${esc(o.label)}` : ''}</li>`)
        .join('')
      return `
        <div class="task-handler-card task-handler-card--ro">
          <div class="task-handler-card-idx">${esc(who)}</div>
          <p class="task-handler-ro-content">${esc(h.content || '（未写内容）')}</p>
          ${outs ? `<ul class="task-handler-ro-outputs">${outs}</ul>` : ''}
        </div>`
    })
    .join('')
  return `
    <details class="task-handlers-editor task-handlers-editor--ro td-card" aria-label="下一岗处理人"${openAttr}>
      <summary class="task-handlers-summary">
        <span class="task-handlers-summary-main">
          <span class="task-handlers-summary-title">下一岗</span>
          <span class="task-handlers-summary-badge">${rows.length}</span>
          <span class="task-handlers-summary-text">${esc(headLine)}</span>
        </span>
        <span class="task-handlers-summary-action">详情</span>
      </summary>
      <div class="task-handlers-body">
        <div class="task-handlers-list">${cards}</div>
      </div>
    </details>`
}

/** Collect handlers from an editor root element (canonical ``read_outputs``). */
export function collectHandlersFromEditor(root) {
  if (!root) return []
  const cards = root.querySelectorAll('[data-handler-row]')
  const out = []
  cards.forEach((card) => {
    const agent = String(card.querySelector('[data-handler-agent]')?.value || '').trim()
    const content = String(card.querySelector('[data-handler-content]')?.value || '').trim()
    const outsRaw = String(card.querySelector('[data-handler-outputs]')?.value || '').trim()
    if (!agent && !content && !outsRaw) return
    if (!agent) return
    const read_outputs = outsRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value, i) => ({ type: 'file', key: `artifact_${i + 1}`, value }))
    const opt = card.querySelector('[data-handler-agent] option:checked')
    const label = String(opt?.textContent || '').trim()
    const roleMatch = label.match(/^(.+?)\s*\(/)
    const row = { agent_code: agent, content, read_outputs }
    if (roleMatch) row.role = roleMatch[1].trim()
    out.push(row)
  })
  return out
}

function refreshEditorSummary(root, roles, esc) {
  if (!root) return
  const handlers = collectHandlersFromEditor(root)
  const textEl = root.querySelector('[data-handlers-summary-text]')
  const badge = root.querySelector('.task-handlers-summary-badge')
  const action = root.querySelector('[data-handlers-action-label]')
  if (textEl) textEl.textContent = handlersSummaryText(handlers, roles)
  if (badge) {
    badge.textContent = String(handlers.length)
    badge.classList.toggle('task-handlers-summary-badge--muted', handlers.length === 0)
  }
  if (action) action.textContent = root.open ? '收起' : '展开编辑'
}

/**
 * Bind add/remove + summary refresh on collapsible editor.
 * @param {HTMLElement} root
 * @param {{ roles?: any[], esc?: Function, fromAgentCode?: string }} opts
 */
export function bindHandlersEditor(root, { roles = [], esc, fromAgentCode = '' } = {}) {
  if (!root || root.dataset.handlersBound === '1') return
  root.dataset.handlersBound = '1'

  const roster = Array.isArray(roles) ? roles : []
  const from =
    String(fromAgentCode || root.getAttribute('data-from-agent') || '').trim()
  const escape = typeof esc === 'function' ? esc : (s) => String(s ?? '')
  const list = () => root.querySelector('[data-handlers-list]')

  const currentPickRoles = () => {
    const allowAll = Boolean(root.querySelector('[data-handler-reassign-all]')?.checked) || !from
    if (allowAll) {
      return roster.filter((r) => String(r.status || '').toLowerCase() !== 'archived')
    }
    return filterDirectReportRoles(roster, from)
  }

  const repaintSelects = () => {
    const pick = currentPickRoles()
    list()
      ?.querySelectorAll('[data-handler-row]')
      .forEach((card) => {
        const sel = card.querySelector('[data-handler-agent]')
        if (!sel) return
        const cur = String(sel.value || '').trim()
        const emptyLabel = pick.length ? '选择直属下级…' : '暂无直属下级'
        sel.innerHTML = roleOptionsHtml(pick, cur, escape, { emptyLabel })
      })
    const warn = root.querySelector('.task-handlers-body-warn')
    const allowAll = Boolean(root.querySelector('[data-handler-reassign-all]')?.checked) || !from
    if (!allowAll && !currentPickRoles().length) {
      if (!warn) {
        const p = document.createElement('p')
        p.className = 'task-handlers-body-warn'
        p.textContent =
          '本岗暂无直属下级。请先在组织架构配置下级，或勾选「用户改派」；同级请用派发/叫醒。'
        list()?.before(p)
      }
    } else {
      warn?.remove()
    }
    refreshEditorSummary(root, roster, escape)
  }

  const reindex = () => {
    list()
      ?.querySelectorAll('[data-handler-row]')
      .forEach((card, i) => {
        card.dataset.handlerRow = String(i)
        const idx = card.querySelector('.task-handler-card-idx')
        if (idx) idx.textContent = `#${i + 1}`
        const rm = card.querySelector('[data-handler-remove]')
        if (rm) rm.dataset.handlerRemove = String(i)
      })
    refreshEditorSummary(root, roster, escape)
  }

  root.addEventListener('toggle', () => {
    const action = root.querySelector('[data-handlers-action-label]')
    if (action) action.textContent = root.open ? '收起' : '展开编辑'
  })

  root.addEventListener('change', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    if (t.matches?.('[data-handler-reassign-all]')) {
      repaintSelects()
      return
    }
    if (t.closest?.('[data-handler-agent], [data-handler-content], [data-handler-outputs]')) {
      refreshEditorSummary(root, roster, escape)
    }
  })
  root.addEventListener('input', (e) => {
    if (e.target.closest?.('[data-handler-content], [data-handler-outputs]')) {
      refreshEditorSummary(root, roster, escape)
    }
  })

  root.addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-handler-add]')
    if (addBtn && root.contains(addBtn)) {
      e.preventDefault()
      const html = renderHandlerCardHtml(
        { agent_code: '', content: '', read_outputs: [] },
        0,
        currentPickRoles(),
        escape,
      )
      const tmp = document.createElement('div')
      tmp.innerHTML = html
      const card = tmp.querySelector('[data-handler-row]')
      if (card && list()) {
        list().appendChild(card)
        reindex()
        root.open = true
      }
      return
    }
    const rm = e.target.closest('[data-handler-remove]')
    if (rm && root.contains(rm)) {
      e.preventDefault()
      const card = rm.closest('[data-handler-row]')
      card?.remove()
      if (list() && !list().querySelector('[data-handler-row]')) {
        const html = renderHandlerCardHtml(
          { agent_code: '', content: '', read_outputs: [] },
          0,
          currentPickRoles(),
          escape,
        )
        const tmp = document.createElement('div')
        tmp.innerHTML = html
        const empty = tmp.querySelector('[data-handler-row]')
        if (empty) list().appendChild(empty)
      }
      reindex()
    }
  })
}
