/**
 * 把智能体中心原「技能 / 连接器」页嵌进设置中心。
 * 复用 skills.js / tools.js 的 render + #expert-primary-action 约定。
 */

/**
 * @param {HTMLElement} container
 * @param {{
 *   moduleLoader: () => Promise<{ render: () => Promise<HTMLElement>, cleanup?: () => void }>,
 *   primaryLabel: string,
 *   primaryTitle?: string,
 * }} opts
 * @returns {Promise<() => void>} cleanup
 */
export async function mountExpertModuleInto(container, opts) {
  const { moduleLoader, primaryLabel, primaryTitle = '' } = opts
  container.innerHTML = ''

  const wrap = document.createElement('div')
  wrap.className = 'expert-page settings-expert-embed'
  wrap.innerHTML = `
    <header class="settings-expert-embed-head">
      <button
        type="button"
        class="btn btn-primary"
        id="expert-primary-action"
        title="${String(primaryTitle || primaryLabel).replace(/"/g, '&quot;')}"
      >${primaryLabel}</button>
    </header>
    <div class="settings-expert-embed-body"></div>
  `
  container.appendChild(wrap)

  const mod = await moduleLoader()
  const page = await mod.render()
  const body = wrap.querySelector('.settings-expert-embed-body')
  if (page instanceof HTMLElement) {
    body?.appendChild(page)
    try {
      page._bindExpertHeader?.()
    } catch (_) {}
    try {
      page._syncExpertPrimaryAction?.()
    } catch (_) {}
  } else if (typeof page === 'string' && body) {
    body.innerHTML = page
  }

  return () => {
    try {
      mod.cleanup?.()
    } catch (_) {}
    container.innerHTML = ''
  }
}
