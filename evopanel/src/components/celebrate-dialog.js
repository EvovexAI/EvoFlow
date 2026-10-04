/**
 * 庆祝/引导型 Dialog（复刻 ZCode cloud-content-dialog 视觉）
 * 公共 helper，供 license 激活成功 / apps 发布成功 / 首次启动引导 等多场景复用。
 * 样式见 ../style/celebrate-dialog.css `.evo-celebrate-*`。
 */
import '../style/celebrate-dialog.css'

const PARTICLES = [
  [80, 0],
  [40, 69],
  [-40, 69],
  [-80, 0],
  [-40, -69],
  [40, -69],
]

/** hero 中心图标（lucide 风格 24x24 path，白色描边） */
const ICON_PATHS = {
  unlock: '<path d="M20 6 9 17l-5-5"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72.81 5.19 2 6.95a22 22 0 0 1 2 3.95l-3 3"/><path d="M9 12h4.5"/>',
  welcome:
    '<path d="M9.937 15.5c1.313 1.937 1.313 4.063 0 6"/><path d="M15 12c0 3-3 5-3 5s-3-2-3-5 3-5 3-5 3 2 3 5z"/><path d="M11.5 4.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/>',
  update:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
}

/**
 * @param {object} opts
 * @param {string} [opts.title]            标题
 * @param {string} [opts.descHtml]         描述 HTML（可含 <b>）
 * @param {string} [opts.heroCaption]      hero 底部小字
 * @param {'unlock'|'rocket'|'welcome'|'update'} [opts.icon='unlock']  hero 图标
 * @param {Array<{label:string,variant?:'primary'|'secondary',onClick?:Function,closeOnClick?:boolean}>} [opts.actions]  CTA
 * @param {Function} [opts.onClose]        关闭回调
 * @returns {{close:Function,overlay:HTMLElement}}
 */
export function showCelebrateDialog({
  title = '',
  descHtml = '',
  heroCaption = '',
  icon = 'unlock',
  actions = [],
  onClose,
} = {}) {
  document.querySelector('.evo-celebrate-overlay')?.remove()
  const iconPaths = ICON_PATHS[icon] || ICON_PATHS.unlock
  const overlay = document.createElement('div')
  overlay.className = 'evo-celebrate-overlay'
  overlay.innerHTML = `
    <div class="evo-celebrate-backdrop" data-close></div>
    <div class="evo-celebrate-dialog" role="dialog" aria-modal="true" aria-labelledby="evo-celebrate-title">
      <div class="evo-celebrate-hero">
        <span class="evo-celebrate-glow"></span>
        <span class="evo-celebrate-glow evo-celebrate-glow--2"></span>
        ${PARTICLES.map(
          ([px, py]) =>
            `<span class="evo-celebrate-particle" style="--px:${px}px;--py:${py}px"></span>`,
        ).join('')}
        <div class="evo-celebrate-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths}</svg>
        </div>
        ${heroCaption ? `<span class="evo-celebrate-hero-caption">${heroCaption}</span>` : ''}
      </div>
      <section class="evo-celebrate-body">
        <h2 id="evo-celebrate-title" class="evo-celebrate-title">${title}</h2>
        ${descHtml ? `<div class="evo-celebrate-desc">${descHtml}</div>` : ''}
        ${
          actions.length
            ? `<div class="evo-celebrate-actions">${actions
                .map(
                  (a, i) =>
                    `<button type="button" class="evo-celebrate-btn evo-celebrate-btn--${a.variant || 'secondary'}" data-action="${i}">${a.label || ''}</button>`,
                )
                .join('')}</div>`
            : ''
        }
      </section>
      <button type="button" class="evo-celebrate-close" data-close aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-open'))

  let closed = false
  const remove = () => overlay.remove()
  const close = () => {
    if (closed) return
    closed = true
    overlay.classList.remove('is-open')
    overlay.classList.add('is-closing')
    overlay.addEventListener('transitionend', remove, { once: true })
    setTimeout(remove, 340)
    document.removeEventListener('keydown', onKey)
    try {
      onClose?.()
    } catch {
      /* ignore */
    }
  }
  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  overlay.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close))
  actions.forEach((a, i) => {
    overlay
      .querySelector(`[data-action="${i}"]`)
      ?.addEventListener('click', () => {
        if (a.closeOnClick !== false) close()
        try {
          a.onClick?.()
        } catch {
          /* ignore */
        }
      })
  })

  return { close, overlay }
}