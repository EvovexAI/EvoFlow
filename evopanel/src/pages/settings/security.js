/**
 * 设置 → 安全中心
 *
 * 1. 主机执行安全 — OS 沙箱（helper 就绪默认启用）
 * 2. 新对话默认权限 — 全局工具审批默认（聊天底部档位可覆盖）
 * 3. 终端命令策略 — 放行/强制询问前缀
 * 4. 系统级工具 — WSL/wmic/sc/reg 等前缀拦截
 * 5. 审计中心 — 拦截记录
 */
import { toast } from '../../components/toast.js'
import {
  fetchSecuritySettings,
  patchSecuritySettings,
  patchExecutionSecurity,
  fetchSecurityAudit,
  clearSecurityAudit,
  exportSecurityAudit,
} from '../../lib/security-settings.js'
import {
  fetchGlobalToolApprovalPolicy,
  getCachedGlobalToolApprovalPolicy,
  isToolApprovalDisabled,
  patchGlobalToolApprovalPolicy,
  TOOL_APPROVAL_POLICY_GRANT_ALL,
  TOOL_APPROVAL_POLICY_SESSION,
} from '../../lib/tool-approval-settings.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {Record<string, any> | null} */
let _settings = null
/** @type {any[] | null} */
let _auditRecords = null
/** @type {boolean} */
let _grantAllDefault = false

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escAttr(s) {
  return String(s || '').replace(/"/g, '&quot;')
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function joinLines(arr) {
  return (Array.isArray(arr) ? arr : []).join('\n')
}

const AUDIT_LABELS = {
  path_traversal: { text: '路径穿越', cls: 'sec-audit-badge--danger' },
  path_denied: { text: '路径拒绝', cls: 'sec-audit-badge--warning' },
  denylist_blocked: { text: '安全策略', cls: 'sec-audit-badge--danger' },
  permission_error: { text: '权限拒绝', cls: 'sec-audit-badge--warning' },
}

const PROFILE_OPTIONS = [
  {
    id: 'read-only',
    title: '限制访问',
    desc: '主机 terminal 以只读为主，不能改工作区文件（OS 沙箱）。',
  },
  {
    id: 'workspace',
    title: '工作空间访问',
    desc: '可读写当前工作区与临时目录；其它路径只读（推荐）。',
  },
  {
    id: 'danger-full-access',
    title: '完全访问',
    desc: '不启用文件系统 OS 隔离；仍可按下方审批策略询问。',
  },
]

const MODE_LABELS = {
  sandboxed: { text: 'OS 沙箱生效中', cls: 'sec-mode-badge--ok' },
  passthrough: { text: '已启用 · helper 缺失（直通主机）', cls: 'sec-mode-badge--warn' },
  blocked: { text: '已启用 · 无法执行（无 helper）', cls: 'sec-mode-badge--danger' },
  disabled: { text: '未启用 OS 沙箱', cls: 'sec-mode-badge--muted' },
}

function auditBadge(eventType) {
  return AUDIT_LABELS[String(eventType || '').trim()] || { text: '已拦截', cls: 'sec-audit-badge--muted' }
}

function executionOf(s) {
  return s?.execution_security && typeof s.execution_security === 'object' ? s.execution_security : {}
}

function executionSectionHtml(s) {
  const ex = executionOf(s)
  const enabled = !!ex.enabled
  const auto = ex.auto_enable_when_helpers_ready !== false
  const active = !!ex.active
  const profile = String(ex.profile || 'workspace')
  const approval = String(ex.approval || 'on-request')
  const mode = String(ex.mode || 'disabled')
  const modeMeta = MODE_LABELS[mode] || MODE_LABELS.disabled
  const helpersReady = !!ex.helpers_ready
  const notes = String(ex.notes || '')
  const helperPath =
    ex.helpers?.windows_sandbox ||
    ex.helpers?.linux_sandbox ||
    ex.helpers?.helper_dir ||
    ''

  const cards = PROFILE_OPTIONS.map((p) => {
    const selected = profile === p.id
    return `
      <label class="sec-profile-card ${selected ? 'is-selected' : ''}">
        <input type="radio" name="sec-exec-profile" value="${escAttr(p.id)}" ${selected ? 'checked' : ''} />
        <span class="sec-profile-card-title">${escHtml(p.title)}</span>
        <span class="sec-profile-card-desc">${escHtml(p.desc)}</span>
      </label>`
  }).join('')

  const howActive =
    active && !enabled && auto && helpersReady
      ? '当前：helper 就绪，已自动启用（与原生运行时一致）'
      : active && enabled
        ? '当前：已强制开启'
        : !active
          ? '当前：未生效（命令仍在主机直跑）'
          : '当前：已启用'

  return `
  <div class="config-section" id="sec-execution">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      主机执行安全
    </div>
    <p class="form-hint">
      <strong>日常不用来这里改。</strong>和 runtime 一样：聊天底部选「请求批准 / 帮我批准 / 完全访问」就会带上沙箱档位。
      Helper 就绪时默认自动启用；只有要强制开关或改全局兜底时才用本页。
    </p>

    <div class="sec-status-row">
      <span class="sec-mode-badge ${modeMeta.cls}">${escHtml(modeMeta.text)}</span>
      <span class="sec-status-meta">${escHtml(howActive)} · Helper：${helpersReady ? '已就绪' : '未找到'}${helperPath ? ` · ${escHtml(helperPath)}` : ''}</span>
    </div>
    ${notes ? `<p class="form-hint sec-exec-notes">${escHtml(notes)}</p>` : ''}

    <div class="sec-toggle-row">
      <div class="sec-toggle-info">
        <span class="sec-toggle-label">Helper 就绪时自动启用</span>
        <span class="sec-toggle-desc">推荐保持开启。有沙箱组件就自动隔离 terminal，无需再找开关</span>
      </div>
      <label class="sec-switch">
        <input type="checkbox" id="sec-exec-auto" ${auto ? 'checked' : ''} />
        <span class="sec-switch-slider"></span>
      </label>
    </div>

    <div class="sec-toggle-row">
      <div class="sec-toggle-info">
        <span class="sec-toggle-label">强制开启 OS 沙箱</span>
        <span class="sec-toggle-desc">即使不想依赖自动检测，也可强制打开；关闭且关掉自动启用后才完全直通主机</span>
      </div>
      <label class="sec-switch">
        <input type="checkbox" id="sec-exec-enabled" ${enabled ? 'checked' : ''} />
        <span class="sec-switch-slider"></span>
      </label>
    </div>

    <details class="sec-advanced" ${enabled || !auto ? 'open' : ''}>
      <summary>高级：全局兜底档位（会话聊天档位会覆盖）</summary>
      <div class="sec-profile-grid" aria-label="访问档位">${cards}</div>

      <div class="sec-toggle-row sec-exec-approval-row">
        <div class="sec-toggle-info">
          <span class="sec-toggle-label">全局命令审批兜底</span>
          <span class="sec-toggle-desc">会话「帮我批准」等档位会覆盖这里；一般保持「按需询问」</span>
        </div>
        <select class="sec-select sec-select--compact" id="sec-exec-approval">
          <option value="untrusted" ${approval === 'untrusted' ? 'selected' : ''}>始终询问</option>
          <option value="on-request" ${approval === 'on-request' ? 'selected' : ''}>按需询问（默认）</option>
          <option value="never" ${approval === 'never' ? 'selected' : ''}>不询问</option>
        </select>
      </div>
    </details>

    <div class="sec-save-row">
      <button type="button" class="cron-btn sm primary" id="sec-save-execution">保存</button>
    </div>
  </div>`
}

function chatDefaultApprovalSectionHtml(grantAllDefault) {
  const on = !!grantAllDefault
  return `
  <div class="config-section" id="sec-chat-default-approval">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      新对话默认权限
    </div>
    <p class="form-hint">
      只影响<strong>新建对话</strong>的默认值。日常请用聊天底部「请求批准 / 帮我批准 / 完全访问」；单会话改了档位后不再跟这里走。
    </p>
    <div class="sec-toggle-row">
      <div class="sec-toggle-info">
        <span class="sec-toggle-label">新对话默认完全访问（不询问）</span>
        <span class="sec-toggle-desc">开启后新对话自动跑终端 / 删文件等；关闭则为「帮我批准」（仅风险操作询问）</span>
      </div>
      <label class="sec-switch">
        <input type="checkbox" id="sec-chat-grant-all-default" ${on ? 'checked' : ''} />
        <span class="sec-switch-slider"></span>
      </label>
    </div>
  </div>`
}

function policySectionHtml(s) {
  const cmdSec = s?.sandbox?.command_security || {}

  return `
  <div class="config-section" id="sec-policy">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7v10a2 2 0 002 2h16a2 2 0 002-2V7L12 2z"/><path d="M2 7l10 5 10-5"/><path d="M12 22V12"/></svg>
      终端命令策略
    </div>
    <p class="form-hint">只作用于 <code>terminal</code> 的审批：匹配左侧前缀可自动放行，匹配右侧前缀会强制询问。</p>

    <div class="sec-dual-list">
      <div class="sec-list-group">
        <label class="sec-field-label">自动放行前缀</label>
        <textarea class="cron-input sec-textarea" id="sec-cmd-allow" rows="5" spellcheck="false" placeholder="每行一个命令前缀，如 git status">${escHtml(joinLines(cmdSec.allow_prefixes))}</textarea>
      </div>
      <div class="sec-list-group">
        <label class="sec-field-label">强制询问前缀</label>
        <textarea class="cron-input sec-textarea" id="sec-cmd-prompt" rows="5" spellcheck="false" placeholder="每行一个命令前缀，如 rm">${escHtml(joinLines(cmdSec.prompt_prefixes))}</textarea>
      </div>
    </div>

    <div class="sec-save-row">
      <button type="button" class="cron-btn sm primary" id="sec-save-policy">保存命令策略</button>
    </div>
  </div>`
}

function systemToolsSectionHtml(s) {
  const st = s?.system_tools || {}
  const enabled = st.enabled === true
  const blocked = Array.isArray(st.blocked_tools) ? st.blocked_tools : []

  return `
  <div class="config-section" id="sec-sys-tools">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
      系统级工具
    </div>
    <p class="form-hint">关闭时拦截 WSL、wmic、sc、reg、schtasks 等前缀命令（应用层拦截，与 OS 沙箱无关）。</p>

    <div class="sec-toggle-row">
      <div class="sec-toggle-info">
        <span class="sec-toggle-label">允许系统级工具</span>
        <span class="sec-toggle-desc">开启后不再拦截下列高风险管理命令前缀</span>
      </div>
      <label class="sec-switch">
        <input type="checkbox" id="sec-sys-tools-toggle" ${enabled ? 'checked' : ''} />
        <span class="sec-switch-slider"></span>
      </label>
    </div>

    <div class="sec-blocked-tools" id="sec-blocked-tools-wrap" style="${enabled ? 'display:none' : ''}">
      <label class="sec-list-label">关闭时拦截的工具前缀</label>
      <div class="sec-chip-list">
        ${blocked.map((t) => `<span class="sec-chip">${escHtml(t)}</span>`).join('')}
      </div>
    </div>
  </div>`
}

function auditSectionHtml(records) {
  const list = Array.isArray(records) ? records : []
  const hasRecords = list.length > 0
  const rows = hasRecords
    ? list
        .slice(0, 200)
        .map((r) => {
          const badge = auditBadge(r.event_type)
          return `
      <tr class="sec-audit-row">
        <td><span class="sec-audit-badge ${badge.cls}">${escHtml(badge.text)}</span></td>
        <td class="sec-audit-path" title="${escAttr(r.path)}">${escHtml(r.path || '—')}</td>
        <td>${escHtml(r.tool_name || '—')}</td>
        <td class="sec-audit-reason" title="${escAttr(r.reason)}">${escHtml(r.reason || '—')}</td>
        <td class="sec-audit-time">${escHtml(fmtTime(r.created_at))}</td>
      </tr>`
        })
        .join('')
    : ''

  return `
  <div class="config-section" id="sec-audit">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      审计中心
    </div>
    <p class="form-hint">路径/策略拦截记录（应用层）。OS 沙箱拒绝目前主要体现在命令输出里。</p>

    <div class="sec-audit-toolbar">
      <button type="button" class="cron-btn sm" id="sec-audit-refresh">刷新</button>
      <button type="button" class="cron-btn sm" id="sec-audit-export">导出日志</button>
      <button type="button" class="cron-btn sm" id="sec-audit-clear">清空记录</button>
      <span class="sec-audit-count">${list.length} 条记录</span>
    </div>

    ${
      hasRecords
        ? `<div class="sec-audit-table-wrap">
        <table class="sec-audit-table">
          <thead><tr><th>类型</th><th>路径</th><th>工具</th><th>原因</th><th>时间</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
        : `<div class="sec-audit-empty"><p>暂无拦截/放行记录</p></div>`
    }
  </div>`
}

function pageHtml(s, auditRecords, grantAllDefault) {
  return `
    <div class="settings-modal-pane settings-modal-pane--security settings-embed-wrap" id="sec-root-inner">
      <div class="sec-page-header">
        <h2 class="sec-page-title">安全中心</h2>
        <p class="sec-page-subtitle">OS 沙箱、新对话默认权限、终端命令策略与审计</p>
      </div>
      ${executionSectionHtml(s)}
      ${chatDefaultApprovalSectionHtml(grantAllDefault)}
      ${policySectionHtml(s)}
      ${systemToolsSectionHtml(s)}
      ${auditSectionHtml(auditRecords)}
    </div>`
}

function collectTextareaLines(root, id) {
  const el = root.querySelector(`#${id}`)
  if (!(el instanceof HTMLTextAreaElement)) return []
  return el.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function collectExecutionPatch(root) {
  const enabledEl = root.querySelector('#sec-exec-enabled')
  const autoEl = root.querySelector('#sec-exec-auto')
  const approvalEl = root.querySelector('#sec-exec-approval')
  const profileEl = root.querySelector('input[name="sec-exec-profile"]:checked')
  return {
    enabled: enabledEl instanceof HTMLInputElement ? enabledEl.checked : false,
    auto_enable_when_helpers_ready: autoEl instanceof HTMLInputElement ? autoEl.checked : true,
    profile: profileEl instanceof HTMLInputElement ? profileEl.value : 'workspace',
    approval: approvalEl instanceof HTMLSelectElement ? approvalEl.value : 'on-request',
  }
}

function collectPolicyPatch(root) {
  return {
    sandbox: {
      command_security: {
        allow_prefixes: collectTextareaLines(root, 'sec-cmd-allow'),
        prompt_prefixes: collectTextareaLines(root, 'sec-cmd-prompt'),
      },
    },
  }
}

function syncExecutionUiEnabled(_root) {
  // Profile / approval stay editable as global fallbacks; chat session presets override them.
}

function applyExecutionStatus(root, ex) {
  if (!_settings) _settings = {}
  _settings.execution_security = ex
  const section = root.querySelector('#sec-execution')
  if (section instanceof HTMLElement) {
    section.outerHTML = executionSectionHtml(_settings)
  }
}

async function saveExecution(root) {
  const btn = root.querySelector('#sec-save-execution')
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = true
    btn.textContent = '保存中…'
  }
  try {
    const patch = collectExecutionPatch(root)
    const ex = await patchExecutionSecurity(patch)
    if (!!ex.enabled !== !!patch.enabled) {
      throw new Error('保存未生效：服务端仍返回未开启，请确认 Gateway 已重启加载最新代码')
    }
    if (!!ex.auto_enable_when_helpers_ready !== !!patch.auto_enable_when_helpers_ready) {
      throw new Error('保存未生效：自动启用开关未写入，请确认 Gateway 已重启加载最新代码')
    }
    applyExecutionStatus(root, ex)
    const mode = String(ex?.mode || '')
    const autoOn = !!ex.auto_enable_when_helpers_ready
    toast(
      mode === 'sandboxed'
        ? autoOn && !ex.enabled
          ? '已保存 · OS 沙箱自动生效中'
          : '已保存 · OS 沙箱生效'
        : patch.enabled || autoOn
          ? `已保存 · 当前模式：${MODE_LABELS[mode]?.text || mode}`
          : '已保存 · OS 沙箱已关闭',
      'success',
    )
  } catch (err) {
    toast(String(err?.message || err) || '保存失败', 'error')
  } finally {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false
      btn.textContent = '保存'
    }
  }
}

