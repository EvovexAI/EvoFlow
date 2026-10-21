/**
 * Progressive enhancement for native `<select>` — matches React DropdownSelect UI.
 * Keeps the native select in the DOM for FormData / querySelector / change listeners.
 */

/** @typedef {'field' | 'pill'} DropdownVariant */
/** @typedef {'up' | 'down'} DropdownPlacement */

/**
 * @typedef {Object} EnhanceSelectOptions
 * @property {DropdownVariant} [variant]
 * @property {DropdownPlacement} [placement]
 * @property {boolean} [portal]
 * @property {string} [className]
 * @property {string} [triggerClassName]
 * @property {string} [menuClassName]
 * @property {string} [placeholder]
 * @property {string} [emptyLabel]
 * @property {string} [ariaLabel]
 * @property {string} [title]
 */

/** @type {WeakMap<HTMLSelectElement, EnhancedSelectInstance>} */
const INSTANCES = new WeakMap()

let _listIdSeq = 0
let _bootstrapStarted = false

function nextListId() {
  _listIdSeq += 1
  return `ef-dropdown-select-list-${_listIdSeq}`
}

function shouldSkipSelect(selectEl) {
  if (!selectEl || selectEl.tagName !== 'SELECT') return true
  if (selectEl.multiple) return true
  if (selectEl.dataset.efEnhanced === '1') return true
  if (selectEl.dataset.efNative === '1') return true
  if (selectEl.hasAttribute('data-ef-no-enhance')) return true
  return false
}

function readBoolAttr(el, name, fallback) {
  const raw = el.getAttribute(name)
  if (raw == null || raw === '') return fallback
  if (raw === '0' || raw === 'false') return false
  if (raw === '1' || raw === 'true') return true
  return fallback
}

/**
 * @param {HTMLSelectElement} selectEl
 * @param {EnhanceSelectOptions} [opts]
 */
function resolveOptions(selectEl, opts = {}) {
  const variantRaw = opts.variant ?? selectEl.dataset.efVariant ?? 'field'
  const variant = variantRaw === 'pill' ? 'pill' : 'field'
  const placementRaw = opts.placement ?? selectEl.dataset.efPlacement
  const placement =
    placementRaw === 'up' || placementRaw === 'down'
      ? placementRaw
      : variant === 'pill'
        ? 'up'
        : 'down'
  const portal = opts.portal ?? readBoolAttr(selectEl, 'data-ef-portal', true)

  return {
    variant,
    placement,
    portal,
    className: opts.className ?? selectEl.dataset.efClass ?? '',
    triggerClassName: opts.triggerClassName ?? selectEl.dataset.efTriggerClass ?? '',
    menuClassName: opts.menuClassName ?? selectEl.dataset.efMenuClass ?? '',
    placeholder:
      opts.placeholder ??
      selectEl.getAttribute('data-placeholder') ??
      selectEl.getAttribute('placeholder') ??
      '请选择…',
    emptyLabel: opts.emptyLabel ?? selectEl.dataset.efEmptyLabel ?? '',
    ariaLabel: opts.ariaLabel ?? selectEl.getAttribute('aria-label') ?? undefined,
    title: opts.title ?? selectEl.getAttribute('title') ?? undefined,
  }
}

/** @param {HTMLOptionElement} opt */
function optionLabel(opt) {
  return (opt.label || opt.textContent || '').trim()
}

/** @param {HTMLSelectElement} selectEl */
function collectSelectStructure(selectEl) {
  /** @type {{ type: 'option', value: string, label: string, disabled: boolean, description?: string }[]} */
  const flat = []
  /** @type {{ label: string, options: typeof flat }[]} */
  const groups = []
  /** @type {typeof flat | null} */
  let currentBucket = flat

  for (const node of selectEl.children) {
    if (node.tagName === 'OPTGROUP') {
      const group = {
        label: (node.label || node.getAttribute('label') || '').trim(),
        options: [],
      }
      groups.push(group)
      currentBucket = group.options
      for (const child of node.children) {
        if (child.tagName !== 'OPTION') continue
        currentBucket.push({
          type: 'option',
          value: child.value,
          label: optionLabel(child),
          disabled: child.disabled,
          description: child.dataset.description || child.getAttribute('data-description') || undefined,
        })
      }
      currentBucket = flat
      continue
    }
    if (node.tagName === 'OPTION') {
      flat.push({
        type: 'option',
        value: node.value,
        label: optionLabel(node),
        disabled: node.disabled,
        description: node.dataset.description || node.getAttribute('data-description') || undefined,
      })
    }
  }

  return { flat, groups, hasGroups: groups.length > 0 }
}

