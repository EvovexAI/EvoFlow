/**
 * Shared「编辑岗位」sheet for roster + employee detail pages.
 */
import { api, getGatewayBaseUrl } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { filterChatModels } from './model-classification.js'
import { mountAgentAvatar } from './mount-agent-ui.js'
import {
  loadWorkspacePaths,
  renderWorkspaceField,
  bindWorkspaceSelect,
  readWorkspacePath,
  pathBasename,
} from './workspace-field-ui.js'
import {
  createSchedulePanel,
  roleScheduleExpr,
  roleScheduleSummary,
} from './schedule-panel.js'

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const AUTONOMY_HINTS = {
  full_auto:
    '本岗结案并指定下游后：仅「极高风险」须你审核才派发；低/中/高风险自动派下游。是否挂审由你在此配置，不由员工自行决定。',
  approval_for_risky:
    '本岗结案并指定下游后：中风险及以上须你审核才派发；低风险自动派下游。是否挂审由你在此配置，不由员工自行决定。',
  approval_for_all:
    '本岗结案并指定下游后：一律须你审核才派发。是否挂审由你在此配置，不由员工自行决定。',
}

const AUTONOMY_LABELS = {
  full_auto: '全自动',
  approval_for_risky: '平衡型',
  approval_for_all: '谨慎型',
}

const THINK_MODE_LABELS = {
  agent_loop: '深度工作',
  prompt_only: '轻量工作',
}

const BUDGET_POLICY_LABELS = {
  skip_patrol: '超额后跳过上班并通知',
  pause_role: '超额后暂停岗位',
  notify_only: '超额后仅通知仍可上班',
}

function parseLines(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function prettyRrule(rrule) {
  return roleScheduleSummary({ heartbeat_schedule: rrule, schedule_summary: '' })
}

async function loadKnowledgeVaults() {
  try {
    const res = await api.listKnowledgeVaults()
    const rows = Array.isArray(res?.vaults)
      ? res.vaults
      : Array.isArray(res)
        ? res
        : Array.isArray(res?.items)
          ? res.items
          : []
    return rows
      .map((v) => ({
        id: String(v?.id || '').trim(),
        name: String(v?.name || v?.id || '').trim(),
        enabled: v?.enabled !== false,
      }))
      .filter((v) => v.id)
  } catch {
    return []
  }
}

function readKnowledgeVaultIds(overlay) {
  return Array.from(
    overlay.querySelectorAll('[data-name="knowledge_vault_ids"] input[type="checkbox"]:checked'),
  )
    .map((el) => String(el.value || '').trim())
    .filter(Boolean)
}

function renderKnowledgeVaultField(vaults, selectedIds) {
  const selected = new Set((selectedIds || []).map((x) => String(x || '').trim()).filter(Boolean))
  if (!vaults.length) {
    return `
      <div class="hire-field">
        <span>绑定知识库</span>
        <p class="hire-chip-hint">暂无知识库。可在「知识库」页创建后回来绑定（支持多选）。</p>
      </div>`
  }
  return `
    <div class="hire-field">
      <span>绑定知识库</span>
      <p class="hire-chip-hint">可多选。绑定后值班系统提示会注入这些库，员工应优先用 knowledge 检索。</p>
      <div class="hire-vault-list" data-name="knowledge_vault_ids">
        ${vaults
          .map((v) => {
            const on = selected.has(v.id)
            const flag = v.enabled ? '' : '（已停用）'
            return `<label class="hire-vault-item">
              <input type="checkbox" value="${esc(v.id)}"${on ? ' checked' : ''}>
              <span class="hire-vault-item-text">${esc(v.name || v.id)}${esc(flag)}</span>
              <span class="hire-vault-item-id">${esc(v.id)}</span>
            </label>`
          })
          .join('')}
      </div>
    </div>`
}

async function loadChatModels() {
  try {
    const data = await api.listModels()
    const rows = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []
    const seen = new Set()
    const out = []
    for (const m of filterChatModels(rows)) {
      const name = String(m?.name || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const display = String(m?.display_name || name).trim() || name
      out.push({ name, display })
    }
    return out
  } catch {
    return []
  }
}

function renderHireDdOptions(items, selectedValue) {
  return items
    .map((it) => {
      const value = String(it.value || '')
      const name = String(it.name || value)
      const sub = String(it.sub || '')
      const on = value === selectedValue
      return `
        <li role="option" class="hire-dd-option${on ? ' is-on' : ''}" data-value="${esc(value)}" data-name="${esc(name)}" aria-selected="${on ? 'true' : 'false'}">
          <span class="hire-dd-option-name">${esc(name)}</span>
          ${sub ? `<span class="hire-dd-option-path">${esc(sub)}</span>` : ''}
        </li>`
    })
    .join('')
}

function bindHireDropdown(overlay, { role, onPick, labelFor } = {}) {
  const dd = overlay.querySelector(`[data-role="${role}"]`)
  if (!dd) return
  const trigger = dd.querySelector('[data-act="dd-toggle"]')
  const menu = dd.querySelector('.hire-dd-menu')
  const hidden = dd.querySelector('input[type="hidden"]')
  const labelEl = dd.querySelector('[data-role="dd-label"]')
  if (!trigger || !menu || !hidden) return

  const close = () => {
    menu.hidden = true
    dd.classList.remove('is-open')
    menu.classList.remove('is-fixed')
    trigger.setAttribute('aria-expanded', 'false')
  }
  const open = () => {
    const r = trigger.getBoundingClientRect()
    menu.style.top = `${Math.round(r.bottom + 6)}px`
    menu.style.left = `${Math.round(r.left)}px`
    menu.style.width = `${Math.round(r.width)}px`
    menu.classList.add('is-fixed')
    menu.hidden = false
    dd.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
  }
  const pick = (opt) => {
    const value = opt?.dataset.value || ''
    const name = opt?.dataset.name || value
    hidden.value = value
    if (labelEl) labelEl.textContent = typeof labelFor === 'function' ? labelFor(value, name) : name
    menu.querySelectorAll('.hire-dd-option').forEach((el) => {
      const on = el.dataset.value === value
      el.classList.toggle('is-on', on)
      el.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    close()
    if (typeof onPick === 'function') onPick(value, name, opt)
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (menu.hidden) open()
    else close()
  })
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.hire-dd-option')
    if (!opt) return
    e.preventDefault()
    pick(opt)
  })
  overlay.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) close()
  })
}