async function saveChatDefaultApproval(root) {
  const el = root.querySelector('#sec-chat-grant-all-default')
  if (!(el instanceof HTMLInputElement)) return
  const policy = el.checked ? TOOL_APPROVAL_POLICY_GRANT_ALL : TOOL_APPROVAL_POLICY_SESSION
  try {
    await patchGlobalToolApprovalPolicy(policy)
    toast(
      el.checked ? '新对话默认：完全访问（不询问）' : '新对话默认：帮我批准（风险操作询问）',
      'success',
    )
  } catch (err) {
    toast(String(err?.message || err) || '保存失败', 'error')
    await renderChatDefaultApproval(root)
  }
}

async function renderChatDefaultApproval(root) {
  const el = root.querySelector('#sec-chat-grant-all-default')
  if (!(el instanceof HTMLInputElement)) return
  try {
    await fetchGlobalToolApprovalPolicy()
  } catch {
    /* Gateway 未就绪时沿用缓存 */
  }
  el.checked = isToolApprovalDisabled(getCachedGlobalToolApprovalPolicy())
}

async function savePolicy(root) {
  const btn = root.querySelector('#sec-save-policy')
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = true
    btn.textContent = '保存中…'
  }
  try {
    _settings = await patchSecuritySettings(collectPolicyPatch(root))
    toast('命令策略已保存', 'success')
  } catch (err) {
    toast(String(err?.message || err) || '保存失败', 'error')
  } finally {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false
      btn.textContent = '保存命令策略'
    }
  }
}

