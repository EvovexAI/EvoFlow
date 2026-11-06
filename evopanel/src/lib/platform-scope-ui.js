/**
 * 平台能力清单（platform_scope）UI 帮助函数 —— 员工可用的平台动作范围。
 *
 * 数据源：GET /api/tools/metadata 的 platform_domains（后端 evoflow.admin.platform_actions）。
 * 语义与 backend evoflow/config/platform_scope.py 对齐：
 *   不传 scope（null）= 全部动作（存量）；custom = domains ∪ actions − 扣除项，
 *   受 max_risk 上限约束。模型会在系统提示 <capability_profile> 里看到同源清单。
 */
import { escapeHtml, escapeAttr } from '../pages/agents-shared.js'

export const PLATFORM_RISK_ZH = { read: '读', write: '写', destructive: '破坏' }
export const PLATFORM_MAX_RISK_ZH = { read: '只读', write: '可写', destructive: '含破坏性' }

export function mapPlatformDomains(raw) {
  return (raw || [])
    .map((d) => ({
      domain: String(d.domain || ''),
      title: d.title || d.domain || '',
      actions: (d.actions || []).map((a) => ({
        name: String(a.name || ''),
        summary: a.summary || '',
        risk: a.risk || 'read',
      })),
      riskCounts: d.risk_counts || {},
    }))
    .filter((d) => d.domain)
}

export function platformRiskCountsText(counts) {
  const parts = []
  for (const k of ['read', 'write', 'destructive']) {
    if (counts?.[k]) parts.push(`${counts[k]} ${PLATFORM_RISK_ZH[k]}`)
  }
  return parts.join(' · ')
}

/**
 * 平台能力子面板 HTML（挂在工具页签 platform 勾选项下方，勾选才显示）。
 * @param {Array} domainsMeta mapPlatformDomains 产物
 * @param {Object|null} scope 已保存的 platform_scope（null/缺省 = 全部动作）
 */
export function renderPlatformScopePanel(domainsMeta, scope) {
  const isCustom = scope?.mode === 'custom'
  const maxRisk = scope?.max_risk || 'write'
  const domSet = new Set((scope?.domains || []).map((d) => String(d).toLowerCase()))
  const actAllow = new Set((scope?.actions || []).filter((a) => !String(a).startsWith('-')).map((a) => String(a).toLowerCase()))
  const actDeny = new Set((scope?.actions || []).filter((a) => String(a).startsWith('-')).map((a) => String(a).slice(1).toLowerCase()))

  const domainRows = domainsMeta
    .map((d) => {
      const domChecked = isCustom ? domSet.has(d.domain) : false
      const actionRows = d.actions
        .map((a) => {
          const ac = isCustom ? (actAllow.has(a.name) || (domChecked && !actDeny.has(a.name))) : false
          return `<label class="re-ps-action" title="${escapeAttr(a.summary || a.name)}">
            <input type="checkbox" name="platform_actions" value="${escapeAttr(a.name)}" ${ac ? 'checked' : ''}>
            <span class="re-ps-risk-dot" data-risk="${escapeAttr(a.risk)}" title="${PLATFORM_RISK_ZH[a.risk] || a.risk}"></span>
            <span class="re-ps-action-name">${escapeHtml(a.name)}</span>
            <small>${escapeHtml(a.summary || '')}</small>
          </label>`
        })
        .join('')
      return `<div class="re-ps-domain" data-domain="${escapeAttr(d.domain)}">
        <div class="re-ps-domain-head">
          <label class="re-ps-domain-check">
            <input type="checkbox" name="platform_domains" value="${escapeAttr(d.domain)}" ${domChecked ? 'checked' : ''}>
            <strong>${escapeHtml(d.title)}</strong>
            <code>${escapeHtml(d.domain)}.*</code>
          </label>
          <span class="re-ps-risk-badge">${escapeHtml(platformRiskCountsText(d.riskCounts) || `${d.actions.length} 动作`)}</span>
          <button type="button" class="re-ps-expand">明细</button>
        </div>
        <div class="re-ps-actions" hidden>${actionRows}</div>
      </div>`
    })
    .join('')

  return `<div class="re-platform-scope" data-platform-scope hidden>
    <div class="re-ps-head">
      <strong>平台能力清单</strong>
      <span class="re-ps-head-hint">模型会在系统提示里看到这份清单；「全部动作」= 不设限（存量行为）</span>
    </div>
    <div class="re-ps-modes">
      <label class="re-ps-mode"><input type="radio" name="platform_mode" value="all" ${isCustom ? '' : 'checked'}> 全部动作</label>
      <label class="re-ps-mode"><input type="radio" name="platform_mode" value="custom" ${isCustom ? 'checked' : ''}> 自定义范围</label>
    </div>
    <div class="re-ps-custom" ${isCustom ? '' : 'hidden'}>
      <div class="re-ps-risk">
        <span>风险上限：</span>
        ${['read', 'write', 'destructive']
          .map(
            (r) => `<label class="re-ps-mode"><input type="radio" name="platform_max_risk" value="${r}" ${maxRisk === r ? 'checked' : ''}> ${PLATFORM_MAX_RISK_ZH[r]}</label>`,
          )
          .join('')}
      </div>
      <div class="re-ps-domains">${domainRows || '<div class="re-empty">平台动作目录不可用（元数据未加载）</div>'}</div>
      <div class="re-ps-summary-line">已授权 <em class="re-ps-dom-count">0</em> 域 / <em class="re-ps-act-count">0</em> 动作</div>
    </div>
  </div>`
}

