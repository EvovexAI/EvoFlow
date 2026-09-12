/**
 * 智能体中心 — 技能 / 连接器共用 UI 片段（抽屉、筛选栏、二级 Tab）
 */

export function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function selectHtml(id, options, emptyLabel) {
  return `
    <select class="role-filter-select ec-filter-select" id="${id}" aria-label="${esc(emptyLabel)}">
      <option value="">${esc(emptyLabel)}</option>
      ${options.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}
    </select>`
}

export function renderModuleSubtabs(tabs, activeId) {
  return `
    <div class="role-subtabs ec-subtabs" role="tablist">
      ${tabs
        .map(
          (t) => `
        <button type="button" class="role-subtab${t.id === activeId ? ' role-subtab--active' : ''}" data-main-tab="${esc(t.id)}" role="tab">
          ${esc(t.label)}
        </button>`,
        )
        .join('')}
    </div>`
}

export function ensureDrawer(page, idPrefix = 'ec') {
  let root = page.querySelector(`#${idPrefix}Drawer`)
  if (root) return root
  root = document.createElement('div')
  root.className = 'ef-side-drawer-root role-drawer-root ec-drawer-root'
  root.id = `${idPrefix}Drawer`
  root.hidden = true
  root.innerHTML = `
    <div class="ef-side-drawer-mask role-drawer-mask" data-action="close-drawer"></div>
    <aside class="ef-side-drawer role-drawer" role="dialog" aria-label="详情">
      <header class="ef-side-drawer__head role-drawer__head">
        <div class="ef-side-drawer__brand">
          <span class="ef-side-drawer__mark" aria-hidden="true">详</span>
          <div class="ef-side-drawer__heading">
            <h2 class="ef-side-drawer__title role-drawer__title" data-role="title">详情</h2>
            <div class="ef-side-drawer__meta role-drawer__subtitle" data-role="subtitle"></div>
          </div>
        </div>
        <button type="button" class="ef-side-drawer__close role-drawer__close" data-action="close-drawer" aria-label="关闭">×</button>
      </header>
      <div class="ef-side-drawer__body role-drawer__body" data-role="body"></div>
      <footer class="ef-side-drawer__foot role-drawer__foot" data-role="foot"></footer>
    </aside>`
  page.appendChild(root)
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-drawer"]')) closeDrawer(page, idPrefix)
  })
  return root
}

export function openDrawer(page, { title, subtitle = '', body = '', foot = '', mark = '详' }, idPrefix = 'ec') {
  const root = ensureDrawer(page, idPrefix)
  root.querySelector('[data-role="title"]').textContent = title || '详情'
  root.querySelector('[data-role="subtitle"]').innerHTML = subtitle || ''
  root.querySelector('[data-role="body"]').innerHTML = body || ''
  const footEl = root.querySelector('[data-role="foot"]')
  footEl.innerHTML = foot
    ? `<div class="ef-side-drawer__actions">${foot}</div>`
    : ''
  const markEl = root.querySelector('.ef-side-drawer__mark')
  if (markEl) markEl.textContent = String(mark || '详').slice(0, 1)
  root.hidden = false
  return root
}

export function closeDrawer(page, idPrefix = 'ec') {
  const root = page.querySelector(`#${idPrefix}Drawer`)
  if (root) root.hidden = true
}

export function setBtnState(btn, state, labels = {}) {
  if (!btn) return
  const map = {
    idle: labels.idle || btn.dataset.labelIdle || '确定',
    loading: labels.loading || '处理中…',
    success: labels.success || '已完成',
    error: labels.error || '重试',
  }
  if (state === 'loading') {
    btn.disabled = true
    btn.dataset.labelIdle = btn.dataset.labelIdle || btn.textContent
    btn.textContent = map.loading
    btn.classList.add('is-loading')
  } else if (state === 'success') {
    btn.disabled = true
    btn.textContent = map.success
    btn.classList.remove('is-loading')
  } else if (state === 'error') {
    btn.disabled = false
    btn.textContent = map.error
    btn.classList.remove('is-loading')
  } else {
    btn.disabled = false
    btn.textContent = map.idle
    btn.classList.remove('is-loading')
  }
}

/** 统计技能被哪些智能体引用 */
export function buildSkillUsageMap(agents) {
  /** @type {Map<string, string[]>} */
  const map = new Map()
  for (const a of agents || []) {
    const code = String(a.agent_code || a.name || '').trim()
    const name = String(a.agent_name || code).trim()
    const skills = Array.isArray(a.skills) ? a.skills : []
    for (const s of skills) {
      const key = String(s || '').trim().toLowerCase()
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(name || code)
    }
  }
  return map
}

/** 粗略扫描应用配置中的技能引用 */
export function buildSkillAppUsageMap(apps) {
  /** @type {Map<string, string[]>} */
  const map = new Map()
  const walk = (obj, appName, out) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, appName, out))
      return
    }
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k || '').toLowerCase()
      if ((key === 'skills' || key === 'skill') && (typeof v === 'string' || Array.isArray(v))) {
        const list = Array.isArray(v) ? v : String(v).split(/[,，\s]+/)
        for (const s of list) {
          const sk = String(s || '').trim().toLowerCase()
          if (!sk) continue
          if (!out.has(sk)) out.set(sk, [])
          if (!out.get(sk).includes(appName)) out.get(sk).push(appName)
        }
      } else if (v && typeof v === 'object') {
        walk(v, appName, out)
      }
    }
  }
  for (const app of apps || []) {
    const appName = String(app?.name || app?.title || app?.id || '工作流').trim()
    walk(app, appName, map)
  }
  return map
}