async function toggleSystemTools(root) {
  const el = root.querySelector('#sec-sys-tools-toggle')
  if (!(el instanceof HTMLInputElement)) return
  const wrap = root.querySelector('#sec-blocked-tools-wrap')
  try {
    _settings = await patchSecuritySettings({ system_tools: { enabled: el.checked } })
    if (wrap instanceof HTMLElement) wrap.style.display = el.checked ? 'none' : ''
    toast(el.checked ? '系统级工具已允许' : '系统级工具已拦截', 'success')
  } catch (err) {
    toast(String(err?.message || err) || '操作失败', 'error')
    el.checked = !el.checked
  }
}

async function refreshAudit(root) {
  const btn = root.querySelector('#sec-audit-refresh')
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = true
    btn.textContent = '加载中…'
  }
  try {
    const data = await fetchSecurityAudit({ limit: 500 })
    _auditRecords = data?.records || []
    const auditEl = root.querySelector('#sec-audit')
    if (auditEl instanceof HTMLElement) auditEl.outerHTML = auditSectionHtml(_auditRecords)
    toast(`已加载 ${_auditRecords.length} 条记录`, 'success')
  } catch (err) {
    toast(String(err?.message || err) || '加载失败', 'error')
  } finally {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false
      btn.textContent = '刷新'
    }
  }
}

