/**
 * 设置 → 开发代理（Developer Agents）
 *
 * EVO-0006.4：展示本机 Cursor CLI 预检状态；不显示 API Key / Token / 邮箱 / 原始 CLI 输出。
 * Backend: GET /api/developer-agents, POST /api/developer-agents/cursor/preflight
 */
import { toast } from '../../components/toast.js'
import {
  developerAgentStatusLabel,
  developerAgentStatusTone,
  listDeveloperAgents,
  pickCursorAgent,
  preflightCursorAgent,
} from '../../lib/developer-agents.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {import('../../lib/developer-agents.js').DeveloperAgent | null} */
let _cursor = null
/** @type {boolean} */
let _loading = false
/** @type {string | null} */
let _error = null

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function yesNo(v) {
  return v ? '是' : '否'
}

function displayOrDash(v) {
  const s = String(v ?? '').trim()
  return s || '—'
}

function statusBadgeHtml(status) {
  const tone = developerAgentStatusTone(status)
  const label = developerAgentStatusLabel(status)
  return `<span class="sec-mode-badge sec-mode-badge--${tone}">${escHtml(label)}</span>`
}

function fieldRow(label, valueHtml) {
  return `
    <div class="dev-agent-field">
      <dt>${escHtml(label)}</dt>
      <dd>${valueHtml}</dd>
    </div>`
}

function cursorCardHtml() {
  if (_loading && !_cursor) {
    return `<div class="stat-card loading-placeholder" style="height:140px" aria-busy="true"></div>`
  }

  if (_error && !_cursor) {
    return `
      <div class="config-section">
        <p class="form-hint" style="color:var(--danger)">加载失败：${escHtml(_error)}</p>
        <button type="button" class="cron-btn primary" data-dev-agent-preflight>重新检测</button>
      </div>`
  }

  const agent = _cursor || {}
  const status = agent.status || 'unavailable'
  const detail = displayOrDash(agent.detail)

  return `
  <div class="config-section" id="dev-agent-cursor-card">
    <div class="config-section-title" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:8px">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
        Cursor Agent
      </span>
      ${statusBadgeHtml(status)}
    </div>
    <p class="form-hint">本机 Cursor CLI 预检结果。EvoPanel 不直接运行命令，也不保存登录凭据。</p>

    <dl class="dev-agent-fields">
      ${fieldRow('状态', statusBadgeHtml(status))}
      ${fieldRow('可用', escHtml(yesNo(!!agent.available)))}
      ${fieldRow('已认证', escHtml(yesNo(!!agent.authenticated)))}
      ${fieldRow('版本', `<code class="dev-agent-mono">${escHtml(displayOrDash(agent.version))}</code>`)}
      ${fieldRow('可执行路径', `<code class="dev-agent-mono sec-status-meta">${escHtml(displayOrDash(agent.executable_path))}</code>`)}
      ${fieldRow('说明', `<span class="dev-agent-detail">${escHtml(detail)}</span>`)}
    </dl>

    ${_error ? `<p class="form-hint" style="color:var(--danger);margin-top:8px">${escHtml(_error)}</p>` : ''}

    <div class="dev-agent-actions">
      <button type="button" class="cron-btn primary" data-dev-agent-preflight ${_loading ? 'disabled' : ''}>
        ${_loading ? '检测中…' : '重新检测'}
      </button>
    </div>
  </div>`
}

function fullHtml() {
  return `
    <div class="settings-modal-pane-body">
      <div class="dev-agent-page">
        ${cursorCardHtml()}
      </div>
    </div>`
}

function render() {
  if (!_root) return
  _root.innerHTML = fullHtml()
  wireEvents(_root)
}

/**
 * @param {HTMLElement} root
 */
function wireEvents(root) {
  root.querySelector('[data-dev-agent-preflight]')?.addEventListener('click', () => {
    void runPreflight({ notify: true })
  })
}

/**
 * @param {{ notify?: boolean }} [opts]
 */
async function runPreflight(opts = {}) {
  if (_loading) return
  _loading = true
  _error = null
  render()
  try {
    const result = await preflightCursorAgent()
    _cursor = result && typeof result === 'object' ? result : null
    if (opts.notify) toast('已重新检测 Cursor Agent', 'success')
  } catch (err) {
    _error = String(err?.message || err || '预检失败')
    if (opts.notify) toast(`检测失败：${_error}`, 'error')
  } finally {
    _loading = false
    render()
  }
}

/**
 * @param {{ agents?: import('../../lib/developer-agents.js').DeveloperAgent[] }} payload
 */
function applyListPayload(payload) {
  _cursor = pickCursorAgent(payload)
}

export function cleanup() {
  _root = null
  _cursor = null
  _loading = false
  _error = null
}

/** @param {HTMLElement} container */
export async function mountDeveloperAgentsInto(container) {
  cleanup()
  _root = container
  container.classList.add('settings-modal-pane--developer-agents', 'settings-embed-wrap')
  _loading = true
  render()

  try {
    const data = await listDeveloperAgents()
    applyListPayload(data)
  } catch (err) {
    _error = String(err?.message || err || '加载失败')
  } finally {
    _loading = false
    render()
  }
}