function renderModelField(models, selected = '') {
  const cur = String(selected || '').trim()
  const items = [
    { value: '', name: '跟随智能体默认', sub: '未配置时用 agent / 系统默认模型' },
    ...models.map((m) => ({
      value: m.name,
      name: m.display || m.name,
      sub: m.display && m.display !== m.name ? m.name : '',
    })),
  ]
  if (cur && !items.some((i) => i.value === cur)) {
    items.splice(1, 0, { value: cur, name: cur, sub: '当前配置（未在模型列表中）' })
  }
  const picked = items.find((i) => i.value === cur) || items[0]
  const label = picked?.name || '跟随智能体默认'
  return `
    <div class="hire-field">
      <span>工作 / 执行模型</span>
      <div class="hire-dd" data-role="model-dd">
        <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
          <span class="hire-dd-label" data-role="dd-label">${esc(label)}</span>
          <span class="hire-dd-chevron" aria-hidden="true"></span>
        </button>
        <ul class="hire-dd-menu" role="listbox" hidden>
          ${renderHireDdOptions(items, cur)}
        </ul>
        <input type="hidden" data-name="model_name" value="${esc(cur)}">
      </div>
      <p class="hire-chip-hint">仅作用于该岗位的自动上班与执行；留空则跟随绑定智能体的默认模型</p>
    </div>`
}

function bindModelSelect(overlay) {
  bindHireDropdown(overlay, { role: 'model-dd' })
}

function readModelName(overlay) {
  return (overlay.querySelector('input[data-name="model_name"]')?.value || '').trim()
}

function bindHireChipRows(overlay) {
  overlay.querySelectorAll('.hire-chip-row[data-name]').forEach((row) => {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.hire-chip')
      if (!chip) return
      row.querySelectorAll('.hire-chip').forEach((c) => c.classList.toggle('is-on', c === chip))
      if (row.dataset.name === 'autonomy_level') {
        const hint = overlay.querySelector('[data-autonomy-hint]')
        if (hint) hint.textContent = AUTONOMY_HINTS[chip.dataset.value] || ''
      }
    })
  })
}

