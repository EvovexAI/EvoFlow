/**
 * Card-based editor for app run parameters (summary + expand to edit).
 */
import { toast } from '../components/toast.js'
import { serializeParamsForEditor, parseParamsFromEditor } from './app-run-form.js'

const TYPE_OPTIONS = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '下拉选择' },
]

const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]))

/** Common Chinese → english stubs for param id generation */
const ZH_TOKEN = {
  输出: 'output',
  路径: 'path',
  文件: 'file',
  名称: 'name',
  标题: 'title',
  主题: 'topic',
  城市: 'city',
  内容: 'content',
  格式: 'format',
  类型: 'type',
  数量: 'count',
  地址: 'url',
  链接: 'url',
  目录: 'dir',
  结果: 'result',
  输入: 'input',
  参数: 'param',
  选项: 'option',
  模型: 'model',
  提示: 'prompt',
  文本: 'text',
  数字: 'number',
}

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function typeLabel(type) {
  return TYPE_LABEL[type] || TYPE_LABEL.text
}

function normalizeParam(p = {}) {
  const name = String(p.name || p.key || '').trim()
  const type = ['text', 'textarea', 'select', 'number'].includes(String(p.type || ''))
    ? String(p.type)
    : 'text'
  const opts = Array.isArray(p.options)
    ? p.options.map((o) => (typeof o === 'string' ? o : o?.value ?? o)).filter(Boolean).join(', ')
    : String(p.options || '').trim()
  return {
    name,
    label: String(p.label || name).trim() || name,
    type,
    default: p.default != null ? String(p.default) : '',
    required: p.required !== false,
    options: opts,
    /** Existing ids stay stable; new/empty names follow label until manually edited */
    nameLocked: p.nameLocked != null ? Boolean(p.nameLocked) : Boolean(name),
    expanded: Boolean(p.expanded),
    menuOpen: false,
  }
}

