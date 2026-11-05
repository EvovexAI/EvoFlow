/**
 * Shared「编辑岗位」sheet for roster + employee detail pages.
 */
import { api, getGatewayBaseUrl } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { filterChatModels } from './model-classification.js'
import { mountAgentAvatarPicker, unmountAgentUi } from './mount-agent-ui.js'
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
import {
  AUTONOMY_EDIT_OPTIONS,
  AUTONOMY_FIELD_DESC,
  AUTONOMY_FIELD_LABEL,
  AUTONOMY_HINTS,
  AUTONOMY_LABELS,
  autonomyHint,
  renderAutonomyChips,
} from './proactive-autonomy-ui.js'

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

/**
 * 知识库用法：只暴露「怎么用」三档，高级检索参数不进表单（保存时原样保留）。
 * @param {object|null} existingConfig
 */
function renderKbInjectionField(existingConfig = null) {
    const cfg = existingConfig || {}
    let mode = String(cfg.mode || 'auto')
    // both 对普通用户难懂：界面归到「自动查阅」，但未改选前保存仍保留 both（见 read）
    const uiMode = mode === 'both' ? 'auto' : mode
    if (!['auto', 'agent', 'off'].includes(uiMode)) mode = 'auto'

    const modeOpts = [
        {
            value: 'auto',
            label: '自动查阅',
            hint: '推荐。每次回答前系统先从绑定库找相关内容，员工直接带着资料答。',
        },
        {
            value: 'agent',
            label: '按需查阅',
            hint: '不问则不查。员工判断需要时再自己去搜知识库。',
        },
        {
            value: 'off',
            label: '不使用',
            hint: '本岗不查知识库（即便下面勾选了库也不会注入）。',
        },
    ]

    return `
      <div class="hire-field" data-section="kb-injection">
        <span>怎么用知识库</span>
        <p class="hire-chip-hint">选一种即可。条数、算法等高级参数沿用系统默认，无需手调。</p>
        <input type="hidden" data-name="kb_injection_mode" value="${esc(mode === 'both' ? 'both' : uiMode)}">
        <div class="hire-chip-row hire-kb-mode-row" data-name="kb_injection_mode" role="radiogroup">
          ${modeOpts
            .map(
              (o) =>
                `<button type="button" class="hire-chip hire-kb-mode-chip${o.value === uiMode ? ' is-on' : ''}" data-value="${esc(o.value)}" title="${esc(o.hint)}">${esc(o.label)}</button>`,
            )
            .join('')}
        </div>
        <p class="hire-chip-hint" data-role="kb-mode-hint">${esc(
          modeOpts.find((o) => o.value === uiMode)?.hint || modeOpts[0].hint,
        )}</p>
      </div>`
}

/**
 * @param {HTMLElement} overlay
 * @param {object} [existingConfig] 未在简化表单中暴露的字段原样保留
 */
function readKbInjectionConfig(overlay, existingConfig = {}) {
    const prev = existingConfig && typeof existingConfig === 'object' ? { ...existingConfig } : {}
    const get = (n) => overlay.querySelector(`[data-name="${n}"]`)
    const modeEl = get('kb_injection_mode')
    const mode = (modeEl?.value || prev.mode || 'auto').trim() || 'auto'
    return {
        mode,
        top_k: Number.isFinite(Number(prev.top_k)) ? Number(prev.top_k) : 24,
        agent_top_k: Number.isFinite(Number(prev.agent_top_k)) ? Number(prev.agent_top_k) : 12,
        score_threshold: Number.isFinite(Number(prev.score_threshold))
            ? Number(prev.score_threshold)
            : 0.0,
        max_inject_tokens: Number.isFinite(Number(prev.max_inject_tokens))
            ? Number(prev.max_inject_tokens)
            : 12000,
        recall_multiplier: Number.isFinite(Number(prev.recall_multiplier))
            ? Number(prev.recall_multiplier)
            : 6,
        retrieval: String(prev.retrieval || 'hybrid'),
        bm25_weight: Number.isFinite(Number(prev.bm25_weight)) ? Number(prev.bm25_weight) : 0.3,
        reranker: String(prev.reranker || 'none'),
        timeout_sec: Number.isFinite(Number(prev.timeout_sec)) ? Number(prev.timeout_sec) : 8,
        on_failure: String(prev.on_failure || 'ignore'),
        mount_platform_tools: prev.mount_platform_tools === true,
    }
}

function bindKbInjectionChipRows(overlay) {
    const hints = {
        auto: '推荐。每次回答前系统先从绑定库找相关内容，员工直接带着资料答。',
        agent: '不问则不查。员工判断需要时再自己去搜知识库。',
        off: '本岗不查知识库（即便下面勾选了库也不会注入）。',
    }
    overlay
        .querySelectorAll('[data-section="kb-injection"] .hire-chip-row[data-name]')
        .forEach((row) => {
            row.addEventListener('click', (e) => {
                const chip = e.target.closest('.hire-chip')
                if (!chip) return
                const value = chip.dataset.value || ''
                row.querySelectorAll('.hire-chip').forEach((c) => c.classList.toggle('is-on', c === chip))
                const hidden = overlay.querySelector(`input[data-name="${row.dataset.name}"]`)
                if (hidden) hidden.value = value
                const hintEl = overlay.querySelector('[data-role="kb-mode-hint"]')
                if (hintEl && hints[value]) hintEl.textContent = hints[value]
            })
        })
}