function mountEditAvatars(root, size = 48, agentByCode = null) {
  if (!root) return
  void getGatewayBaseUrl()
    .then((baseUrl) => {
      root.querySelectorAll('[data-avatar-agent]').forEach((el) => {
        const code = String(el.getAttribute('data-avatar-agent') || '').trim()
        if (!code) return
        const agent = agentByCode?.get?.(code.toLowerCase()) || { agent_code: code }
        mountAgentAvatar(el, {
          agent,
          agentCode: code,
          size,
          baseUrl: baseUrl || '',
        })
      })
    })
    .catch(() => {
      root.querySelectorAll('[data-avatar-agent]').forEach((el) => {
        const code = String(el.getAttribute('data-avatar-agent') || '').trim()
        if (!code) return
        const agent = agentByCode?.get?.(code.toLowerCase()) || { agent_code: code }
        mountAgentAvatar(el, { agent, agentCode: code, size })
      })
    })
}

function renderAgentPickField(available, selectedCode) {
  const cur = available.find((a) => a.code === selectedCode) || available[0]
  const value = cur?.code || ''
  const label = cur?.name && cur.name !== cur.code ? cur.name : value
  const items = available.map((a) => ({
    value: a.code,
    name: a.name && a.name !== a.code ? a.name : a.code,
    sub: a.code,
  }))
  return `
    <div class="hire-field">
      <span>绑定智能体</span>
      <div class="hire-dd" data-role="agent-dd">
        <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
          <span class="hire-dd-label" data-role="dd-label">${esc(label || '请选择智能体')}</span>
          <span class="hire-dd-chevron" aria-hidden="true"></span>
        </button>
        <ul class="hire-dd-menu" role="listbox" hidden>
          ${renderHireDdOptions(items, value)}
        </ul>
        <input type="hidden" data-name="agent_code" value="${esc(value)}">
      </div>
      <p class="hire-chip-hint">可换成尚未确认上班的其他智能体；历史事项会跟岗位一起迁移</p>
    </div>`
}

async function loadRebindableAgents(currentCode) {
  const cur = String(currentCode || '').trim()
  let hired = new Set()
  try {
    const rolesRes = await api.proactiveListRoles()
    const list = Array.isArray(rolesRes) ? rolesRes : rolesRes?.roles || []
    hired = new Set(
      list.map((r) => String(r?.agent_code || '').trim()).filter((c) => c && c !== cur),
    )
  } catch {
    /* keep empty — still show current */
  }
  let agents = []
  try {
    agents = await api.listAgents()
  } catch (e) {
    toast('加载智能体列表失败: ' + (e?.message || e), 'error')
    return []
  }
  const out = (agents || [])
    .map((a) => ({
      code: String(a.agent_code || a.name || '').trim(),
      name: String(a.agent_name || a.name || a.agent_code || '').trim(),
      avatar: a.avatar || null,
      avatar_meta: a.avatar_meta || null,
      has_avatar_file: a.has_avatar_file,
      agent_code: String(a.agent_code || a.name || '').trim(),
      agent_name: String(a.agent_name || a.name || a.agent_code || '').trim(),
    }))
    .filter((a) => a.code && !hired.has(a.code))
  if (cur && !out.some((a) => a.code === cur)) {
    out.unshift({ code: cur, name: cur, agent_code: cur, agent_name: cur })
  }
  return out
}

/**
 * @param {object} role
 * @param {{ onSaved?: (updated?: object) => void | Promise<void> }} [opts]
 */