async function handleClearAudit(root) {
  if (!confirm('确认清空所有审计记录？此操作不可撤销。')) return
  try {
    const result = await clearSecurityAudit()
    toast(`已清空 ${result?.deleted ?? 0} 条记录`, 'success')
    await refreshAudit(root)
  } catch (err) {
    toast(String(err?.message || err) || '清空失败', 'error')
  }
}

async function handleExportAudit() {
  try {
    await exportSecurityAudit()
  } catch (err) {
    toast(String(err?.message || err) || '导出失败', 'error')
  }
}

function bindEvents(root) {
  root.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    if (target.closest('#sec-save-execution')) {
      void saveExecution(root)
      return
    }
    if (target.closest('#sec-save-policy')) {
      void savePolicy(root)
      return
    }
    if (target.closest('#sec-audit-refresh')) {
      void refreshAudit(root)
      return
    }
    if (target.closest('#sec-audit-export')) {
      void handleExportAudit()
      return
    }
    if (target.closest('#sec-audit-clear')) {
      void handleClearAudit(root)
    }
  })

  root.addEventListener('change', (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return
    if (target.id === 'sec-exec-enabled' || target.id === 'sec-exec-auto') {
      syncExecutionUiEnabled(root)
      return
    }
    if (target.id === 'sec-chat-grant-all-default') {
      void saveChatDefaultApproval(root)
      return
    }
    if (target.name === 'sec-exec-profile') {
      root.querySelectorAll('.sec-profile-card').forEach((card) => {
        const input = card.querySelector('input[name="sec-exec-profile"]')
        card.classList.toggle('is-selected', input instanceof HTMLInputElement && input.checked)
      })
      return
    }
    if (target.id === 'sec-sys-tools-toggle') {
      void toggleSystemTools(root)
    }
  })
}