/**
 * @param {HTMLButtonElement} trigger
 * @param {HTMLElement | null} menu
 * @param {'up' | 'down'} placement
 */
function updatePortalPosition(trigger, menu, placement) {
  if (!menu) return
  const r = trigger.getBoundingClientRect()
  const gap = 8
  const sidePad = 10
  const minW = Math.max(r.width, 160)
  const maxH = Math.min(320, window.innerHeight * 0.5)

  menu.style.position = 'fixed'
  menu.style.left = `${Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - minW))}px`
  menu.style.minWidth = `${minW}px`
  menu.style.zIndex = '10060'

  if (placement === 'up') {
    const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
    menu.style.bottom = `${bottom}px`
    menu.style.top = 'auto'
    menu.style.maxHeight = `${Math.max(80, Math.min(maxH, r.top - gap - sidePad))}px`
  } else {
    const top = Math.min(window.innerHeight - sidePad - 80, r.bottom + gap)
    menu.style.top = `${top}px`
    menu.style.bottom = 'auto'
    menu.style.maxHeight = `${Math.max(80, Math.min(maxH, window.innerHeight - top - sidePad))}px`
  }
}

/**
 * @param {HTMLSelectElement} selectEl
 * @param {EnhanceSelectOptions} opts
 */
function createEnhancedInstance(selectEl, opts) {
  const config = resolveOptions(selectEl, opts)
  const listId = nextListId()

  const root = document.createElement('div')
  root.className = `ef-dropdown-select ef-dropdown-select--${config.variant}`

  const parent = selectEl.parentNode
  if (!parent) return null
  parent.insertBefore(root, selectEl)
  root.appendChild(selectEl)

  selectEl.classList.add('sr-only')
  selectEl.tabIndex = -1
  selectEl.dataset.efEnhanced = '1'
  selectEl.setAttribute('aria-hidden', 'true')

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = `ef-dropdown-select__trigger ef-dropdown-select__trigger--${config.variant}`

  // Preserve layout hooks from the native select (width / filter bars / form fields).
  const selectClass = String(selectEl.className || '')
  const fillWidth = /\b(form-input|hire-input|cron-select|cron-input|role-filter-select|tasks-filter-select|pro-kanban-select|pro-org-select|sec-select)\b/.test(
    selectClass,
  )

  const valueEl = document.createElement('span')
  valueEl.className = 'ef-dropdown-select__value'

  const caretEl = document.createElement('span')
  caretEl.className = 'ef-dropdown-select__caret'
  caretEl.setAttribute('aria-hidden', 'true')
  caretEl.textContent = '▾'

  trigger.appendChild(valueEl)
  trigger.appendChild(caretEl)
  root.appendChild(trigger)

  /** @type {HTMLDivElement | null} */
  let menu = null
  let open = false
  let unhookValue = () => {}
  /** @type {(() => void) | null} */
  let detachOpenListeners = null
  /** @type {(() => void) | null} */
  let detachPortalListeners = null

  const applyRootClasses = () => {
    root.className = [
      'ef-dropdown-select',
      `ef-dropdown-select--${config.variant}`,
      fillWidth ? 'ef-dropdown-select--fill' : '',
      open ? 'is-open' : '',
      selectEl.disabled ? 'is-disabled' : '',
      config.className,
    ]
      .filter(Boolean)
      .join(' ')
  }

  const getSelectedOption = () => {
    const idx = selectEl.selectedIndex
    if (idx < 0) return null
    return selectEl.options[idx] || null
  }

  const syncTriggerFromSelect = () => {
    const selected = getSelectedOption()
    const hasValue = selected != null && String(selectEl.value) !== ''
    const label = selected ? optionLabel(selected) : ''
    const triggerText =
      label || (hasValue ? config.emptyLabel || selectEl.value : config.placeholder)
    const showPlaceholder = !label && !hasValue

    valueEl.textContent = triggerText
    trigger.classList.toggle('is-placeholder', showPlaceholder)
    trigger.disabled = selectEl.disabled
    applyRootClasses()
  }

  const removeMenu = () => {
    if (menu) {
      menu.remove()
      menu = null
    }
  }

  const close = () => {
    if (!open) return
    open = false
    trigger.classList.remove('is-open')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-controls')
    applyRootClasses()
    removeMenu()
    detachOpenListeners?.()
    detachOpenListeners = null
    detachPortalListeners?.()
    detachPortalListeners = null
  }

  const pickValue = (value) => {
    const prev = selectEl.value
    selectEl.value = value
    if (selectEl.value !== prev || value === '') {
      selectEl.dispatchEvent(new Event('input', { bubbles: true }))
      selectEl.dispatchEvent(new Event('change', { bubbles: true }))
    }
    syncTriggerFromSelect()
    close()
    trigger.focus()
  }

  const renderOptionButton = (opt) => {
    const active = opt.value === selectEl.value
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.role = 'option'
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
    btn.disabled = opt.disabled
    btn.className = `ef-dropdown-select__item${active ? ' ef-dropdown-select__item--active' : ''}`
    btn.addEventListener('click', () => {
      if (opt.disabled) return
      pickValue(opt.value)
    })

    const label = document.createElement('span')
    label.className = 'ef-dropdown-select__item-label'
    label.textContent = opt.label
    btn.appendChild(label)

    if (opt.description) {
      const desc = document.createElement('span')
      desc.className = 'ef-dropdown-select__item-desc'
      desc.textContent = opt.description
      btn.appendChild(desc)
    }

    return btn
  }

  const buildMenu = () => {
    removeMenu()
    menu = document.createElement('div')
    menu.id = listId
    menu.role = 'listbox'
    menu.className = [
      'ef-dropdown-select__menu',
      `ef-dropdown-select__menu--${config.placement}`,
      config.portal ? 'ef-dropdown-select__menu--portal' : '',
      config.menuClassName,
    ]
      .filter(Boolean)
      .join(' ')

    const { flat, groups, hasGroups } = collectSelectStructure(selectEl)

    if (!hasGroups) {
      for (const opt of flat) {
        menu.appendChild(renderOptionButton(opt))
      }
    } else {
      if (flat.length) {
        for (const opt of flat) {
          menu.appendChild(renderOptionButton(opt))
        }
      }
      for (const g of groups) {
        const groupEl = document.createElement('div')
        groupEl.className = 'ef-dropdown-select__group'
        groupEl.setAttribute('role', 'group')
        if (g.label) groupEl.setAttribute('aria-label', g.label)

        const groupLabel = document.createElement('div')
        groupLabel.className = 'ef-dropdown-select__group-label'
        groupLabel.textContent = g.label
        groupEl.appendChild(groupLabel)

        for (const opt of g.options) {
          groupEl.appendChild(renderOptionButton(opt))
        }
        menu.appendChild(groupEl)
      }
    }

    if (!flat.length && !groups.some((g) => g.options.length)) {
      const empty = document.createElement('div')
      empty.className = 'ef-dropdown-select__empty'
      empty.textContent = '暂无选项'
      menu.appendChild(empty)
    }

    if (config.portal) {
      document.body.appendChild(menu)
      updatePortalPosition(trigger, menu, config.placement)
    } else {
      root.appendChild(menu)
    }
  }

  const openMenu = () => {
    if (selectEl.disabled || open) return
    syncTriggerFromSelect()
    open = true
    trigger.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
    trigger.setAttribute('aria-controls', listId)
    applyRootClasses()
    buildMenu()

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        trigger.focus()
      }
    }
    const onPointer = (e) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (root.contains(t)) return
      if (menu?.contains(t)) return
      close()
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    detachOpenListeners = () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }

    if (config.portal && menu) {
      const update = () => updatePortalPosition(trigger, menu, config.placement)
      window.addEventListener('resize', update)
      window.addEventListener('scroll', update, true)
      detachPortalListeners = () => {
        window.removeEventListener('resize', update)
        window.removeEventListener('scroll', update, true)
      }
    }
  }

  trigger.addEventListener('click', () => {
    if (selectEl.disabled) return
    if (open) close()
    else openMenu()
  })

  if (config.ariaLabel) trigger.setAttribute('aria-label', config.ariaLabel)
  if (config.title) trigger.setAttribute('title', config.title)
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')

  if (config.triggerClassName) {
    for (const cls of config.triggerClassName.split(/\s+/).filter(Boolean)) {
      trigger.classList.add(cls)
    }
  }

  unhookValue = hookSelectValue(selectEl, syncTriggerFromSelect)

  const optionObserver = new MutationObserver(() => {
    syncTriggerFromSelect()
    if (open) buildMenu()
  })
  optionObserver.observe(selectEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'label', 'value'],
  })

  const disabledObserver = new MutationObserver(() => {
    syncTriggerFromSelect()
    if (selectEl.disabled && open) close()
  })
  disabledObserver.observe(selectEl, { attributes: true, attributeFilter: ['disabled'] })

  selectEl.addEventListener('change', syncTriggerFromSelect)

  syncTriggerFromSelect()

  /** @type {EnhancedSelectInstance} */
  const instance = {
    selectEl,
    root,
    trigger,
    refresh: () => {
      syncTriggerFromSelect()
      if (open) buildMenu()
    },
    close,
    destroy: () => {
      close()
      optionObserver.disconnect()
      disabledObserver.disconnect()
      selectEl.removeEventListener('change', syncTriggerFromSelect)
      unhookValue()
      delete selectEl.dataset.efEnhanced
      selectEl.removeAttribute('aria-hidden')
      selectEl.classList.remove('sr-only')
      selectEl.removeAttribute('tabindex')
      if (root.parentNode) {
        root.parentNode.insertBefore(selectEl, root)
        root.remove()
      }
    },
  }

  INSTANCES.set(selectEl, instance)
  return instance
}