export function platformScopeAllowedCount(domainsMeta, scope) {
  if (!scope || scope.mode !== 'custom') {
    const total = domainsMeta.reduce((acc, d) => acc + d.actions.length, 0)
    return { domains: domainsMeta.length, actions: total }
  }
  const allow = new Set((scope.actions || []).filter((a) => !String(a).startsWith('-')).map((a) => String(a).toLowerCase()))
  const deny = new Set((scope.actions || []).filter((a) => String(a).startsWith('-')).map((a) => String(a).slice(1).toLowerCase()))
  const doms = new Set((scope.domains || []).map((d) => String(d).toLowerCase()))
  let actions = allow.size
  const coveredDomains = new Set()
  for (const d of domainsMeta) {
    if (doms.has(d.domain)) {
      coveredDomains.add(d.domain)
      for (const a of d.actions) {
        if (!deny.has(a.name) && !allow.has(a.name)) actions += 1
      }
    }
  }
  return { domains: coveredDomains.size, actions }
}

export function platformScopeSummaryText(domainsMeta, scope) {
  const { domains, actions } = platformScopeAllowedCount(domainsMeta, scope)
  if (!scope || scope.mode !== 'custom') return `全部 ${domains} 域 / ${actions} 动作`
  return `${domains} 域 / ${actions} 动作（上限 ${PLATFORM_MAX_RISK_ZH[scope.max_risk] || scope.max_risk}）`
}

/** 从编辑器读出 platform_scope；未勾选 platform 或选择「全部动作」→ null（存量语义）。 */
export function readPlatformScopeFromEditor(overlay) {
  const panel = overlay.querySelector('[data-platform-scope]')
  if (!panel || panel.hidden) return null
  const mode = panel.querySelector('input[name=platform_mode]:checked')?.value || 'all'
  if (mode !== 'custom') return null
  const max_risk = panel.querySelector('input[name=platform_max_risk]:checked')?.value || 'write'
  const domains = []
  const actions = []
  panel.querySelectorAll('.re-ps-domain').forEach((row) => {
    const domain = row.dataset.domain
    const domCb = row.querySelector('input[name=platform_domains]')
    const actionCbs = [...row.querySelectorAll('input[name=platform_actions]')]
    if (domCb?.checked) {
      domains.push(domain)
      actionCbs.forEach((cb) => {
        if (!cb.checked) actions.push('-' + cb.value)
      })
    } else {
      actionCbs.forEach((cb) => {
        if (cb.checked) actions.push(cb.value)
      })
    }
  })
  return { mode: 'custom', domains, actions, max_risk }
}