export function cleanup() {
  _root = null
  _settings = null
  _auditRecords = null
  _grantAllDefault = false
}

/** @param {HTMLElement} container */
export async function mountSecurityInto(container) {
  cleanup()
  _root = container
  container.classList.add('settings-modal-pane--security', 'settings-embed-wrap')
  // Paint chrome first so the tab does not sit on a spinner while audit (≤500) loads.
  container.innerHTML = pageHtml({}, [], false)
  bindEvents(container)

  try {
    const [settingsData, auditData, _approval] = await Promise.all([
      fetchSecuritySettings(),
      fetchSecurityAudit({ limit: 100 }).catch(() => ({ records: [] })),
      fetchGlobalToolApprovalPolicy().catch(() => null),
    ])
    _settings = settingsData?.settings || {}
    _auditRecords = auditData?.records || []
    try {
      _grantAllDefault = isToolApprovalDisabled(getCachedGlobalToolApprovalPolicy())
    } catch {
      _grantAllDefault = false
    }
    if (!container.isConnected) return
    container.innerHTML = pageHtml(_settings, _auditRecords, _grantAllDefault)
    bindEvents(container)
  } catch (err) {
    if (!container.isConnected) return
    container.innerHTML = `<p class="form-hint" style="color:var(--danger)">加载失败：${escHtml(err?.message || err)}</p>`
  }
}
