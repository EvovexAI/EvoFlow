/**
 * 通用列表分页（前端切片 + 底栏控件）
 * 用于智能体 / 员工名册 / 知识库等一次拉全量再本地分页的页面。
 */

export const LIST_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
export const DEFAULT_LIST_PAGE_SIZE = 20

/**
 * @param {string} storageKey
 * @param {number} [fallback]
 */
export function readStoredPageSize(storageKey, fallback = DEFAULT_LIST_PAGE_SIZE) {
  try {
    const n = Number(localStorage.getItem(storageKey))
    if (LIST_PAGE_SIZE_OPTIONS.includes(n)) return n
  } catch {
    /* ignore */
  }
  return fallback
}

/**
 * @param {string} storageKey
 * @param {number} pageSize
 */
export function writeStoredPageSize(storageKey, pageSize) {
  try {
    localStorage.setItem(storageKey, String(pageSize))
  } catch {
    /* ignore */
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} page
 * @param {number} pageSize
 */
export function paginateItems(items, page, pageSize) {
  const list = Array.isArray(items) ? items : []
  const size = Math.max(1, Number(pageSize) || DEFAULT_LIST_PAGE_SIZE)
  const total = list.length
  const pageCount = Math.max(1, Math.ceil(total / size) || 1)
  const pageNo = Math.min(Math.max(1, Number(page) || 1), pageCount)
  const start = (pageNo - 1) * size
  const slice = list.slice(start, start + size)
  return {
    items: slice,
    total,
    page: pageNo,
    pageSize: size,
    pageCount,
    from: total ? start + 1 : 0,
    to: total ? start + slice.length : 0,
  }
}

/**
 * @param {{
 *   total: number
 *   page: number
 *   pageCount: number
 *   pageSize: number
 *   unit?: string
 *   sizeOptions?: number[]
 * }} opts
 */
export function renderListPagerHtml(opts) {
  const total = Number(opts?.total) || 0
  if (total <= 0) return ''
  const page = Number(opts.page) || 1
  const pageCount = Math.max(1, Number(opts.pageCount) || 1)
  const pageSize = Number(opts.pageSize) || DEFAULT_LIST_PAGE_SIZE
  const unit = opts.unit || '条'
  const sizeOptions = opts.sizeOptions || LIST_PAGE_SIZE_OPTIONS
  const from = Number(opts.from) || (page - 1) * pageSize + 1
  const to = Number(opts.to) || Math.min(total, page * pageSize)
  const prevDisabled = page <= 1
  const nextDisabled = page >= pageCount
  return `
    <div class="ef-list-pager" data-ef-list-pager role="navigation" aria-label="列表分页">
      <span class="ef-list-pager-meta">共 ${total} ${unit} · 第 ${from}–${to} ${unit}</span>
      <label class="ef-list-pager-size">
        每页
        <select data-ef-page-size aria-label="每页条数">
          ${sizeOptions
            .map((n) => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`)
            .join('')}
        </select>
      </label>
      <div class="ef-list-pager-nav">
        <button type="button" class="ef-list-pager-btn" data-ef-page="prev"${prevDisabled ? ' disabled' : ''}>上一页</button>
        <span class="ef-list-pager-cur">${page} / ${pageCount}</span>
        <button type="button" class="ef-list-pager-btn" data-ef-page="next"${nextDisabled ? ' disabled' : ''}>下一页</button>
      </div>
    </div>`
}

/**
 * @param {ParentNode | null | undefined} root
 * @param {{
 *   page: number
 *   pageCount: number
 *   onPage: (nextPage: number) => void
 *   onPageSize: (nextSize: number) => void
 * }} handlers
 */
export function bindListPager(root, handlers) {
  if (!root || !handlers) return
  const pager = root.querySelector?.('[data-ef-list-pager]') || (root.matches?.('[data-ef-list-pager]') ? root : null)
  if (!pager) return

  pager.querySelector('[data-ef-page-size]')?.addEventListener('change', (e) => {
    const next = Number(e.target?.value || DEFAULT_LIST_PAGE_SIZE) || DEFAULT_LIST_PAGE_SIZE
    handlers.onPageSize(next)
  })

  pager.querySelectorAll('[data-ef-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.getAttribute('data-ef-page')
      const cur = Number(handlers.page) || 1
      const count = Math.max(1, Number(handlers.pageCount) || 1)
      if (dir === 'prev' && cur > 1) handlers.onPage(cur - 1)
      else if (dir === 'next' && cur < count) handlers.onPage(cur + 1)
    })
  })
}