async function loadKnowledgeVaults() {
  try {
    const res = await api.listOwnedKnowledgeBases()
    const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : []
    return items.map((b) => ({
      id: String(b.id || '').trim(),
      name: String(b.name || b.title || b.id || '').trim(),
      enabled: b.enabled !== false,
    }))
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
        <span>绑定哪些知识库</span>
        <p class="hire-chip-hint">还没有知识库。先去侧栏「知识库」建一个，再回来勾选。</p>
      </div>`
  }
  return `
    <div class="hire-field">
      <span>绑定哪些知识库</span>
      <p class="hire-chip-hint">勾选后，本岗上班/对话可查阅这些库里的资料。可多选。</p>
      <div class="hire-vault-list" data-name="knowledge_vault_ids">
        ${vaults
          .map((v) => {
            const on = selected.has(v.id)
            const flag = v.enabled ? '' : '（已停用）'
            return `<label class="hire-vault-item">
              <input type="checkbox" value="${esc(v.id)}"${on ? ' checked' : ''}>
              <span class="hire-vault-item-text">${esc(v.name || v.id)}${esc(flag)}</span>
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

export function bindHireDropdown(overlay, { role, onPick, labelFor } = {}) {
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

/** Load department catalog for hire / edit selects. */
export async function loadDepartmentCatalog() {
  const res = await api.proactiveListDepartments().catch(() => null)
  if (Array.isArray(res?.departments)) return res.departments
  if (Array.isArray(res)) return res
  return []
}

/** Sorted unique department names; keeps current + extras (e.g. peer role labels). */
export function departmentNamesFromCatalog(departments, currentName = '', extraNames = []) {
  const names = new Set()
  for (const d of departments || []) {
    const n = String(d?.name || '').trim()
    if (n) names.add(n)
  }
  for (const x of extraNames || []) {
    const n = String(x || '').trim()
    if (n) names.add(n)
  }
  const cur = String(currentName || '').trim()
  if (cur) names.add(cur)
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/**
 * Prefer role.department; if empty, recover from catalog membership
 * (dept.members includes this agent_code).
 */
export function resolveRoleDepartment(role, cfg = {}, departments = []) {
  const fromRole = String(role?.department || cfg?.department || '').trim()
  if (fromRole) return fromRole
  const code = String(role?.agent_code || '').trim().toLowerCase()
  if (!code) return ''
  for (const d of departments || []) {
    const members = Array.isArray(d?.members) ? d.members : []
    if (members.some((m) => String(m?.agent_code || '').trim().toLowerCase() === code)) {
      return String(d?.name || '').trim()
    }
  }
  return ''
}

/**
 * Department picker — custom hire-dd (native &lt;select&gt; often won't open inside
 * Tauri / modal-overlay with overflow + backdrop-filter).
 */
export function renderDepartmentSelectControl(currentName, departments, extraNames = []) {
  const cur = String(currentName || '').trim()
  const names = departmentNamesFromCatalog(departments, cur, extraNames)
  const items = [
    { value: '', name: '未分部门', sub: '暂不归属任何部门' },
    ...names.map((n) => ({ value: n, name: n, sub: '' })),
  ]
  if (cur && !items.some((i) => i.value === cur)) {
    items.splice(1, 0, { value: cur, name: cur, sub: '当前（目录中暂无）' })
  }
  const picked = items.find((i) => i.value === cur) || items[0]
  const emptyHint = !names.length
    ? `<p class="hire-chip-hint">目录里还没有部门。可先在「组织」创建，或保存后到组织里把人加进部门。</p>`
    : ''
  return `
    <div class="hire-dd" data-role="department-dd">
      <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
        <span class="hire-dd-label" data-role="dd-label">${esc(picked?.name || '未分部门')}</span>
        <span class="hire-dd-chevron" aria-hidden="true"></span>
      </button>
      <ul class="hire-dd-menu" role="listbox" hidden>
        ${renderHireDdOptions(items, cur)}
      </ul>
      <input type="hidden" data-name="department" value="${esc(cur)}">
    </div>
    ${emptyHint}`
}

/** Direct-manager picker — same hire-dd pattern as department (native select unreliable in sheet). */
export function renderReportsToSelectControl(currentReportsTo, managerRows) {
  const cur = String(currentReportsTo || '').trim()
  const items = [
    { value: '', name: '（无上级 · 顶层）', sub: '' },
    ...(managerRows || []).map((r) => {
      const c = String(r.agent_code || '').trim()
      const n = String(r.agent_name || r.role_name || c).trim()
      return { value: c, name: n, sub: c && c !== n ? c : '' }
    }),
  ]
  if (cur && !items.some((i) => i.value === cur)) {
    items.splice(1, 0, { value: cur, name: cur, sub: '当前上级' })
  }
  const picked = items.find((i) => i.value === cur) || items[0]
  return `
    <div class="hire-dd" data-role="reports-to-dd">
      <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
        <span class="hire-dd-label" data-role="dd-label">${esc(picked?.name || '（无上级 · 顶层）')}</span>
        <span class="hire-dd-chevron" aria-hidden="true"></span>
      </button>
      <ul class="hire-dd-menu" role="listbox" hidden>
        ${renderHireDdOptions(items, cur)}
      </ul>
      <input type="hidden" data-name="reports_to" value="${esc(cur)}">
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

/** Marker used when merging legacy role responsibilities into agent system_prompt. */
export const DUTY_PROMPT_SECTION = '## 岗位职责'

/**
 * @param {string[]|string|null|undefined} responsibilities
 * @returns {string[]}
 */
export function coerceDutyLines(responsibilities) {
  if (Array.isArray(responsibilities)) {
    return responsibilities.map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (typeof responsibilities === 'string') {
    return responsibilities
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * Split agent system_prompt into body + duty lines under ``## 岗位职责``.
 * @param {string} systemPrompt
 * @returns {{ body: string, duties: string[] }}
 */
export function splitDutyFromSystemPrompt(systemPrompt) {
  const sp = String(systemPrompt || '')
  const idx = sp.indexOf(DUTY_PROMPT_SECTION)
  if (idx < 0) {
    return { body: sp.trim(), duties: [] }
  }
  const before = sp.slice(0, idx).trimEnd()
  const rest = sp.slice(idx + DUTY_PROMPT_SECTION.length)
  const nextH2 = rest.search(/\n##\s/)
  const dutyBlock = (nextH2 >= 0 ? rest.slice(0, nextH2) : rest).trim()
  const after = nextH2 >= 0 ? rest.slice(nextH2).trim() : ''
  const duties = dutyBlock
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
  const body = [before, after].filter(Boolean).join('\n\n').trim()
  return { body, duties }
}

/**
 * Write duty lines back into system_prompt (replaces existing ``## 岗位职责`` block).
 * @param {string} systemPrompt
 * @param {string[]|string|null|undefined} responsibilities
 */
export function applyDutyToSystemPrompt(systemPrompt, responsibilities) {
  const { body } = splitDutyFromSystemPrompt(systemPrompt)
  const lines = coerceDutyLines(responsibilities)
  if (!lines.length) return body
  const block = `${DUTY_PROMPT_SECTION}\n${lines.map((l) => `- ${l}`).join('\n')}`
  return body ? `${body}\n\n${block}` : block
}

/**
 * Merge legacy role responsibilities into agent system_prompt (idempotent).
 * @param {string} systemPrompt
 * @param {string[]|string|null|undefined} responsibilities
 */
export function mergeDutyIntoSystemPrompt(systemPrompt, responsibilities) {
  const sp = String(systemPrompt || '').trim()
  const lines = coerceDutyLines(responsibilities)
  if (!lines.length) return sp
  if (sp.includes(DUTY_PROMPT_SECTION)) return sp
  if (lines.every((line) => sp.includes(line))) return sp
  const block = `${DUTY_PROMPT_SECTION}\n${lines.map((l) => `- ${l}`).join('\n')}`
  return sp ? `${sp}\n\n${block}` : block
}

/** 与智能体编辑器一致：仅 workspace / optional 可勾选 */
const ROLE_EDITOR_CONFIGURABLE_TIERS = new Set(['workspace', 'optional'])

/**
 * 列表接口不含 soul；编辑前拉单条，与智能体页一致。
 * @param {string} code
 * @returns {Promise<{
 *   code: string,
 *   agent_name: string,
 *   description: string,
 *   system_prompt: string,
 *   soul: string,
 *   tools: string[]|null,
 *   mcp_servers: string[]|null,
 *   skills: string[]|null,
 *   requires_external_cli: boolean,
 *   front_desk: boolean,
 * }>}
 */
async function loadAgentDetailForEdit(code) {
  const c = String(code || '').trim()
  const empty = {
    code: '',
    agent_name: '',
    description: '',
    system_prompt: '',
    soul: '',
    avatar: null,
    avatar_meta: null,
    has_avatar_file: false,
    tools: null,
    mcp_servers: null,
    skills: null,
    requires_external_cli: false,
    front_desk: false,
  }
  if (!c) return empty
  try {
    const a = await api.getAgent(c)
    const codeOut = String(a?.agent_code || a?.name || c).trim() || c
    return {
      code: codeOut,
      agent_name: String(a?.agent_name || a?.name || c).trim() || c,
      description: String(a?.description || '').trim(),
      system_prompt: String(a?.system_prompt || ''),
      soul: String(a?.soul || ''),
      avatar: a?.avatar || null,
      avatar_meta: a?.avatar_meta || null,
      has_avatar_file: !!a?.has_avatar_file,
      tools: Array.isArray(a?.tools) ? a.tools.map(String) : null,
      mcp_servers: Array.isArray(a?.mcp_servers) ? a.mcp_servers.map(String) : null,
      skills: Array.isArray(a?.skills) ? a.skills.map(String) : null,
      requires_external_cli: a?.requires_external_cli === true,
      front_desk: codeOut.toLowerCase() === 'xiaomi',
    }
  } catch (e) {
    toast('加载智能体详情失败: ' + (e?.message || e), 'warning')
    return {
      ...empty,
      code: c,
      agent_name: c,
      front_desk: c.toLowerCase() === 'xiaomi',
    }
  }
}

/**
 * @returns {Promise<{
 *   tools: Array<{value:string,label:string,desc:string}>,
 *   mcp: Array<{value:string,label:string}>,
 *   skills: Array<{value:string,label:string,desc:string}>,
 * }>}
 */
async function loadAgentCapabilityCatalog() {
  /** @type {Array<{value:string,label:string,desc:string}>} */
  let tools = []
  /** @type {Array<{value:string,label:string}>} */
  let mcp = []
  /** @type {Array<{value:string,label:string,desc:string}>} */
  let skills = []

  try {
    const meta = await api.getToolsMetadata()
    tools = (meta?.tools || [])
      .filter((t) => ROLE_EDITOR_CONFIGURABLE_TIERS.has(String(t?.tool_type || 'optional')))
      .map((t) => ({
        value: String(t.name || '').trim(),
        label: String(t.label || t.name || '').trim(),
        desc: String(t.description || '').trim(),
      }))
      .filter((t) => t.value)
    if (Array.isArray(meta?.skills) && meta.skills.length) {
      skills = meta.skills.map((s) => ({
        value: String(s.name || '').trim(),
        label: String(s.label || s.name || '').trim(),
        desc: String(s.description || '').trim(),
      })).filter((s) => s.value)
    }
  } catch {
    /* ignore */
  }

  try {
    const mcpConfig = await api.getMCPConfig()
    if (mcpConfig?.mcp_servers) {
      for (const [name, cfg] of Object.entries(mcpConfig.mcp_servers)) {
        if (cfg?.enabled === false) continue
        mcp.push({ value: name, label: String(cfg?.description || name) })
      }
    }
  } catch {
    /* ignore */
  }
  if (!mcp.length) {
    try {
      const meta = await api.getToolsMetadata()
      mcp = (meta?.mcp_servers || [])
        .filter((s) => s.enabled !== false)
        .map((s) => ({
          value: String(s.value || s.name || '').trim(),
          label: String(s.label || s.name || '').trim(),
        }))
        .filter((s) => s.value)
    } catch {
      /* ignore */
    }
  }

  if (!skills.length) {
    try {
      const list = await api.loadSkills()
      skills = (Array.isArray(list) ? list : [])
        .filter((s) => s.enabled !== false)
        .map((s) => ({
          value: String(s.name || '').trim(),
          label: String(s.name || '').trim(),
          desc: String(s.description || '').trim(),
        }))
        .filter((s) => s.value)
    } catch {
      /* ignore */
    }
  }

  const dedupe = (rows) => {
    const seen = new Set()
    const out = []
    for (const r of rows) {
      if (!r.value || seen.has(r.value)) continue
      seen.add(r.value)
      out.push(r)
    }
    return out
  }
  return { tools: dedupe(tools), mcp: dedupe(mcp), skills: dedupe(skills) }
}

function resolveSelectedCapability(stored, catalogValues, { defaultAll = false } = {}) {
  const catalog = catalogValues || []
  if (!Array.isArray(stored)) {
    return defaultAll ? [...catalog] : []
  }
  const allowed = new Set(catalog)
  return stored.map(String).filter((v) => allowed.has(v))
}

function renderCapabilityChecklist({
  name,
  items,
  selected,
  emptyLabel,
  searchPlaceholder,
  /** 内置工具等：只展示名称，不跟长描述 */
  nameOnly = false,
} = {}) {
  const selectedSet = new Set(selected || [])
  const rows = (items || [])
    .map((it) => {
      const checked = selectedSet.has(it.value) ? 'checked' : ''
      const title = it.label || it.value
      const search = `${it.value} ${it.label} ${nameOnly ? '' : it.desc || ''}`.toLowerCase()
      return `<label class="hire-cap-check${nameOnly ? ' hire-cap-check--name' : ''}" data-search="${esc(search)}">
        <input type="checkbox" data-cap-group="${esc(name)}" value="${esc(it.value)}" ${checked}>
        <span class="hire-cap-check__body">
          <strong>${esc(title)}</strong>
          ${!nameOnly && it.desc ? `<em>${esc(it.desc)}</em>` : ''}
        </span>
      </label>`
    })
    .join('')
  return `
    <div class="hire-cap-block" data-cap-block="${esc(name)}">
      <div class="hire-cap-toolbar">
        <input class="hire-input hire-cap-search" type="search" placeholder="${esc(searchPlaceholder || '搜索…')}" data-cap-filter="${esc(name)}" autocomplete="off">
        <span class="hire-cap-count"><em data-cap-count="${esc(name)}">${selectedSet.size}</em> / ${(items || []).length}</span>
        <button type="button" class="btn btn-sm btn-secondary" data-cap-all="${esc(name)}">全选</button>
        <button type="button" class="btn btn-sm btn-secondary" data-cap-none="${esc(name)}">清空</button>
      </div>
      <div class="hire-cap-list" data-cap-list="${esc(name)}">
        ${rows || `<p class="hire-chip-hint">${esc(emptyLabel || '暂无可用项')}</p>`}
      </div>
    </div>`
}

function renderAgentNativePanel(detail) {
  const d = detail || {
    code: '',
    agent_name: '',
    system_prompt: '',
    soul: '',
  }
  return `
    <p class="hire-chip-hint">名称与系统提示词以智能体为准（聊天与上班共用）。旧「岗位职责」若仍存在，已合并进下方提示词。工具 / MCP / 技能请用左侧对应分区配置。</p>
    <label class="hire-field">
      <span>名称</span>
      <input class="hire-input" data-name="agent_display_name" value="${esc(d.agent_name)}" placeholder="例如：创意广告负责人、AIGC 编剧">
    </label>
    <label class="hire-field hire-field--grow">
      <span>系统提示词</span>
      <p class="hire-chip-hint">核心指令、行为规范与要主动推进的事，都写这里。</p>
      <textarea class="hire-input hire-textarea hire-textarea--agent-prompt" data-name="agent_system_prompt" rows="12" placeholder="例：你是专业编剧…&#10;&#10;每轮要做：&#10;- 选题…&#10;- 写小说…">${esc(d.system_prompt)}</textarea>
    </label>
    <label class="hire-field hire-field--grow">
      <span>人格 SOUL</span>
      <p class="hire-chip-hint">个性、行为边界、输出风格。是否注入见「工作设置」里的 SOUL 开关（勾选=强制；未勾=跟随默认）。</p>
      <textarea class="hire-input hire-textarea hire-textarea--agent-soul" data-name="agent_soul" rows="8" placeholder="例：语气干脆；不确定时先问；不编造事实">${esc(d.soul)}</textarea>
    </label>`
}

function readAgentNativeFields(overlay) {
  return {
    agent_name: (overlay.querySelector('[data-name="agent_display_name"]')?.value || '').trim(),
    system_prompt: overlay.querySelector('[data-name="agent_system_prompt"]')?.value ?? '',
    soul: overlay.querySelector('[data-name="agent_soul"]')?.value ?? '',
  }
}

function readCapabilitySelection(overlay, group) {
  return [...overlay.querySelectorAll(`input[data-cap-group="${group}"]:checked`)].map((el) => el.value)
}

function syncCapabilityCount(overlay, group) {
  const el = overlay.querySelector(`[data-cap-count="${group}"]`)
  if (!el) return
  el.textContent = String(overlay.querySelectorAll(`input[data-cap-group="${group}"]:checked`).length)
}

function bindCapabilityPanels(overlay) {
  overlay.querySelectorAll('[data-cap-filter]').forEach((input) => {
    input.addEventListener('input', () => {
      const group = input.getAttribute('data-cap-filter')
      const kw = String(input.value || '').trim().toLowerCase()
      overlay.querySelectorAll(`[data-cap-list="${group}"] .hire-cap-check`).forEach((row) => {
        const hit = !kw || String(row.getAttribute('data-search') || '').includes(kw)
        row.hidden = !hit
      })
    })
  })
  overlay.querySelectorAll('[data-cap-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.getAttribute('data-cap-all')
      overlay.querySelectorAll(`input[data-cap-group="${group}"]`).forEach((cb) => {
        cb.checked = true
      })
      syncCapabilityCount(overlay, group)
    })
  })
  overlay.querySelectorAll('[data-cap-none]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.getAttribute('data-cap-none')
      overlay.querySelectorAll(`input[data-cap-group="${group}"]`).forEach((cb) => {
        cb.checked = false
      })
      syncCapabilityCount(overlay, group)
    })
  })
  overlay.querySelectorAll('input[data-cap-group]').forEach((cb) => {
    cb.addEventListener('change', () => syncCapabilityCount(overlay, cb.getAttribute('data-cap-group')))
  })
}

function fillCapabilityPanels(overlay, detail, catalog) {
  const locked = !!(detail?.requires_external_cli || detail?.front_desk)
  const toolValues = (catalog?.tools || []).map((t) => t.value)
  const mcpValues = (catalog?.mcp || []).map((t) => t.value)
  const skillValues = (catalog?.skills || []).map((t) => t.value)
  const selectedTools = locked
    ? []
    : resolveSelectedCapability(detail?.tools, toolValues, { defaultAll: true })
  const selectedMcp = locked
    ? []
    : resolveSelectedCapability(detail?.mcp_servers, mcpValues, { defaultAll: true })
  const selectedSkills = locked
    ? []
    : resolveSelectedCapability(detail?.skills, skillValues, { defaultAll: false })

  const toolsPanel = overlay.querySelector('.hire-edit-panel[data-section="tools"]')
  const mcpPanel = overlay.querySelector('.hire-edit-panel[data-section="mcp"]')
  const skillsPanel = overlay.querySelector('.hire-edit-panel[data-section="skills"]')
  if (toolsPanel) {
    toolsPanel.innerHTML = locked
      ? '<p class="hire-chip-hint">此外挂 / 系统前台不在面板配置内置工具（由运行时提供）。</p>'
      : renderCapabilityChecklist({
          name: 'tools',
          items: catalog?.tools || [],
          selected: selectedTools,
          emptyLabel: '暂无可配置内置工具',
          searchPlaceholder: '搜索内置工具…',
          nameOnly: true,
        })
  }
  if (mcpPanel) {
    mcpPanel.innerHTML = locked
      ? '<p class="hire-chip-hint">此外挂 / 系统前台不在面板配置 MCP。</p>'
      : `${renderCapabilityChecklist({
          name: 'mcp',
          items: catalog?.mcp || [],
          selected: selectedMcp,
          emptyLabel: '暂无 MCP；请先到设置 → 连接器 添加',
          searchPlaceholder: '搜索 MCP…',
        })}`
  }
  if (skillsPanel) {
    skillsPanel.innerHTML = locked
      ? '<p class="hire-chip-hint">此外挂 / 系统前台不在面板配置技能。</p>'
      : `${renderCapabilityChecklist({
          name: 'skills',
          items: catalog?.skills || [],
          selected: selectedSkills,
          emptyLabel: '暂无已安装技能；请先到设置 → 技能 安装',
          searchPlaceholder: '搜索技能…',
        })}`
  }
  if (!locked) bindCapabilityPanels(overlay)
}

function fillAgentNativePanel(overlay, detail, catalog) {
  const host =
    overlay.querySelector('[data-role="agent-native"]') ||
    overlay.querySelector('.hire-edit-panel[data-section="agent"]')
  if (!host) return
  host.innerHTML = renderAgentNativePanel(detail)
  if (catalog) fillCapabilityPanels(overlay, detail, catalog)
}

/**
 * @param {object} role
 * @param {{
 *   onSaved?: (updated?: object) => void | Promise<void>,
 *   sheetTitle?: string,
 *   sheetKicker?: string,
 *   confirmLabel?: string,
 *   allowAgentRebind?: boolean,
 * }} [opts]
 */
export async function showEditRoleModal(role, {
  onSaved,
  sheetTitle = '编辑岗位',
  sheetKicker = '智能体员工',
  confirmLabel = '保存岗位',
  /** Employee identity = agent; rebind UI is opt-in only (legacy). */
  allowAgentRebind = false,
} = {}) {
  if (!role) return
  const cfg = role.config || {}
  const autonomy = cfg.autonomy_level || 'approval_for_risky'
  const thinkMode = cfg.think_mode || 'agent_loop'
  const isXiaomiFrontDesk =
    !!role.system_front_desk || String(role.agent_code || '').trim().toLowerCase() === 'xiaomi'
  // null=跟随默认, true=启用, false=禁用；平台秘书默认按「禁用」展示（产品要求快回）
  const thinkingEnabledRaw = cfg.thinking_enabled
  const thinkingEnabled =
    isXiaomiFrontDesk && (thinkingEnabledRaw === null || thinkingEnabledRaw === undefined)
      ? false
      : thinkingEnabledRaw
  const visionEnabledRaw = cfg.vision_enabled
  const visionEnabled =
    visionEnabledRaw === true || visionEnabledRaw === false ? visionEnabledRaw : null
  const legacyDuties = Array.isArray(cfg.responsibilities)
    ? cfg.responsibilities.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  const needsDutyMerge = legacyDuties.length > 0
  const workspacePath = String(cfg.workspace_path || '').trim()
  const modelName = String(cfg.model_name || '').trim()
  const currentReportsTo = String(role.reports_to || cfg.reports_to || '').trim()
  const selectedVaultIds = Array.isArray(cfg.knowledge_vault_ids) ? cfg.knowledge_vault_ids : []
  const existingKbInjection = (cfg && cfg.kb_injection) || {}
  const dailyBudget = Number(cfg.daily_budget_usd || 0) || 0
  const perRunBudget = Number(cfg.per_run_budget_usd || 0) || 0
  const budgetPolicy = String(cfg.budget_exceed_policy || 'skip_patrol').trim() || 'skip_patrol'
  // Memory gate (canonical) + remaining prompt injection toggles
  const memoryEnabled =
    cfg.memory_enabled === false || cfg.inject_memory === false || cfg.inject_assets === false
      ? false
      : true
  const injectUserProfile = cfg.inject_user_profile  // null=默认, true=注入, false=不注入
  const injectSkills = cfg.inject_skills
  const injectKb = cfg.inject_kb
  const injectSoul = cfg.inject_soul
  const [
    workspacePaths,
    chatModels,
    available,
    peerRoles,
    knowledgeVaults,
    departments,
    agentDetail,
    capabilityCatalog,
  ] = await Promise.all([
      loadWorkspacePaths(),
      loadChatModels(),
      allowAgentRebind ? loadRebindableAgents(role.agent_code) : Promise.resolve([]),
      api
        .proactiveListRoles()
        .then((res) => (Array.isArray(res) ? res : res?.roles || []))
        .catch(() => []),
      loadKnowledgeVaults(),
      loadDepartmentCatalog(),
      loadAgentDetailForEdit(role.agent_code),
      loadAgentCapabilityCatalog(),
    ])
  const selfCode = String(role.agent_code || '').trim()
  if (allowAgentRebind && !available.length) {
    toast('没有可绑定的智能体', 'warning')
    return
  }
  const currentDepartment = resolveRoleDepartment(role, cfg, departments)
  const peerDeptNames = (peerRoles || [])
    .map((r) => String(r?.department || '').trim())
    .filter(Boolean)
  const departmentSelect = renderDepartmentSelectControl(
    currentDepartment,
    departments,
    peerDeptNames,
  )
  const managerRows = (peerRoles || []).filter((r) => {
    const c = String(r?.agent_code || '').trim()
    return c && c !== selfCode && String(r?.status || '') !== 'archived'
  })
  const reportsToSelect = renderReportsToSelectControl(currentReportsTo, managerRows)
  let selected =
    available.find((a) => a.code === role.agent_code) ||
    (selfCode
      ? {
          code: selfCode,
          name: String(
            agentDetail?.agent_name || role.agent_name || role.role_name || selfCode,
          ).trim(),
          avatar: agentDetail?.avatar ?? null,
          avatar_meta: agentDetail?.avatar_meta ?? null,
          has_avatar_file: !!agentDetail?.has_avatar_file,
        }
      : null)
  if (!selected) {
    toast('无法加载当前智能体', 'warning')
    return
  }
  /** Raw agent prompt before duty merge (for change detection). */
  const rawAgentPrompt = String(agentDetail.system_prompt || '')
  /** @type {Awaited<ReturnType<typeof loadAgentDetailForEdit>>} */
  let boundAgent = {
    ...agentDetail,
    // Prefer agent_name; fall back to legacy role_name for display.
    agent_name:
      String(agentDetail.agent_name || '').trim() ||
      String(role.agent_name || role.role_name || agentDetail.code || '').trim(),
    system_prompt: mergeDutyIntoSystemPrompt(rawAgentPrompt, legacyDuties),
  }
  /** Baseline: raw prompt so merged duties count as a pending agent change. */
  let agentBaseline = { ...agentDetail, system_prompt: rawAgentPrompt }
  const agentByCode = new Map(available.map((a) => [a.code.toLowerCase(), a]))
  const scheduleCtrl = createSchedulePanel({
    schedule: roleScheduleExpr(role),
    autoPatrolSuspended: !!(
      role?.auto_patrol_suspended || role?.config?.auto_patrol_suspended
    ),
    idPrefix: 'proSched',
  })

  const renderAgentCard = () => `
      <div class="hire-agent-card" data-role="agent-card">
        <div class="hire-agent-avatar hire-agent-avatar--editable" data-role="agent-avatar-picker" title="更换头像"></div>
        <div class="hire-agent-meta">
          <div class="hire-agent-name">${esc(selected.name || selected.code)}</div>
          <div class="hire-agent-code">${esc(selected.code)}</div>
        </div>
        ${
          allowAgentRebind
            ? `<span class="hire-agent-pill">${selected.code === role.agent_code ? '当前绑定' : '将改绑'}</span>`
            : ''
        }
      </div>`

  // Employee = this agent; no rebind picker by default.
  const basicAgentBlock = allowAgentRebind
    ? `<p class="hire-chip-hint">可改绑智能体；点击头像可更换。改绑后下方名称与提示词会换成新智能体的配置。工具 / MCP / 技能用左侧对应分区。</p>
              ${renderAgentPickField(available, selected.code)}
              ${renderAgentCard()}`
    : `<p class="hire-chip-hint">点击头像可更换形象。工具 / MCP / 技能用左侧对应分区。</p>
              ${renderAgentCard()}
              <input type="hidden" data-name="agent_code" value="${esc(selected.code)}">`

  const sections = [
    { key: 'agent', label: '智能体' },
    { key: 'capability', label: '工作设置' },
    { key: 'tools', label: '内置工具' },
    { key: 'mcp', label: 'MCP' },
    { key: 'skills', label: '技能' },
    { key: 'knowledge', label: '知识库' },
    { key: 'strategy', label: '工作策略' },
    { key: 'schedule', label: '成本预算' },
  ]

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay hire-overlay'
  overlay.innerHTML = `
    <div class="hire-sheet hire-sheet--edit" role="dialog" aria-labelledby="hire-sheet-title">
      <header class="hire-sheet-head">
        <div>
          <p class="hire-sheet-kicker">${esc(sheetKicker)}</p>
          <h2 id="hire-sheet-title" class="hire-sheet-title">${esc(sheetTitle)}</h2>
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
            <div class="hire-edit-panel hire-edit-panel--agent" data-section="agent">
              ${basicAgentBlock}
              <div class="hire-field">
                <span>部门</span>
                ${departmentSelect}
              </div>
              <div class="hire-field">
                <span>直属上级</span>
                ${reportsToSelect}
              </div>
              <div data-role="agent-native">
                ${renderAgentNativePanel(boundAgent)}
              </div>
            </div>
            <div class="hire-edit-panel" data-section="tools" hidden></div>
            <div class="hire-edit-panel" data-section="mcp" hidden></div>
            <div class="hire-edit-panel" data-section="skills" hidden></div>

            <div class="hire-edit-panel" data-section="knowledge" hidden>
              <p class="hire-chip-hint">两步：先勾库，再选怎么用。其余检索细节用系统默认即可。</p>
              ${renderKnowledgeVaultField(knowledgeVaults, selectedVaultIds)}
              ${renderKbInjectionField(existingKbInjection)}
            </div>

            <div class="hire-edit-panel" data-section="capability" hidden>
              ${renderModelField(chatModels, modelName)}
              ${renderWorkspaceField(workspacePaths, workspacePath)}
              <div class="hire-field">
                <span>工作方式</span>
                <div class="hire-chip-row" data-name="think_mode" role="radiogroup">
                  <button type="button" class="hire-chip${thinkMode === 'agent_loop' ? ' is-on' : ''}" data-value="agent_loop">深度工作</button>
                  <button type="button" class="hire-chip${thinkMode === 'prompt_only' ? ' is-on' : ''}" data-value="prompt_only">轻量工作</button>
                </div>
                <p class="hire-chip-hint">深度可调工具；轻量为单次 LLM</p>
              </div>
              <div class="hire-field">
                <span>模型思考</span>
                <div class="hire-chip-row" data-name="thinking_enabled" role="radiogroup">
                  <button type="button" class="hire-chip${thinkingEnabled === null || thinkingEnabled === undefined ? ' is-on' : ''}" data-value="">默认</button>
                  <button type="button" class="hire-chip${thinkingEnabled === true ? ' is-on' : ''}" data-value="true">启用思考</button>
                  <button type="button" class="hire-chip${thinkingEnabled === false ? ' is-on' : ''}" data-value="false">禁用思考</button>
                </div>
                <p class="hire-chip-hint">${
                  isXiaomiFrontDesk
                    ? '平台秘书默认关闭思考，保证接待/分诊快回；一般无需开启'
                    : '控制模型的推理/思考过程（如 CoT、extended thinking）'
                }</p>
              </div>
              <div class="hire-field">
                <span>图片识别</span>
                <div class="hire-chip-row" data-name="vision_enabled" role="radiogroup">
                  <button type="button" class="hire-chip${visionEnabled === null || visionEnabled === undefined ? ' is-on' : ''}" data-value="">默认</button>
                  <button type="button" class="hire-chip${visionEnabled === true ? ' is-on' : ''}" data-value="true">启用识图</button>
                  <button type="button" class="hire-chip${visionEnabled === false ? ' is-on' : ''}" data-value="false">关闭识图</button>
                </div>
                <p class="hire-chip-hint">关闭后该岗位聊天不能发图；默认则按当前模型是否支持视觉</p>
              </div>
              <div class="hire-field">
                <span>记忆</span>
                <div class="hire-chip-row" data-name="memory_enabled" role="radiogroup">
                  <button type="button" class="hire-chip${memoryEnabled ? ' is-on' : ''}" data-value="true">开</button>
                  <button type="button" class="hire-chip${!memoryEnabled ? ' is-on' : ''}" data-value="false">关</button>
                </div>
                <p class="hire-chip-hint">岗位默认；员工聊天可在会话底栏覆盖。开=注入记忆并挂载 assets 工具</p>
              </div>
              <div class="hire-field">
                <span>系统提示词分项</span>
                <p class="hire-chip-hint">与记忆总闸无关。勾选=强制注入；未勾选=跟随默认（不写入 false）</p>
                <div class="hire-inject-toggles">
                  <label class="hire-toggle">
                    <input type="checkbox" data-name="inject_user_profile" ${injectUserProfile === true ? 'checked' : ''}>
                    <span>用户画像</span>
                  </label>
                  <label class="hire-toggle">
                    <input type="checkbox" data-name="inject_skills" ${injectSkills === true ? 'checked' : ''}>
                    <span>技能描述</span>
                  </label>
                  <label class="hire-toggle">
                    <input type="checkbox" data-name="inject_soul" ${injectSoul === true ? 'checked' : ''}>
                    <span>SOUL 人设</span>
                  </label>
                </div>
              </div>
            </div>

            <div class="hire-edit-panel" data-section="strategy" hidden>
              <div class="hire-field">
                <span>${AUTONOMY_FIELD_LABEL}</span>
                <p class="hire-chip-hint">${esc(AUTONOMY_FIELD_DESC)}</p>
                <div class="hire-chip-row" data-name="autonomy_level" role="radiogroup">
                  ${renderAutonomyChips(AUTONOMY_EDIT_OPTIONS, autonomy)}
                </div>
                <p class="hire-chip-hint" data-autonomy-hint>${esc(autonomyHint(autonomy))}</p>
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
        <button type="button" class="btn btn-sm hire-confirm" data-act="confirm">${esc(confirmLabel)}</button>
      </footer>
    </div>
  `
  document.body.appendChild(overlay)
  fillCapabilityPanels(overlay, boundAgent, capabilityCatalog)

  const seedAvatar = (src) => ({
    avatar: src?.avatar ?? null,
    avatar_meta: src?.avatar_meta ?? null,
    previewUrl: null,
  })
  const avatarPickerState = seedAvatar({
    avatar: selected?.avatar ?? boundAgent?.avatar ?? null,
    avatar_meta: selected?.avatar_meta ?? boundAgent?.avatar_meta ?? null,
  })
  let avatarBaseline = {
    avatar: avatarPickerState.avatar,
    avatar_meta: avatarPickerState.avatar_meta,
  }

  const mountBoundAvatarPicker = () => {
    const el = overlay.querySelector('[data-role="agent-avatar-picker"]')
    if (!el) return
    const code = selected?.code || role.agent_code
    const name = selected?.name || boundAgent?.agent_name || code
    void getGatewayBaseUrl()
      .then((baseUrl) => {
        mountAgentAvatarPicker(el, {
          agentCode: code,
          agentName: name,
          baseUrl: baseUrl || '',
          value: avatarPickerState,
          onChange: (next) => {
            avatarPickerState.avatar = next.avatar
            avatarPickerState.avatar_meta = next.avatar_meta
            avatarPickerState.previewUrl = next.previewUrl
          },
          onUpload: async (blob, meta) => {
            await api.uploadAgentAvatar(code, blob)
            await api.updateAgent(code, { avatar: 'image', avatar_meta: meta })
            avatarPickerState.avatar = 'image'
            avatarPickerState.avatar_meta = meta
            const row = agentByCode.get(String(code).toLowerCase())
            if (row) {
              row.avatar = 'image'
              row.avatar_meta = meta
              row.has_avatar_file = true
            }
          },
        })
      })
      .catch(() => {
        mountAgentAvatarPicker(el, {
          agentCode: code,
          agentName: name,
          value: avatarPickerState,
          onChange: (next) => {
            avatarPickerState.avatar = next.avatar
            avatarPickerState.avatar_meta = next.avatar_meta
            avatarPickerState.previewUrl = next.previewUrl
          },
          onUpload: async (blob, meta) => {
            await api.uploadAgentAvatar(code, blob)
            await api.updateAgent(code, { avatar: 'image', avatar_meta: meta })
            avatarPickerState.avatar = 'image'
            avatarPickerState.avatar_meta = meta
          },
        })
      })
  }
  mountBoundAvatarPicker()

  const close = () => {
    const pickerEl = overlay.querySelector('[data-role="agent-avatar-picker"]')
    if (pickerEl) unmountAgentUi(pickerEl)
    overlay.remove()
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelectorAll('[data-act="close"]').forEach((el) => el.addEventListener('click', close))
  bindHireChipRows(overlay)
  bindModelSelect(overlay)
  bindHireDropdown(overlay, { role: 'department-dd' })
  bindHireDropdown(overlay, { role: 'reports-to-dd' })
  bindWorkspaceSelect(overlay)
  bindKbInjectionChipRows(overlay)
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
    const prevPicker = card.querySelector('[data-role="agent-avatar-picker"]')
    if (prevPicker) unmountAgentUi(prevPicker)
    const wrap = document.createElement('div')
    wrap.innerHTML = renderAgentCard().trim()
    card.replaceWith(wrap.firstElementChild)
    mountBoundAvatarPicker()
  }

  if (allowAgentRebind) {
    bindHireDropdown(overlay, {
      role: 'agent-dd',
      onPick: async (code) => {
        const next = available.find((a) => a.code === code)
        if (!next) return
        selected = next
        const detail = await loadAgentDetailForEdit(code)
        boundAgent = detail
        agentBaseline = { ...detail }
        Object.assign(
          avatarPickerState,
          seedAvatar({
            avatar: detail?.avatar ?? next?.avatar ?? null,
            avatar_meta: detail?.avatar_meta ?? next?.avatar_meta ?? null,
          }),
        )
        avatarBaseline = {
          avatar: avatarPickerState.avatar,
          avatar_meta: avatarPickerState.avatar_meta,
        }
        syncAgentCard()
        fillAgentNativePanel(overlay, detail, capabilityCatalog)
      },
    })
  }

  overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', async () => {
    const agentFields = readAgentNativeFields(overlay)
    if (!agentFields.agent_name) {
      toast('请填写名称', 'warning')
      overlay.querySelector('[data-name="agent_display_name"]')?.focus()
      return
    }
    const role_name = agentFields.agent_name
    const workspace_path = readWorkspacePath(overlay)
    const nextAgent =
      (overlay.querySelector('input[data-name="agent_code"]')?.value || '').trim() || selected.code
    const autonomy_level =
      overlay.querySelector('[data-name="autonomy_level"] .hire-chip.is-on')?.dataset.value ||
      'approval_for_risky'
    const heartbeat_schedule = scheduleCtrl.getSchedule().cronExpr || roleScheduleExpr(role)
    const think_mode =
      overlay.querySelector('[data-name="think_mode"] .hire-chip.is-on')?.dataset.value || 'agent_loop'
    // thinking_enabled: '' = 跟随默认, 'true' = 启用, 'false' = 禁用
    // 平台秘书：未选手动档时落成禁用（与 ensure_xiaomi 默认一致），避免再回到「跟随默认→模型开思考」
    const thinking_enabled_raw =
      overlay.querySelector('[data-name="thinking_enabled"] .hire-chip.is-on')?.dataset.value || ''
    const thinking_enabled =
      thinking_enabled_raw === ''
        ? isXiaomiFrontDesk
          ? false
          : null
        : thinking_enabled_raw === 'true'
    const vision_enabled_raw =
      overlay.querySelector('[data-name="vision_enabled"] .hire-chip.is-on')?.dataset.value || ''
    const vision_enabled =
      vision_enabled_raw === '' ? null : vision_enabled_raw === 'true'
    const model_name = readModelName(overlay)
    const nextDaily = Number(overlay.querySelector('[data-name="daily_budget_usd"]')?.value || 0) || 0
    const nextPerRun = Number(overlay.querySelector('[data-name="per_run_budget_usd"]')?.value || 0) || 0
    const nextPolicy =
      (overlay.querySelector('[data-name="budget_exceed_policy"]')?.value || '').trim() || 'skip_patrol'
    const department = (overlay.querySelector('[data-name="department"]')?.value || '').trim()
    const reports_to = (overlay.querySelector('[data-name="reports_to"]')?.value || '').trim()
    const knowledge_vault_ids = readKnowledgeVaultIds(overlay)
    const kb_injection = readKbInjectionConfig(overlay, existingKbInjection)
    const agentTargetCode = nextAgent || role.agent_code
    const agentNameChanged = agentFields.agent_name !== String(agentBaseline.agent_name || '')
    const agentPromptChanged =
      String(agentFields.system_prompt || '') !== String(agentBaseline.system_prompt || '')
    const agentSoulChanged = String(agentFields.soul || '') !== String(agentBaseline.soul || '')
    const avatarChanged =
      avatarPickerState.avatar !== avatarBaseline.avatar ||
      JSON.stringify(avatarPickerState.avatar_meta ?? null) !==
        JSON.stringify(avatarBaseline.avatar_meta ?? null)
    const capLocked = !!(boundAgent?.requires_external_cli || boundAgent?.front_desk)
    const toolValues = (capabilityCatalog?.tools || []).map((t) => t.value)
    const mcpValues = (capabilityCatalog?.mcp || []).map((t) => t.value)
    const skillValues = (capabilityCatalog?.skills || []).map((t) => t.value)
    const nextTools = capLocked ? [] : readCapabilitySelection(overlay, 'tools')
    const nextMcp = capLocked ? [] : readCapabilitySelection(overlay, 'mcp')
    const nextSkills = capLocked ? [] : readCapabilitySelection(overlay, 'skills')
    const baseTools = capLocked
      ? []
      : resolveSelectedCapability(agentBaseline.tools, toolValues, { defaultAll: true })
    const baseMcp = capLocked
      ? []
      : resolveSelectedCapability(agentBaseline.mcp_servers, mcpValues, { defaultAll: true })
    const baseSkills = capLocked
      ? []
      : resolveSelectedCapability(agentBaseline.skills, skillValues, { defaultAll: false })
    const sameList = (a, b) => {
      if (a.length !== b.length) return false
      const sb = new Set(b)
      return a.every((x) => sb.has(x))
    }
    const toolsChanged = !sameList(nextTools, baseTools)
    const mcpChanged = !sameList(nextMcp, baseMcp)
    const skillsChanged = !sameList(nextSkills, baseSkills)
    const agentCapabilityChanged = toolsChanged || mcpChanged || skillsChanged
    const agentNativeChanged =
      agentNameChanged ||
      agentPromptChanged ||
      agentSoulChanged ||
      agentCapabilityChanged ||
      avatarChanged ||
      needsDutyMerge
    const roleNameOutOfSync =
      role_name !== String(role.role_name || '').trim() &&
      role_name !== String(role.agent_name || '').trim()

    const roleChanges = []
    if (department !== String(role.department || '')) roleChanges.push(`部门：${role.department || '—'} → ${department || '—'}`)
    if (nextAgent !== role.agent_code) roleChanges.push(`绑定智能体：${role.agent_code} → ${nextAgent}`)
    if (reports_to !== currentReportsTo) roleChanges.push(`直属上级：${currentReportsTo || '无'} → ${reports_to || '无'}`)
    if (workspace_path !== workspacePath) {
      roleChanges.push(
        `工作空间：${pathBasename(workspacePath) || '默认'} → ${pathBasename(workspace_path) || '默认'}`,
      )
    }
    if (JSON.stringify(knowledge_vault_ids) !== JSON.stringify(selectedVaultIds)) roleChanges.push('知识库关联已修改')
    if (model_name !== modelName) roleChanges.push(`工作模型：${modelName || '默认'} → ${model_name || '默认'}`)
    if (think_mode !== thinkMode) roleChanges.push(`工作方式：${THINK_MODE_LABELS[thinkMode] || thinkMode} → ${THINK_MODE_LABELS[think_mode] || think_mode}`)
    // thinking_enabled 变更检测
    if (thinking_enabled !== thinkingEnabled) {
      const labels = { null: '默认', true: '启用思考', false: '禁用思考' }
      roleChanges.push(`模型思考：${labels[thinkingEnabled]} → ${labels[thinking_enabled]}`)
    }
    if (vision_enabled !== visionEnabled) {
      const labels = { null: '默认', true: '启用识图', false: '关闭识图' }
      roleChanges.push(`图片识别：${labels[visionEnabled]} → ${labels[vision_enabled]}`)
    }
    const memory_enabled_raw =
      overlay.querySelector('[data-name="memory_enabled"] .hire-chip.is-on')?.dataset.value || 'true'
    const memory_enabled = memory_enabled_raw !== 'false'
    if (memory_enabled !== memoryEnabled) {
      roleChanges.push(`记忆：${memoryEnabled ? '开' : '关'} → ${memory_enabled ? '开' : '关'}`)
    }
    if (autonomy_level !== autonomy) {
      roleChanges.push(
        `交工审核：${AUTONOMY_LABELS[autonomy] || autonomy} → ${AUTONOMY_LABELS[autonomy_level] || autonomy_level}`,
      )
    }
    if (heartbeat_schedule !== roleScheduleExpr(role)) {
      roleChanges.push(
        `自动上班：${roleScheduleSummary(role)} → ${prettyRrule(heartbeat_schedule)}`,
      )
    }
    if (nextDaily !== dailyBudget) roleChanges.push(`每日预算：$${dailyBudget} → $${nextDaily}`)
    if (nextPerRun !== perRunBudget) roleChanges.push(`单次预算：$${perRunBudget} → $${nextPerRun}`)
    if (nextPolicy !== budgetPolicy) {
      roleChanges.push(
        `超额策略：${BUDGET_POLICY_LABELS[budgetPolicy] || budgetPolicy} → ${BUDGET_POLICY_LABELS[nextPolicy] || nextPolicy}`,
      )
    }
    const prevKb = existingKbInjection || {}
    const kbChanged = JSON.stringify(kb_injection) !== JSON.stringify(prevKb)
    if (kbChanged) roleChanges.push('知识库检索配置已修改')
    // inject_* toggles are always written on role save; detect checkbox drift vs open-time values
    const injectNow = (name, opened) => {
      const cb = overlay.querySelector(`[data-name="${name}"]`)
      if (!cb) return false
      const next = cb.checked ? true : null
      return next !== (opened === true ? true : null)
    }
    if (injectNow('inject_user_profile', injectUserProfile)) roleChanges.push('用户画像注入已修改')
    if (injectNow('inject_skills', injectSkills)) roleChanges.push('技能描述注入已修改')
    if (injectNow('inject_soul', injectSoul)) roleChanges.push('SOUL 注入开关已修改')

    const agentChanges = []
    if (agentNameChanged) agentChanges.push('名称已修改')
    if (agentPromptChanged || needsDutyMerge) {
      agentChanges.push(needsDutyMerge && !agentPromptChanged ? '岗位职责已合并进系统提示词' : '系统提示词已修改')
    }
    if (agentSoulChanged) agentChanges.push('人格 SOUL 已修改')
    if (avatarChanged) agentChanges.push('头像已修改')
    if (toolsChanged) agentChanges.push('内置工具已修改')
    if (mcpChanged) agentChanges.push('MCP 勾选已修改')
    if (skillsChanged) agentChanges.push('技能勾选已修改')

    const changes = [...roleChanges, ...agentChanges]
    const syncNameOrClearDuties = needsDutyMerge || roleNameOutOfSync || agentNameChanged
    const roleConfigChanged = roleChanges.length > 0 || syncNameOrClearDuties

    if (!changes.length && !syncNameOrClearDuties) {
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
      const impactKeys = [
        '自动上班',
        '每日预算',
        '审批策略',
        '工作模型',
        '工作空间',
        '绑定智能体',
        '系统提示词',
        '人格 SOUL',
        '岗位职责已合并',
      ]
      const impactsRunning = changes.some((c) => impactKeys.some((k) => c.includes(k)))
      let summary = `将保存以下变更：\n\n${(changes.length ? changes : ['名称与提示词已与智能体对齐']).map((c) => `· ${c}`).join('\n')}`
      if (busyRes?.busy || (role.status === 'active' && impactsRunning)) {
        summary =
          '该员工可能正在运行或即将自动上班，配置变更将影响后续轮次。\n\n' + summary
      }
      const contSave = await showConfirm(`${summary}\n\n确认保存？`)
      if (!contSave) {
        if (btn) {
          btn.disabled = false
          btn.textContent = confirmLabel
        }
        return
      }

      if (roleConfigChanged) {
        const overlapCode = nextAgent || role.agent_code
        const overlap = await api
          .proactiveCheckOverlap({
            agent_code: overlapCode,
            exclude_agent_code: role.agent_code,
            responsibilities: parseLines(agentFields.system_prompt),
            role_name,
            system_prompt: agentFields.system_prompt,
          })
          .catch(() => null)
        if (overlap?.has_overlap && overlap.warning) {
          const cont = await showConfirm(`${overlap.warning}\n\n仍要保存？`)
          if (!cont) {
            if (btn) {
              btn.disabled = false
              btn.textContent = confirmLabel
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
              btn.textContent = confirmLabel
            }
            return
          }
        }
      }
      if (agentNativeChanged && agentTargetCode) {
        // Always send soul as string (incl. "") so clear persists; null is ignored by API.
        // tools/mcp: null = 全量（与智能体编辑器一致）；skills 始终显式列表。
        const isAllTools =
          !capLocked &&
          nextTools.length === toolValues.length &&
          toolValues.length > 0 &&
          nextTools.every((v) => toolValues.includes(v))
        const isAllMcp =
          !capLocked &&
          nextMcp.length === mcpValues.length &&
          mcpValues.length > 0 &&
          nextMcp.every((v) => mcpValues.includes(v))
        /** @type {Record<string, unknown>} */
        const agentPatch = {
          agent_name: agentFields.agent_name || null,
          system_prompt: agentFields.system_prompt,
          soul: String(agentFields.soul ?? ''),
        }
        if (avatarChanged) {
          agentPatch.avatar = avatarPickerState.avatar
          agentPatch.avatar_meta = avatarPickerState.avatar_meta ?? null
        }
        if (capLocked && boundAgent?.front_desk) {
          agentPatch.tools = []
          agentPatch.mcp_servers = []
          agentPatch.skills = []
        } else if (!capLocked && agentCapabilityChanged) {
          agentPatch.tools = isAllTools ? null : nextTools
          agentPatch.mcp_servers = isAllMcp ? null : nextMcp
          agentPatch.skills = nextSkills
        }
        await api.updateAgent(agentTargetCode, agentPatch)
      }
      let updated = role
      if (roleConfigChanged || agentNativeChanged) {
        const payload = {
          // Keep role_name in sync with agent display name (compat field).
          role_name,
          department,
          reports_to,
          // Duties live in agent system_prompt now.
          responsibilities: [],
          // Mirror agent SOUL onto role.soul_md so duty/chat still see it when inherit is off.
          soul_md: String(agentFields.soul ?? ''),
          workspace_path,
          knowledge_vault_ids,
          kb_injection,
          autonomy_level,
          heartbeat_schedule,
          think_mode,
          thinking_enabled,
          vision_enabled,
          model_name,
          daily_budget_usd: nextDaily,
          per_run_budget_usd: nextPerRun,
          budget_exceed_policy: nextPolicy,
          memory_enabled,
        }
        // Prompt section toggles: checked → true; unchecked → null (follow default). Never write false on save.
        const readInjectOptIn = (name) => {
          const cb = overlay.querySelector(`[data-name="${name}"]`)
          if (!cb) return undefined
          return cb.checked ? true : null
        }
        payload.inject_user_profile = readInjectOptIn('inject_user_profile')
        payload.inject_skills = readInjectOptIn('inject_skills')
        payload.inject_soul = readInjectOptIn('inject_soul')
        if (nextAgent && nextAgent !== role.agent_code) {
          payload.new_agent_code = nextAgent
        }
        updated = await api.proactiveUpdateRole(role.agent_code, payload)
      }
      toast(
        roleConfigChanged && agentNativeChanged
          ? '岗位与智能体已更新'
          : agentNativeChanged
            ? '智能体已更新'
            : '岗位已更新',
        'success',
      )
      close()
      if (typeof onSaved === 'function') await onSaved(updated)
    } catch (e) {
      toast('更新失败: ' + (e?.message || e), 'error')
      if (btn) {
        btn.disabled = false
        btn.textContent = confirmLabel
      }
    }
  })
}

export {
  loadKnowledgeVaults,
  readKnowledgeVaultIds,
  renderKnowledgeVaultField,
  renderKbInjectionField,
  readKbInjectionConfig,
  bindKbInjectionChipRows,
}