/** 绑定平台子面板交互；并让 platform 勾选项控制面板显隐。 */
export function bindPlatformScopePanel(overlay, domainsMeta) {
  const panel = overlay.querySelector('[data-platform-scope]')
  if (!panel) return
  // 供 setPlatformScopeState / 模板引擎复用同一份目录元数据。
  overlay.__platformScopeDomains = domainsMeta || []
  const platformCb = overlay.querySelector('.editor-tool-list input[value="platform"]')
  const syncVisible = () => {
    if (panel) panel.hidden = !platformCb?.checked
  }
  syncVisible()
  platformCb?.addEventListener('change', syncVisible)

  const updateSummary = () => {
    const scope = readPlatformScopeFromEditor(overlay)
    const { domains, actions } = platformScopeAllowedCount(overlay.__platformScopeDomains || [], scope)
    panel.querySelectorAll('.re-ps-dom-count').forEach((el) => (el.textContent = String(domains)))
    panel.querySelectorAll('.re-ps-act-count').forEach((el) => (el.textContent = String(actions)))
  }

  panel.querySelectorAll('input[name=platform_mode]').forEach((radio) =>
    radio.addEventListener('change', () => {
      const custom = radio.value === 'custom' && radio.checked
      panel.querySelector('.re-ps-custom').hidden = !custom
      updateSummary()
    }),
  )
  panel.querySelectorAll('.re-ps-expand').forEach((btn) =>
    btn.addEventListener('click', () => {
      const actionsEl = btn.closest('.re-ps-domain')?.querySelector('.re-ps-actions')
      if (actionsEl) actionsEl.hidden = !actionsEl.hidden
    }),
  )
  // 域级开关：勾选 = 整域放行（动作明细同步全勾）；取消 = 清空（明细里可单独勾动作）
  panel.querySelectorAll('input[name=platform_domains]').forEach((domCb) =>
    domCb.addEventListener('change', () => {
      const row = domCb.closest('.re-ps-domain')
      row?.querySelectorAll('input[name=platform_actions]').forEach((cb) => {
        cb.checked = domCb.checked
      })
      updateSummary()
    }),
  )
  panel.querySelectorAll('input[name=platform_actions]').forEach((cb) => cb.addEventListener('change', updateSummary))
  updateSummary()
}

/** tools/MCP 三态：配置值 → UI mode */
export function inferTriStateMode(value) {
  if (!Array.isArray(value)) return 'inherit'
  if (value.length === 0) return 'none'
  return 'custom'
}

/** tools/MCP 三态：UI mode + 勾选值 → 提交 payload（null / [] / list） */
export function resolveTriStatePayload(mode, checkedValues) {
  if (mode === 'inherit') return null
  if (mode === 'none') return []
  return Array.isArray(checkedValues) ? [...checkedValues] : []
}

/**
 * 编程式设置平台能力清单状态（岗位模板 / 预填用）。
 *
 * scope 语义与 readPlatformScopeFromEditor 对齐：
 * - null / {mode:'all'} → 「全部动作」radio（max_risk 仍生效，仅受上限约束）；
 * - {mode:'custom', domains, actions, max_risk} → 自定义：域勾选并同步动作明细，
 *   裸名 actions 额外勾选（域未勾时为动作级授权）。
 * 不派发 change 事件（程序化赋值），面板显隐/摘要由本函数直接同步。
 */
export function setPlatformScopeState(overlay, scope) {
  const panel = overlay.querySelector('[data-platform-scope]')
  if (!panel) return
  const isCustom = scope?.mode === 'custom'
  const allRadio = panel.querySelector('input[name=platform_mode][value=all]')
  const customRadio = panel.querySelector('input[name=platform_mode][value=custom]')
  if (allRadio) allRadio.checked = !isCustom
  if (customRadio) customRadio.checked = !!isCustom
  const customBody = panel.querySelector('.re-ps-custom')
  if (customBody) customBody.hidden = !isCustom

  panel.querySelectorAll('input[name=platform_domains]').forEach((cb) => {
    cb.checked = false
  })
  panel.querySelectorAll('input[name=platform_actions]').forEach((cb) => {
    cb.checked = false
  })
  const risk = scope?.max_risk || 'write'
  panel.querySelectorAll('input[name=platform_max_risk]').forEach((r) => {
    r.checked = r.value === risk
  })

  if (isCustom) {
    const doms = new Set((scope.domains || []).map((d) => String(d).toLowerCase()))
    panel.querySelectorAll('input[name=platform_domains]').forEach((cb) => {
      if (doms.has(String(cb.value).toLowerCase())) {
        cb.checked = true
        cb.closest('.re-ps-domain')
          ?.querySelectorAll('input[name=platform_actions]')
          .forEach((a) => {
            a.checked = true
          })
      }
    })
    const allow = (scope.actions || []).filter((a) => !String(a).startsWith('-'))
    for (const name of allow) {
      const cb = panel.querySelector(`input[name=platform_actions][value="${CSS.escape(String(name))}"]`)
      if (cb) cb.checked = true
    }
  }

  const { domains, actions } = platformScopeAllowedCount(overlay.__platformScopeDomains || [], isCustom ? scope : scope && scope.mode === 'all' ? { mode: 'all', max_risk: risk } : null)
  panel.querySelectorAll('.re-ps-dom-count').forEach((el) => (el.textContent = String(domains)))
  panel.querySelectorAll('.re-ps-act-count').forEach((el) => (el.textContent = String(actions)))
}