/**
 * @param {HTMLSelectElement} selectEl
 * @param {(field: 'value' | 'selectedIndex') => void} onSync
 */
function hookSelectValue(selectEl, onSync) {
  const proto = HTMLSelectElement.prototype
  const valueDesc = Object.getOwnPropertyDescriptor(proto, 'value')
  const indexDesc = Object.getOwnPropertyDescriptor(proto, 'selectedIndex')
  if (!valueDesc?.set || !indexDesc?.set) return () => {}

  try {
    Object.defineProperty(selectEl, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        return valueDesc.get.call(this)
      },
      set(v) {
        const prev = valueDesc.get.call(this)
        valueDesc.set.call(this, v)
        if (prev !== valueDesc.get.call(this)) onSync()
      },
    })
    Object.defineProperty(selectEl, 'selectedIndex', {
      configurable: true,
      enumerable: true,
      get() {
        return indexDesc.get.call(this)
      },
      set(v) {
        const prev = indexDesc.get.call(this)
        indexDesc.set.call(this, v)
        if (prev !== indexDesc.get.call(this)) onSync()
      },
    })
  } catch {
    return () => {}
  }

  return () => {
    try {
      delete selectEl.value
      delete selectEl.selectedIndex
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {HTMLSelectElement} selectEl
 * @param {EnhanceSelectOptions} [opts]
 * @returns {EnhancedSelectInstance | null}
 */
export function enhanceSelect(selectEl, opts) {
  if (shouldSkipSelect(selectEl)) {
    return INSTANCES.get(selectEl) || null
  }
  const existing = INSTANCES.get(selectEl)
  if (existing) {
    existing.refresh()
    return existing
  }
  return createEnhancedInstance(selectEl, opts || {})
}

/**
 * @param {ParentNode} root
 * @param {EnhanceSelectOptions} [opts]
 * @returns {EnhancedSelectInstance[]}
 */
export function enhanceSelectsIn(root, opts) {
  const scope = root && 'querySelectorAll' in root ? root : document
  const selects = scope.querySelectorAll('select')
  /** @type {EnhancedSelectInstance[]} */
  const enhanced = []
  selects.forEach((el) => {
    if (shouldSkipSelect(el)) return
    const inst = enhanceSelect(el, opts)
    if (inst) enhanced.push(inst)
  })
  return enhanced
}

/** @param {HTMLSelectElement} selectEl */
export function destroyEnhancedSelect(selectEl) {
  const inst = INSTANCES.get(selectEl)
  if (!inst) return
  inst.destroy()
  INSTANCES.delete(selectEl)
}

/** Auto-enhance on load and dynamically inserted selects. */
export function initDropdownSelectEnhancer() {
  if (_bootstrapStarted) return
  _bootstrapStarted = true

  const scan = (root) => {
    try {
      enhanceSelectsIn(root || document)
    } catch (e) {
      console.warn('[ef-dropdown-select] enhance failed', e)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document), { once: true })
  } else {
    scan(document)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches?.('select')) scan(node.parentNode || node)
        else if (node.querySelector?.('select')) scan(node)
      }
    }
  })

  observer.observe(document.documentElement, { childList: true, subtree: true })
}

/**
 * @typedef {Object} EnhancedSelectInstance
 * @property {HTMLSelectElement} selectEl
 * @property {HTMLElement} root
 * @property {HTMLButtonElement} trigger
 * @property {() => void} refresh
 * @property {() => void} close
 * @property {() => void} destroy
 */