export async function showEditRoleModal(role, { onSaved } = {}) {
  if (!role) return
  const cfg = role.config || {}
  const autonomy = cfg.autonomy_level || 'approval_for_risky'
  const thinkMode = cfg.think_mode || 'agent_loop'
  const resp = Array.isArray(cfg.responsibilities) ? cfg.responsibilities.join('\n') : ''
  const domain = Array.isArray(cfg.domain_scope) ? cfg.domain_scope.join('\n') : ''
  const workspacePath = String(cfg.workspace_path || '').trim()
  const modelName = String(cfg.model_name || '').trim()
  const currentReportsTo = String(role.reports_to || cfg.reports_to || '').trim()
  const selectedVaultIds = Array.isArray(cfg.knowledge_vault_ids) ? cfg.knowledge_vault_ids : []
  const dailyBudget = Number(cfg.daily_budget_usd || 0) || 0
  const perRunBudget = Number(cfg.per_run_budget_usd || 0) || 0
  const budgetPolicy = String(cfg.budget_exceed_policy || 'skip_patrol').trim() || 'skip_patrol'
  const [workspacePaths, chatModels, available, peerRoles, knowledgeVaults] = await Promise.all([
    loadWorkspacePaths(),
    loadChatModels(),
    loadRebindableAgents(role.agent_code),
    api
      .proactiveListRoles()
      .then((res) => (Array.isArray(res) ? res : res?.roles || []))
      .catch(() => []),
    loadKnowledgeVaults(),
  ])
  if (!available.length) {
    toast('没有可绑定的智能体', 'warning')
    return
  }
  const selfCode = String(role.agent_code || '').trim()
  const managerOptions = (peerRoles || [])
    .filter((r) => {
      const c = String(r?.agent_code || '').trim()
      return c && c !== selfCode && String(r?.status || '') !== 'archived'
    })
    .map((r) => {
      const c = String(r.agent_code || '').trim()
      const n = String(r.role_name || c).trim()
      const sel = c === currentReportsTo ? ' selected' : ''
      return `<option value="${esc(c)}"${sel}>${esc(n)} · ${esc(c)}</option>`
    })
    .join('')
  let selected = available.find((a) => a.code === role.agent_code) || available[0]
  const agentByCode = new Map(available.map((a) => [a.code.toLowerCase(), a]))
  const scheduleCtrl = createSchedulePanel({
    schedule: roleScheduleExpr(role),
    idPrefix: 'proSched',
  })

  const renderAgentCard = () => `
      <div class="hire-agent-card" data-role="agent-card">
        <div class="hire-agent-avatar" data-avatar-agent="${esc(selected.code)}" aria-hidden="true"></div>
        <div class="hire-agent-meta">
          <div class="hire-agent-name">${esc(selected.name || selected.code)}</div>
          <div class="hire-agent-code">${esc(selected.code)}</div>
        </div>
        <span class="hire-agent-pill">${selected.code === role.agent_code ? '当前绑定' : '将改绑'}</span>
      </div>`

  const sections = [
    { key: 'basic', label: '基本信息' },
    { key: 'duty', label: '职责与汇报' },
    { key: 'capability', label: '能力与知识' },
    { key: 'strategy', label: '工作策略' },
    { key: 'schedule', label: '成本预算' },
  ]

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay hire-overlay'
  overlay.innerHTML = `
    <div class="hire-sheet hire-sheet--edit" role="dialog" aria-labelledby="hire-sheet-title">
      <header class="hire-sheet-head">
        <div>
          <p class="hire-sheet-kicker">智能体员工</p>
          <h2 id="hire-sheet-title" class="hire-sheet-title">编辑岗位</h2>
        </div>
        <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
      </header>

      <div class="hire-sheet-body" style="padding-top:12px">
        <div class="hire-edit-layout">
          <nav class="hire-edit-nav" aria-label="编辑分区">
            ${sections
              .map(
                (s, i) =>
                  `<button type="button" class="hire-edit-nav-btn${i === 0 ? ' is-active' : ''}" data-act="edit-section" data-section="${s.key}">${s.label}</button>`,
              )
              .join('')}
          </nav>
          <div class="hire-edit-panels">
            <div class="hire-edit-panel" data-section="basic">
              <p class="hire-chip-hint">可改绑智能体；工具与人设请到「智能体」页修改。</p>
              ${renderAgentPickField(available, selected.code)}
              ${renderAgentCard()}
              <div class="hire-field-row">
                <label class="hire-field">
                  <span>岗位名称</span>
                  <input class="hire-input" data-name="role_name" value="${esc(role.role_name || '')}" placeholder="岗位显示名">
                </label>
                <label class="hire-field">
                  <span>部门</span>
                  <input class="hire-input" data-name="department" value="${esc(role.department || '')}" placeholder="可选">
                </label>
              </div>
            </div>

            <div class="hire-edit-panel hire-edit-panel--duty" data-section="duty" hidden>
              <label class="hire-field">
                <span>直属上级</span>
                <select class="hire-input" data-name="reports_to">
                  <option value="">（无上级 · 顶层）</option>
                  ${managerOptions}
                </select>
              </label>
              <label class="hire-field hire-field--grow">
                <span>职责</span>
                <textarea class="hire-input hire-textarea hire-textarea--duty" data-name="responsibilities" rows="12" placeholder="每行一条，写清要主动推进的事">${esc(resp)}</textarea>
              </label>
            </div>

            <div class="hire-edit-panel" data-section="capability" hidden>
              ${renderModelField(chatModels, modelName)}
              ${renderWorkspaceField(workspacePaths, workspacePath, domain)}
              ${renderKnowledgeVaultField(knowledgeVaults, selectedVaultIds)}
              <div class="hire-field">
                <span>工作方式</span>
                <div class="hire-chip-row" data-name="think_mode" role="radiogroup">
                  <button type="button" class="hire-chip${thinkMode === 'agent_loop' ? ' is-on' : ''}" data-value="agent_loop">深度工作</button>
                  <button type="button" class="hire-chip${thinkMode === 'prompt_only' ? ' is-on' : ''}" data-value="prompt_only">轻量工作</button>
                </div>
                <p class="hire-chip-hint">深度可调工具；轻量为单次 LLM</p>
              </div>
            </div>

            <div class="hire-edit-panel" data-section="strategy" hidden>
              <div class="hire-field">
                <span>转交审批策略</span>
                <div class="hire-chip-row" data-name="autonomy_level" role="radiogroup">
                  <button type="button" class="hire-chip${autonomy === 'full_auto' ? ' is-on' : ''}" data-value="full_auto">全自动</button>
                  <button type="button" class="hire-chip${autonomy === 'approval_for_risky' ? ' is-on' : ''}" data-value="approval_for_risky">平衡型</button>
                  <button type="button" class="hire-chip${autonomy === 'approval_for_all' ? ' is-on' : ''}" data-value="approval_for_all">谨慎型</button>
                </div>
                <p class="hire-chip-hint" data-autonomy-hint>${esc(AUTONOMY_HINTS[autonomy] || AUTONOMY_HINTS.approval_for_risky)}</p>
              </div>
              <div class="hire-field">
                <span>自动上班</span>
                ${scheduleCtrl.html}
                <p class="hire-chip-hint">与「自动化」任务同一套调度；手动「现在开始工作」不受限制。</p>
              </div>
            </div>

            <div class="hire-edit-panel" data-section="schedule" hidden>
              <div class="hire-budget-row">
                <label class="hire-field">
                  <span>每日预算（USD）</span>
                  <input class="hire-input" type="number" min="0" step="0.01" data-name="daily_budget_usd" value="${esc(String(dailyBudget))}" placeholder="0 = 不限">
                </label>
                <label class="hire-field">
                  <span>单次预算（USD）</span>
                  <input class="hire-input" type="number" min="0" step="0.01" data-name="per_run_budget_usd" value="${esc(String(perRunBudget))}" placeholder="0 = 不限">
                </label>
              </div>
              <label class="hire-field">
                <span>超额处理策略</span>
                <select class="hire-input" data-name="budget_exceed_policy">
                  <option value="skip_patrol"${budgetPolicy === 'skip_patrol' ? ' selected' : ''}>${esc(BUDGET_POLICY_LABELS.skip_patrol)}</option>
                  <option value="pause_role"${budgetPolicy === 'pause_role' ? ' selected' : ''}>${esc(BUDGET_POLICY_LABELS.pause_role)}</option>
                  <option value="notify_only"${budgetPolicy === 'notify_only' ? ' selected' : ''}>${esc(BUDGET_POLICY_LABELS.notify_only)}</option>
                </select>
                <p class="hire-chip-hint">每日预算在上班开始前检查；单次预算在本轮结束后检查。</p>
              </label>
            </div>
          </div>
        </div>
      </div>

      <footer class="hire-sheet-foot">
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">取消</button>
        <button type="button" class="btn btn-sm hire-confirm" data-act="confirm">保存岗位</button>
      </footer>
    </div>
  `
  document.body.appendChild(overlay)
  mountEditAvatars(overlay, 48, agentByCode)

  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelectorAll('[data-act="close"]').forEach((el) => el.addEventListener('click', close))
  bindHireChipRows(overlay)
  bindModelSelect(overlay)
  bindWorkspaceSelect(overlay)
  scheduleCtrl.initEvents()

  overlay.querySelectorAll('[data-act="edit-section"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-section')
      overlay.querySelectorAll('[data-act="edit-section"]').forEach((b) => {
        b.classList.toggle('is-active', b === btn)
      })
      overlay.querySelectorAll('.hire-edit-panel').forEach((p) => {
        p.hidden = p.getAttribute('data-section') !== key
      })
    })
  })

  const syncAgentCard = () => {
    const card = overlay.querySelector('[data-role="agent-card"]')
    if (!card) return
    const wrap = document.createElement('div')
    wrap.innerHTML = renderAgentCard().trim()
    card.replaceWith(wrap.firstElementChild)
    mountEditAvatars(overlay, 48, agentByCode)
  }

  bindHireDropdown(overlay, {
    role: 'agent-dd',
    onPick: (code) => {
      const next = available.find((a) => a.code === code)
      if (!next) return
      selected = next
      syncAgentCard()
    },
  })

  overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', async () => {
    const role_name = (overlay.querySelector('[data-name="role_name"]')?.value || '').trim()
    if (!role_name) {
      toast('请填写岗位名称', 'warning')
      return
    }
    const workspace_path = readWorkspacePath(overlay)
    const nextAgent =
      (overlay.querySelector('input[data-name="agent_code"]')?.value || '').trim() || selected.code
    const responsibilities = parseLines(overlay.querySelector('[data-name="responsibilities"]')?.value)
    const domain_scope = parseLines(overlay.querySelector('[data-name="domain_scope"]')?.value)
    const autonomy_level =
      overlay.querySelector('[data-name="autonomy_level"] .hire-chip.is-on')?.dataset.value ||
      'approval_for_risky'
    const heartbeat_schedule = scheduleCtrl.getSchedule().cronExpr || roleScheduleExpr(role)
    const think_mode =
      overlay.querySelector('[data-name="think_mode"] .hire-chip.is-on')?.dataset.value || 'agent_loop'
    const model_name = readModelName(overlay)
    const nextDaily = Number(overlay.querySelector('[data-name="daily_budget_usd"]')?.value || 0) || 0
    const nextPerRun = Number(overlay.querySelector('[data-name="per_run_budget_usd"]')?.value || 0) || 0
    const nextPolicy =
      (overlay.querySelector('[data-name="budget_exceed_policy"]')?.value || '').trim() || 'skip_patrol'
    const department = (overlay.querySelector('[data-name="department"]')?.value || '').trim()
    const reports_to = (overlay.querySelector('[data-name="reports_to"]')?.value || '').trim()
    const knowledge_vault_ids = readKnowledgeVaultIds(overlay)

    const changes = []
    if (role_name !== String(role.role_name || '')) changes.push(`岗位名称：${role.role_name || '—'} → ${role_name}`)
    if (department !== String(role.department || '')) changes.push(`部门：${role.department || '—'} → ${department || '—'}`)
    if (nextAgent !== role.agent_code) changes.push(`绑定智能体：${role.agent_code} → ${nextAgent}`)
    if (reports_to !== currentReportsTo) changes.push(`直属上级：${currentReportsTo || '无'} → ${reports_to || '无'}`)
    if (responsibilities.join('\n') !== parseLines(resp).join('\n')) changes.push('职责已修改')
    if (workspace_path !== workspacePath) {
      changes.push(
        `工作空间：${pathBasename(workspacePath) || '默认'} → ${pathBasename(workspace_path) || '默认'}`,
      )
    }
    if (domain_scope.join('\n') !== parseLines(domain).join('\n')) changes.push('关注子路径已修改')
    if (JSON.stringify(knowledge_vault_ids) !== JSON.stringify(selectedVaultIds)) changes.push('知识库关联已修改')
    if (model_name !== modelName) changes.push(`工作模型：${modelName || '默认'} → ${model_name || '默认'}`)
    if (think_mode !== thinkMode) changes.push(`工作方式：${THINK_MODE_LABELS[thinkMode] || thinkMode} → ${THINK_MODE_LABELS[think_mode] || think_mode}`)
    if (autonomy_level !== autonomy) {
      changes.push(
        `审批策略：${AUTONOMY_LABELS[autonomy] || autonomy} → ${AUTONOMY_LABELS[autonomy_level] || autonomy_level}`,
      )
    }
    if (heartbeat_schedule !== roleScheduleExpr(role)) {
      changes.push(
        `自动上班：${roleScheduleSummary(role)} → ${prettyRrule(heartbeat_schedule)}`,
      )
    }
    if (nextDaily !== dailyBudget) changes.push(`每日预算：$${dailyBudget} → $${nextDaily}`)
    if (nextPerRun !== perRunBudget) changes.push(`单次预算：$${perRunBudget} → $${nextPerRun}`)
    if (nextPolicy !== budgetPolicy) {
      changes.push(
        `超额策略：${BUDGET_POLICY_LABELS[budgetPolicy] || budgetPolicy} → ${BUDGET_POLICY_LABELS[nextPolicy] || nextPolicy}`,
      )
    }

    if (!changes.length) {
      toast('没有变更', 'info')
      return
    }

    const btn = overlay.querySelector('[data-act="confirm"]')
    if (btn) {
      btn.disabled = true
      btn.textContent = '保存中…'
    }
    try {
      const busyRes = await api.proactiveRoleBusy(role.agent_code).catch(() => ({ busy: false }))
      const impactKeys = ['自动上班', '每日预算', '审批策略', '工作模型', '工作空间', '绑定智能体']
      const impactsRunning = changes.some((c) => impactKeys.some((k) => c.includes(k)))
      let summary = `将保存以下变更：\n\n${changes.map((c) => `· ${c}`).join('\n')}`
      if (busyRes?.busy || (role.status === 'active' && impactsRunning)) {
        summary =
          '该员工可能正在运行或即将自动上班，配置变更将影响后续轮次。\n\n' + summary
      }
      const contSave = await showConfirm(`${summary}\n\n确认保存？`)
      if (!contSave) {
        if (btn) {
          btn.disabled = false
          btn.textContent = '保存岗位'
        }
        return
      }

      const overlapCode = nextAgent || role.agent_code
      const overlap = await api
        .proactiveCheckOverlap({
          agent_code: overlapCode,
          exclude_agent_code: role.agent_code,
          responsibilities,
          domain_scope,
          role_name,
        })
        .catch(() => null)
      if (overlap?.has_overlap && overlap.warning) {
        const cont = await showConfirm(`${overlap.warning}\n\n仍要保存？`)
        if (!cont) {
          if (btn) {
            btn.disabled = false
            btn.textContent = '保存岗位'
          }
          return
        }
      }
      if (nextAgent && nextAgent !== role.agent_code) {
        const cont = await showConfirm(
          `将岗位改绑到智能体「${nextAgent}」？\n\n历史工作项会迁移；旧工作过程会话键仍保留在原智能体下。`,
        )
        if (!cont) {
          if (btn) {
            btn.disabled = false
            btn.textContent = '保存岗位'
          }
          return
        }
      }
      const payload = {
        role_name,
        department,
        reports_to,
        responsibilities,
        workspace_path,
        domain_scope,
        knowledge_vault_ids,
        autonomy_level,
        heartbeat_schedule,
        think_mode,
        model_name,
        daily_budget_usd: nextDaily,
        per_run_budget_usd: nextPerRun,
        budget_exceed_policy: nextPolicy,
      }
      if (nextAgent && nextAgent !== role.agent_code) {
        payload.new_agent_code = nextAgent
      }
      const updated = await api.proactiveUpdateRole(role.agent_code, payload)
      toast('岗位已更新', 'success')
      close()
      if (typeof onSaved === 'function') await onSaved(updated)
    } catch (e) {
      toast('更新失败: ' + (e?.message || e), 'error')
      if (btn) {
        btn.disabled = false
        btn.textContent = '保存岗位'
      }
    }
  })
}

export {
  loadKnowledgeVaults,
  readKnowledgeVaultIds,
  renderKnowledgeVaultField,
}
