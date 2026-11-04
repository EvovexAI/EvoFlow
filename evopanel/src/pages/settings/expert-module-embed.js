/**
 * 把智能体中心原「技能 / 连接器」页嵌进设置中心。
 * 复用 skills.js / tools.js 的 render + #expert-primary-action 约定。
 * 安装按钮与「已安装 / 市场」放同一行，避免单独顶栏占高。
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
  wrap.innerHTML = `<div class="settings-expert-embed-body"></div>`
  container.appendChild(wrap)

  const mod = await moduleLoader()
  const page = await mod.render()
  const body = wrap.querySelector('.settings-expert-embed-body')
  if (page instanceof HTMLElement) {
    body?.appendChild(page)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-primary btn-sm'
    btn.id = 'expert-primary-action'
    btn.textContent = primaryLabel
    btn.title = String(primaryTitle || primaryLabel)

    const subtabs = page.querySelector('.ec-subtabs, .role-subtabs')
    if (subtabs) {
      const row = document.createElement('div')
      row.className = 'settings-expert-embed-toolbar'
      subtabs.parentNode?.insertBefore(row, subtabs)
      row.appendChild(subtabs)
      row.appendChild(btn)
    } else {
      const row = document.createElement('div')
      row.className = 'settings-expert-embed-toolbar'
      page.prepend(row)
      row.appendChild(btn)
    }

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
