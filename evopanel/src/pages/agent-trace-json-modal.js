/**
 * 会话调试页：统一「完整 JSON」弹窗（可折叠树形查看，风格对齐桌面 modal-overlay）。
 */

let _seq = 1
const _stash = new Map()
let _installed = false
let _activeOverlay = null

/** @param {unknown} obj */
export function stashJsonForModal(obj) {
  const id = `atj${_seq++}`
  _stash.set(id, obj)
  return id
}

/** Read stashed payload (e.g. copy-to-clipboard); does not remove. @param {string} id */
export function peekStashedPayload(id) {
  const k = String(id ?? '').trim()
  if (!k) return undefined
  return _stash.get(k)
}

/** @param {unknown} data */
function stringifyForModal(data) {
  try {
    if (typeof data === 'string') return data
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

/** @param {unknown} payload @returns {{ mode: 'json' | 'text', value: unknown }} */
function normalizePayload(payload) {
  if (typeof payload === 'string') {
    const t = payload.trim()
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      try {
        return { mode: 'json', value: JSON.parse(t) }
      } catch {
        /* plain text */
      }
    }
    return { mode: 'text', value: payload }
  }
  if (payload !== null && (typeof payload === 'object' || Array.isArray(payload))) {
    return { mode: 'json', value: payload }
  }
  return { mode: 'json', value: payload }
}

/** @param {string} k */
function formatKeyLabel(k) {
  if (k.startsWith('[')) return k
  return JSON.stringify(k)
}

/** @param {unknown} v @returns {string} */
function valueTypeClass(v) {
  if (v === null) return 'at-json-val--null'
  if (typeof v === 'string') return 'at-json-val--string'
  if (typeof v === 'number') return 'at-json-val--number'
  if (typeof v === 'boolean') return 'at-json-val--bool'
  return 'at-json-val--other'
}

/** @param {unknown} v */
function formatPrimitive(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** @param {HTMLButtonElement} btn @param {boolean} open */
function setToggleVisual(btn, open) {
  btn.innerHTML = open
    ? '<span class="at-json-toggle-icon at-json-toggle-icon--open" aria-hidden="true"></span>'
    : '<span class="at-json-toggle-icon" aria-hidden="true"></span>'
}

/**
 * @param {HTMLElement} container
 * @param {unknown} value
 * @param {string | null} keyLabel
 * @param {number} depth
 * @param {{ defaultExpandedDepth: number }} ctx
 */
function renderJsonNode(container, value, keyLabel, depth, ctx) {
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === 'object' && !isArr
  const isContainer = isArr || isObj

  const row = document.createElement('div')
  row.className = 'at-json-node'
  row.dataset.depth = String(depth)

  const line = document.createElement('div')
  line.className = 'at-json-line'

  if (isContainer) {
    const expanded = depth < ctx.defaultExpandedDepth
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'at-json-toggle'
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    toggle.setAttribute('aria-label', expanded ? '折叠' : '展开')
    setToggleVisual(toggle, expanded)

    if (keyLabel != null) {
      const key = document.createElement('span')
      key.className = 'at-json-key'
      key.textContent = formatKeyLabel(keyLabel)
      line.appendChild(toggle)
      line.appendChild(key)
      const colon = document.createElement('span')
      colon.className = 'at-json-punct'
      colon.textContent = ': '
      line.appendChild(colon)
    } else {
      line.appendChild(toggle)
    }

    const open = document.createElement('span')
    open.className = 'at-json-punct'
    open.textContent = isArr ? '[' : '{'
    line.appendChild(open)

    const summary = document.createElement('span')
    summary.className = 'at-json-summary'
    summary.hidden = expanded
    const count = isArr ? value.length : Object.keys(value).length
    summary.textContent = isArr ? ` ${count} items ` : ` ${count} keys `
    line.appendChild(summary)

    const closeInline = document.createElement('span')
    closeInline.className = 'at-json-punct at-json-close-inline'
    closeInline.textContent = isArr ? ']' : '}'
    closeInline.hidden = !expanded
    line.appendChild(closeInline)

    row.appendChild(line)

    const children = document.createElement('div')
    children.className = 'at-json-children'
    children.hidden = !expanded

    if (expanded) {
      if (isArr) {
        for (let i = 0; i < value.length; i++) {
          renderJsonNode(children, value[i], `[${i}]`, depth + 1, ctx)
        }
      } else {
        for (const k of Object.keys(value)) {
          renderJsonNode(children, value[k], k, depth + 1, ctx)
        }
      }
      const closeRow = document.createElement('div')
      closeRow.className = 'at-json-line at-json-line--close'
      const close = document.createElement('span')
      close.className = 'at-json-punct'
      close.textContent = isArr ? ']' : '}'
      closeRow.appendChild(close)
      children.appendChild(closeRow)
    }

    row.appendChild(children)

    const setExpanded = (on) => {
      toggle.setAttribute('aria-expanded', on ? 'true' : 'false')
      toggle.setAttribute('aria-label', on ? '折叠' : '展开')
      setToggleVisual(toggle, on)
      summary.hidden = on
      closeInline.hidden = !on
      children.hidden = !on
      if (on && !children.dataset.built) {
        children.dataset.built = '1'
        children.innerHTML = ''
        if (isArr) {
          for (let i = 0; i < value.length; i++) {
            renderJsonNode(children, value[i], `[${i}]`, depth + 1, ctx)
          }
        } else {
          for (const k of Object.keys(value)) {
            renderJsonNode(children, value[k], k, depth + 1, ctx)
          }
        }
        const closeRow = document.createElement('div')
        closeRow.className = 'at-json-line at-json-line--close'
        const close = document.createElement('span')
        close.className = 'at-json-punct'
        close.textContent = isArr ? ']' : '}'
        closeRow.appendChild(close)
        children.appendChild(closeRow)
      }
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      setExpanded(children.hidden)
    })

    row._setExpanded = setExpanded
    row._isContainer = true
  } else {
    const spacer = document.createElement('span')
    spacer.className = 'at-json-toggle-spacer'
    spacer.setAttribute('aria-hidden', 'true')
    line.appendChild(spacer)

    if (keyLabel != null) {
      const key = document.createElement('span')
      key.className = 'at-json-key'
      key.textContent = formatKeyLabel(keyLabel)
      line.appendChild(key)
      const colon = document.createElement('span')
      colon.className = 'at-json-punct'
      colon.textContent = ': '
      line.appendChild(colon)
    }

    const val = document.createElement('span')
    val.className = `at-json-val ${valueTypeClass(value)}`
    val.textContent = formatPrimitive(value)
    line.appendChild(val)

    row.appendChild(line)
  }

  container.appendChild(row)
}

/** @param {HTMLElement} root @param {boolean} expand */
function setAllExpanded(root, expand) {
  if (!expand) {
    root.querySelectorAll('.at-json-node').forEach((node) => {
      if (typeof node._setExpanded === 'function') node._setExpanded(false)
    })
    return
  }
  let guard = 0
  while (guard++ < 50_000) {
    let expandedAny = false
    root.querySelectorAll('.at-json-node').forEach((node) => {
      const ch = node.querySelector(':scope > .at-json-children')
      if (ch?.hidden && typeof node._setExpanded === 'function') {
        node._setExpanded(true)
        expandedAny = true
      }
    })
    if (!expandedAny) break
  }
}

/**
 * @param {HTMLElement} scrollEl
 * @param {unknown} value
 * @param {number} defaultExpandedDepth
 */
function mountJsonTree(scrollEl, value, defaultExpandedDepth = 1_000_000) {
  scrollEl.innerHTML = ''
  const tree = document.createElement('div')
  tree.className = 'at-json-tree'
  const ctx = { defaultExpandedDepth }
  const isRootContainer =
    value !== null && (Array.isArray(value) || typeof value === 'object')
  if (isRootContainer) {
    renderJsonNode(tree, value, null, 0, ctx)
  } else {
    const line = document.createElement('div')
    line.className = 'at-json-line at-json-line--root-primitive'
    const val = document.createElement('span')
    val.className = `at-json-val ${valueTypeClass(value)}`
    val.textContent = formatPrimitive(value)
    line.appendChild(val)
    tree.appendChild(line)
  }
  scrollEl.appendChild(tree)
  scrollEl.dataset.jsonTreeRoot = '1'
  requestAnimationFrame(() => setAllExpanded(tree, true))
  return tree
}

/**
 * @param {string} titleText
 * @param {unknown} payload
 */
export function openAgentTraceJsonModal(titleText, payload) {
  const normalized = normalizePayload(payload)
  const copyText = stringifyForModal(
    normalized.mode === 'json' ? normalized.value : normalized.value
  )

  if (_activeOverlay) {
    _activeOverlay.remove()
    _activeOverlay = null
  }

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay agent-trace-json-modal-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', titleText || 'JSON')

  overlay.innerHTML = `
    <div class="modal agent-trace-json-modal-panel">
      <div class="agent-trace-json-modal-body" data-at-json-body></div>
      <div class="agent-trace-json-modal-foot">
        <button type="button" class="btn btn-ghost btn-sm" data-at-json-expand-all>全部展开</button>
        <button type="button" class="btn btn-ghost btn-sm" data-at-json-collapse-all>全部折叠</button>
        <span class="agent-trace-json-modal-foot-grow" aria-hidden="true"></span>
        <button type="button" class="btn btn-secondary btn-sm" data-at-json-copy>复制</button>
        <button type="button" class="btn btn-primary btn-sm" data-at-json-close>关闭</button>
      </div>
    </div>
  `

  const bodyEl = overlay.querySelector('[data-at-json-body]')
  const expandBtn = overlay.querySelector('[data-at-json-expand-all]')
  const collapseBtn = overlay.querySelector('[data-at-json-collapse-all]')

  if (bodyEl) {
    if (normalized.mode === 'text') {
      expandBtn?.setAttribute('hidden', '')
      collapseBtn?.setAttribute('hidden', '')
      const pre = document.createElement('pre')
      pre.className = 'agent-trace-json-modal-text'
      pre.spellcheck = false
      pre.textContent = String(normalized.value)
      bodyEl.appendChild(pre)
    } else {
      mountJsonTree(bodyEl, normalized.value)
    }
  }

  document.body.appendChild(overlay)
  _activeOverlay = overlay

  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    if (_activeOverlay === overlay) _activeOverlay = null
  }

  overlay.querySelector('[data-at-json-close]')?.addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelector('[data-at-json-copy]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyText)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = copyText
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      } catch {
        /* ignore */
      }
    }
  })

  overlay.querySelector('[data-at-json-expand-all]')?.addEventListener('click', () => {
    const tree = bodyEl?.querySelector('.at-json-tree')
    if (tree) setAllExpanded(tree, true)
  })
  overlay.querySelector('[data-at-json-collapse-all]')?.addEventListener('click', () => {
    const tree = bodyEl?.querySelector('.at-json-tree')
    if (tree) setAllExpanded(tree, false)
  })

  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  overlay.querySelector('[data-at-json-close]')?.focus()
}

export function installAgentTraceJsonModalDelegate() {
  if (_installed) return
  _installed = true
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.agent-trace-json-modal-open')
    if (!btn) return
    const id = btn.getAttribute('data-json-ref')
    const title = btn.getAttribute('data-json-title') || 'JSON'
    if (!id || !_stash.has(id)) return
    e.preventDefault()
    openAgentTraceJsonModal(title, _stash.get(id))
  })
}