export function slugifyParamId(label) {
  let s = String(label || '').trim().toLowerCase()
  if (!s) return 'param'

  // Replace known Chinese tokens first
  for (const [zh, en] of Object.entries(ZH_TOKEN)) {
    if (s.includes(zh)) s = s.split(zh).join(`_${en}_`)
  }

  s = s
    .replace(/[\s\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  if (!s) s = 'param'
  if (!/^[a-z_]/.test(s)) s = `p_${s}`
  if (s.length > 48) s = s.slice(0, 48).replace(/_+$/, '')
  return s || 'param'
}

export function uniqueParamName(base, existing, skipIndex = -1) {
  let root = slugifyParamId(base)
  const taken = new Set(
    existing
      .map((p, i) => (i === skipIndex ? '' : String(p.name || '').trim()))
      .filter(Boolean),
  )
  if (!taken.has(root)) return root
  let n = 2
  while (taken.has(`${root}_${n}`)) n += 1
  return `${root}_${n}`
}

function optionsPreview(options, max = 3) {
  const list = String(options || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length) return ''
  const head = list.slice(0, max).join('、')
  return list.length > max ? `${head}…` : head
}

function cardHtml(p, index, total) {
  const typeZh = typeLabel(p.type)
  const reqBadge = p.required
    ? `<span class="app-param-badge app-param-badge--req">必填</span>`
    : `<span class="app-param-badge">选填</span>`
  const defLine = p.default
    ? `<div class="app-param-card-line">默认值：${escapeHtml(p.default)}</div>`
    : ''
  const optPreview = p.type === 'select' ? optionsPreview(p.options) : ''
  const optLine = optPreview
    ? `<div class="app-param-card-line">候选值：${escapeHtml(optPreview)}</div>`
    : ''
  const typeOpts = TYPE_OPTIONS.map(
    (o) =>
      `<option value="${o.value}"${o.value === p.type ? ' selected' : ''}>${o.label}</option>`,
  ).join('')
  const title = p.label || p.name || '未命名参数'
  const idLine = [p.name || '（未设置标识）', typeZh].filter(Boolean).join(' · ')

  return `
    <article class="app-param-card${p.expanded ? ' is-expanded' : ''}" data-param-row="${index}">
      <header class="app-param-card-head" data-act="toggle-expand">
        <div class="app-param-card-main">
          <div class="app-param-card-title-row">
            <span class="app-param-card-title">${escapeHtml(title)}</span>
            ${reqBadge}
          </div>
          <div class="app-param-card-meta">${escapeHtml(idLine)}</div>
          ${defLine}
          ${optLine}
        </div>
        <div class="app-param-card-tools" data-stop>
          <div class="app-param-more${p.menuOpen ? ' is-open' : ''}">
            <button type="button" class="app-param-more-btn" data-act="toggle-menu" aria-label="更多操作" aria-haspopup="menu" aria-expanded="${p.menuOpen ? 'true' : 'false'}">⋯</button>
            <div class="app-param-more-panel" role="menu" ${p.menuOpen ? '' : 'hidden'}>
              <button type="button" class="app-param-more-item" role="menuitem" data-act="duplicate">复制参数</button>
              <button type="button" class="app-param-more-item" role="menuitem" data-act="move-up"${index === 0 ? ' disabled' : ''}>上移</button>
              <button type="button" class="app-param-more-item" role="menuitem" data-act="move-down"${index >= total - 1 ? ' disabled' : ''}>下移</button>
              <button type="button" class="app-param-more-item app-param-more-item--danger" role="menuitem" data-act="remove">删除参数</button>
            </div>
          </div>
        </div>
      </header>
      <div class="app-param-card-body"${p.expanded ? '' : ' hidden'}>
        <label class="app-param-field">
          <span class="app-param-field-label">显示名称</span>
          <span class="app-param-field-hint">运行时展示给使用者</span>
          <input class="form-input" data-k="label" value="${escapeAttr(p.label)}" placeholder="例如：输出路径" autocomplete="off">
        </label>
        <label class="app-param-field">
          <span class="app-param-field-label">参数标识</span>
          <span class="app-param-field-hint">供工作流引用，仅英文、数字和下划线</span>
          <input class="form-input" data-k="name" value="${escapeAttr(p.name)}" placeholder="output_path" autocomplete="off" spellcheck="false">
        </label>
        <label class="app-param-field">
          <span class="app-param-field-label">参数类型</span>
          <select class="form-input" data-k="type">${typeOpts}</select>
        </label>
        <label class="app-param-field">
          <span class="app-param-field-label">默认值</span>
          <input class="form-input" data-k="default" value="${escapeAttr(p.default)}" placeholder="可选" autocomplete="off">
        </label>
        <label class="app-param-check">
          <input type="checkbox" data-k="required"${p.required ? ' checked' : ''}>
          <span>必填参数</span>
        </label>
        <details class="app-param-advanced"${p.type === 'select' || p.options ? ' open' : ''}>
          <summary>高级设置</summary>
          <label class="app-param-field">
            <span class="app-param-field-label">候选值</span>
            <span class="app-param-field-hint">下拉选项，用逗号分隔；非下拉类型可留空</span>
            <input class="form-input" data-k="options" value="${escapeAttr(p.options)}" placeholder="markdown, json, html" autocomplete="off">
          </label>
        </details>
      </div>
    </article>`
}

/**
 * Mount interactive params editor into `root`.
 * @param {HTMLElement} root
 * @param {unknown[]} params
 * @returns {{ collect: () => object[], destroy: () => void }}
 */
export function mountParamsEditor(root, params = []) {
  let rows = (Array.isArray(params) ? params : []).map(normalizeParam).filter((p) => p.name)
  let undoTimer = null
  let undone = null

  const closeMenus = () => {
    rows = rows.map((r) => ({ ...r, menuOpen: false }))
  }

  const render = () => {
    root.innerHTML = `
      <div class="app-params-editor">
        <div class="app-params-head">
          <div>
            <div class="app-params-title">运行参数</div>
            <p class="app-params-hint">决定工作流运行时需要填写的内容。步骤说明里可插入 {{参数标识}}。</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" data-act="add">+ 添加参数</button>
        </div>
        <div class="app-params-list" data-role="list">
          ${
            rows.length
              ? rows.map((p, i) => cardHtml(p, i, rows.length)).join('')
              : `<div class="app-params-empty">还没有参数。若不需要运行时填写，可直接跳过。</div>`
          }
        </div>
        <details class="app-params-dsl">
          <summary>高级：管道文本批量编辑</summary>
          <textarea class="form-input" data-role="dsl" rows="3" placeholder="topic|主题|text||1">${escapeAttr(
            serializeParamsForEditor(rows.map(toPersist)),
          )}</textarea>
          <p class="form-hint">仅在需要批量粘贴时使用；保存时以上方卡片为准，除非你改了这段并点同步。</p>
          <button type="button" class="btn btn-ghost btn-xs" data-act="sync-dsl">从文本同步到卡片</button>
        </details>
      </div>`
  }

  const toPersist = (p) => {
    const param = {
      name: String(p.name || '').trim(),
      label: String(p.label || p.name || '').trim() || String(p.name || '').trim(),
      type: TYPE_OPTIONS.some((o) => o.value === p.type) ? p.type : 'text',
      default: String(p.default ?? ''),
      required: p.required !== false,
      description: '',
    }
    if (param.type === 'select' || p.options) {
      const opts = String(p.options || '')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (opts.length) param.options = opts
    }
    return param
  }

  const readRowsFromDom = () => {
    const next = []
    root.querySelectorAll('[data-param-row]').forEach((row, index) => {
      const prev = rows[index] || {}
      const get = (k) => row.querySelector(`[data-k="${k}"]`)
      const name = String(get('name')?.value || prev.name || '').trim()
      const label = String(get('label')?.value || prev.label || '').trim()
      const typeRaw = String(get('type')?.value || prev.type || 'text')
      const type = TYPE_OPTIONS.some((o) => o.value === typeRaw) ? typeRaw : 'text'
      next.push({
        name,
        label: label || name,
        type,
        default: String(get('default')?.value ?? prev.default ?? ''),
        required: get('required') ? !!get('required').checked : prev.required !== false,
        options: String(get('options')?.value ?? prev.options ?? ''),
        nameLocked: Boolean(prev.nameLocked),
        expanded: Boolean(prev.expanded),
        menuOpen: false,
      })
    })
    return next
  }

  const syncFromDom = () => {
    if (root.querySelector('[data-param-row]')) {
      rows = readRowsFromDom()
    }
  }

  const showUndo = (removed, index) => {
    if (undoTimer) clearTimeout(undoTimer)
    undone = { param: removed, index }
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'toast-action'
    action.textContent = '撤销'
    action.addEventListener('click', () => {
      if (!undone) return
      const { param, index: idx } = undone
      undone = null
      syncFromDom()
      const insertAt = Math.min(Math.max(0, idx), rows.length)
      rows.splice(insertAt, 0, { ...param, expanded: false, menuOpen: false })
      render()
      toast.success('已恢复参数')
    })
    toast.info(`参数「${removed.label || removed.name || '未命名'}」已删除`, {
      duration: 5000,
      action,
    })
    undoTimer = setTimeout(() => {
      undone = null
    }, 5200)
  }

  const onClick = (e) => {
    const actBtn = e.target?.closest?.('[data-act]')
    const act = actBtn?.dataset?.act
    if (!act) {
      if (!e.target?.closest?.('.app-param-more')) {
        const hadOpen = rows.some((r) => r.menuOpen)
        if (hadOpen) {
          syncFromDom()
          closeMenus()
          render()
        }
      }
      return
    }
    e.preventDefault()
    e.stopPropagation()

    if (act === 'add') {
      syncFromDom()
      const name = uniqueParamName('param', rows)
      rows.push(
        normalizeParam({
          name,
          label: '',
          type: 'text',
          required: true,
          expanded: true,
          nameLocked: false,
        }),
      )
      render()
      root.querySelector('[data-param-row]:last-of-type [data-k="label"]')?.focus()
      return
    }

    if (act === 'sync-dsl') {
      const text = root.querySelector('[data-role="dsl"]')?.value || ''
      rows = parseParamsFromEditor(text).map((p) => normalizeParam(p))
      render()
      return
    }

    const rowEl = actBtn.closest('[data-param-row]')
    const index = rowEl ? Number(rowEl.getAttribute('data-param-row')) : -1
    if (index < 0 || Number.isNaN(index)) return

    syncFromDom()

    if (act === 'toggle-expand') {
      if (e.target?.closest?.('[data-stop]')) return
      rows = rows.map((r, i) => ({
        ...r,
        expanded: i === index ? !r.expanded : r.expanded,
        menuOpen: false,
      }))
      render()
      return
    }

    if (act === 'toggle-menu') {
      rows = rows.map((r, i) => ({
        ...r,
        menuOpen: i === index ? !r.menuOpen : false,
      }))
      render()
      return
    }

    if (act === 'duplicate') {
      const src = rows[index]
      if (!src) return
      const copy = {
        ...src,
        name: uniqueParamName(src.name || src.label || 'param', rows),
        label: src.label ? `${src.label} 副本` : src.label,
        expanded: true,
        menuOpen: false,
        nameLocked: true,
      }
      rows.splice(index + 1, 0, copy)
      render()
      return
    }

    if (act === 'move-up' && index > 0) {
      const tmp = rows[index - 1]
      rows[index - 1] = rows[index]
      rows[index] = tmp
      rows = rows.map((r) => ({ ...r, menuOpen: false }))
      render()
      return
    }

    if (act === 'move-down' && index < rows.length - 1) {
      const tmp = rows[index + 1]
      rows[index + 1] = rows[index]
      rows[index] = tmp
      rows = rows.map((r) => ({ ...r, menuOpen: false }))
      render()
      return
    }

    if (act === 'remove') {
      const removed = rows[index]
      rows.splice(index, 1)
      render()
      if (removed) showUndo(removed, index)
    }
  }

  const onInput = (e) => {
    const row = e.target?.closest?.('[data-param-row]')
    if (!row) return
    const index = Number(row.getAttribute('data-param-row'))
    if (Number.isNaN(index) || !rows[index]) return
    const key = e.target?.dataset?.k
    if (!key) return

    if (key === 'label') {
      const label = String(e.target.value || '')
      rows[index].label = label
      if (!rows[index].nameLocked) {
        const nextName = uniqueParamName(label || 'param', rows, index)
        rows[index].name = nextName
        const nameInput = row.querySelector('[data-k="name"]')
        if (nameInput && nameInput !== document.activeElement) nameInput.value = nextName
      }
      const titleEl = row.querySelector('.app-param-card-title')
      if (titleEl) titleEl.textContent = label.trim() || rows[index].name || '未命名参数'
      return
    }

    if (key === 'name') {
      rows[index].name = String(e.target.value || '')
      rows[index].nameLocked = true
      const meta = row.querySelector('.app-param-card-meta')
      if (meta) {
        meta.textContent = `${rows[index].name || '（未设置标识）'} · ${typeLabel(rows[index].type)}`
      }
      return
    }

    if (key === 'default') {
      rows[index].default = String(e.target.value || '')
      return
    }

    if (key === 'options') {
      rows[index].options = String(e.target.value || '')
    }
  }

  const onChange = (e) => {
    const row = e.target?.closest?.('[data-param-row]')
    if (!row) return
    const index = Number(row.getAttribute('data-param-row'))
    if (Number.isNaN(index) || !rows[index]) return
    const key = e.target?.dataset?.k
    if (key === 'type') {
      rows[index].type = String(e.target.value || 'text')
      const meta = row.querySelector('.app-param-card-meta')
      if (meta) {
        meta.textContent = `${rows[index].name || '（未设置标识）'} · ${typeLabel(rows[index].type)}`
      }
      const adv = row.querySelector('.app-param-advanced')
      if (adv && rows[index].type === 'select') adv.open = true
      return
    }
    if (key === 'required') {
      rows[index].required = !!e.target.checked
      const badge = row.querySelector('.app-param-badge')
      if (badge) {
        badge.textContent = rows[index].required ? '必填' : '选填'
        badge.classList.toggle('app-param-badge--req', rows[index].required)
      }
    }
  }

  render()
  root.addEventListener('click', onClick)
  root.addEventListener('input', onInput)
  root.addEventListener('change', onChange)

  return {
    collect() {
      syncFromDom()
      return rows.map(toPersist).filter((p) => p.name)
    },
    destroy() {
      if (undoTimer) clearTimeout(undoTimer)
      root.removeEventListener('click', onClick)
      root.removeEventListener('input', onInput)
      root.removeEventListener('change', onChange)
      root.innerHTML = ''
    },
  }
}
