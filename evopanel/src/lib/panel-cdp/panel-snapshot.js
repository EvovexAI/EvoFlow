/**
 * Main-panel interactive snapshot (aligned with browser_engine._SNAPSHOT_JS).
 * Pure DOM helpers; refs are owned by panel-api.
 */

/**
 * @param {{ maxElements?: number, maxDom?: number, includeHidden?: boolean }} [opts]
 * @returns {{ url: string, title: string, elements: object[], truncated: boolean, dom: object[], domTruncated: boolean, _nodes: Element[] }}
 */
export function collectPanelSnapshot(opts = {}) {
  opts = opts && typeof opts === 'object' ? opts : {}
  const MAX_ELEMENTS = opts.maxElements ?? 150
  const MAX_DOM = opts.maxDom ?? 400
  const includeHidden = opts.includeHidden ?? false

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    // happy-dom (and some hosts) may leave opacity as ""; treat blank as fully opaque
    const opacity = style.opacity === '' || style.opacity == null ? 1 : Number(style.opacity)
    return style.visibility !== 'hidden' && style.display !== 'none' && opacity > 0
  }

  function viewportRect() {
    return { left: 0, top: 0, right: window.innerWidth || 0, bottom: window.innerHeight || 0 }
  }
  const vp = viewportRect()
  function inViewport(rect) {
    return (
      rect.x < vp.right &&
      rect.y < vp.bottom &&
      rect.x + rect.width > vp.left &&
      rect.y + rect.height > vp.top
    )
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const t = el.tagName
    if (t === 'A') return 'link'
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button'
    if (t === 'SELECT') return 'combobox'
    if (t === 'TEXTAREA') return 'textbox'
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase()
      if (ty === 'checkbox') return 'checkbox'
      if (ty === 'radio') return 'radio'
      if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return t.toLowerCase()
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label') || ''
    if (aria.trim()) return aria.trim().slice(0, 120)
    const labelledBy = el.getAttribute('aria-labelledby') || ''
    if (labelledBy.trim()) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id)
          return n ? (n.innerText || n.textContent || '').trim() : ''
        })
        .filter(Boolean)
      if (parts.length) return parts.join(' ').slice(0, 120)
    }
    const title = el.getAttribute('title') || ''
    if (title.trim()) return title.trim().slice(0, 120)
    const placeholder = el.getAttribute('placeholder') || ''
    if (placeholder.trim()) return placeholder.trim().slice(0, 120)
    let text = ''
    try {
      text = (el.innerText || el.textContent || '').trim()
    } catch {
      /* ignore */
    }
    if (text) return text.slice(0, 120)
    try {
      const img = el.querySelector ? el.querySelector('img[alt]') : null
      if (img) {
        const alt = String(img.getAttribute('alt') || '').trim()
        if (alt) return alt.slice(0, 120)
      }
    } catch {
      /* ignore */
    }
    const tag = (el.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'button') {
      const v = String(el.value || '').trim()
      if (v) return v.slice(0, 120)
    }
    if (tag === 'a') {
      const href = String(el.getAttribute('href') || '').trim()
      if (href && href !== '#' && !href.startsWith('javascript:')) {
        const tail =
          href.split('#')[0].split('?')[0].split('/').filter(Boolean).pop() || href
        return ('→' + tail).slice(0, 120)
      }
    }
    return ''
  }

  function isInteractive(el) {
    const t = el.tagName
    if (
      t === 'A' ||
      t === 'BUTTON' ||
      t === 'INPUT' ||
      t === 'SELECT' ||
      t === 'TEXTAREA' ||
      t === 'SUMMARY'
    ) {
      return true
    }
    if (el.hasAttribute('contenteditable') || el.isContentEditable) return true
    const role = el.getAttribute('role')
    if (
      role === 'button' ||
      role === 'link' ||
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'tab' ||
      role === 'switch' ||
      role === 'menuitem' ||
      role === 'option' ||
      role === 'slider'
    ) {
      return true
    }
    return typeof el.onclick === 'function'
  }

  function cssSelector(el) {
    if (el.id) {
      try {
        return '#' + CSS.escape(el.id)
      } catch {
        return '#' + el.id
      }
    }
    const path = []
    let cur = el
    while (cur && cur !== document.body) {
      const parent = cur.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName)
        const idx = siblings.indexOf(cur) + 1
        path.unshift(cur.tagName.toLowerCase() + (idx > 1 ? `:nth-of-type(${idx})` : ''))
      }
      cur = parent
    }
    return 'body > ' + path.join(' > ')
  }

  function xpathOf(el) {
    const parts = []
    let cur = el
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let idx = 1
      let sib = cur.previousElementSibling
      while (sib) {
        if (sib.tagName === cur.tagName) idx++
        sib = sib.previousElementSibling
      }
      parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']')
      cur = cur.parentElement
    }
    return '//body/' + parts.join('/')
  }

  function elementToDict(el, index) {
    const tag = el.tagName.toLowerCase()
    const role = roleOf(el)
    const name = accessibleName(el)
    let text = ''
    try {
      text = (el.innerText || '').trim().slice(0, 200)
    } catch {
      /* ignore */
    }
    let value = ''
    try {
      value = typeof el.value === 'string' ? el.value.slice(0, 200) : ''
    } catch {
      /* ignore */
    }
    const checked = role === 'checkbox' || role === 'radio' ? Boolean(el.checked) : null
    const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
    const rect = el.getBoundingClientRect()
    const attrs = {}
    let attrCount = 0
    for (const a of el.attributes || []) {
      if (attrCount >= 8) break
      if (a.value.length > 120) continue
      attrs[a.name] = a.value
      attrCount += 1
    }
    return {
      ref: 'e' + (index + 1),
      tag,
      role,
      name,
      text,
      value,
      checked,
      disabled,
      selector: cssSelector(el),
      xpath: xpathOf(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport: inViewport(rect),
      attributes: attrs,
    }
  }

  function interactiveNodes() {
    const out = []
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => {
        if (!isInteractive(el)) return NodeFilter.FILTER_SKIP
        if (!includeHidden && !isVisible(el)) return NodeFilter.FILTER_SKIP
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let n
    while ((n = walker.nextNode())) {
      out.push(n)
      if (out.length >= MAX_ELEMENTS) break
    }
    return out
  }

  function ownText(el) {
    let t = ''
    for (const c of el.childNodes || []) {
      if (c.nodeType === 3) t += c.nodeValue || ''
    }
    return t.trim().replace(/\s+/g, ' ')
  }

  function bodyTextChunks() {
    let raw = ''
    try {
      raw = (document.body && document.body.innerText) || ''
    } catch {
      /* ignore */
    }
    return raw
      .replace(/\r/g, '')
      .split(/\n+/)
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter((s) => s.length >= 2 && s.length <= 300)
  }

  function domOutline() {
    const semantic = new Set([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'P',
      'LI',
      'BLOCKQUOTE',
      'PRE',
      'TH',
      'TD',
      'DT',
      'DD',
      'FIGCAPTION',
      'LABEL',
      'LEGEND',
      'SUMMARY',
      'CAPTION',
    ])
    const containers = new Set([
      'DIV',
      'SPAN',
      'SECTION',
      'ARTICLE',
      'MAIN',
      'ASIDE',
      'HEADER',
      'FOOTER',
      'NAV',
      'STRONG',
      'EM',
      'B',
      'I',
      'SMALL',
      'MARK',
      'TIME',
    ])
    const out = []
    const seen = new Set()
    for (const chunk of bodyTextChunks()) {
      if (out.length >= Math.min(80, MAX_DOM)) break
      const key = chunk.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ tag: 'text', depth: 0, inViewport: true, text: chunk.slice(0, 200) })
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, null)
    let node
    while ((node = walker.nextNode()) && out.length < MAX_DOM) {
      const tag = node.tagName
      if (!semantic.has(tag) && !containers.has(tag)) continue
      if (!includeHidden && !isVisible(node)) continue
      let depth = 0
      let anc = node.parentElement
      while (anc) {
        depth++
        anc = anc.parentElement
      }
      let text = ''
      if (semantic.has(tag)) {
        text = (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200)
      } else {
        text = ownText(node)
        const childEls = node.children ? node.children.length : 0
        if ((!text || text.length < 2) && childEls <= 2) {
          text = (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200)
        }
        if (childEls > 6) continue
        if (text.length > 180) continue
      }
      if (!text || text.length < 2) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const rect = node.getBoundingClientRect()
      out.push({
        tag: tag.toLowerCase(),
        depth: Math.max(0, depth - 2),
        inViewport: inViewport(rect),
        text,
      })
    }
    return out
  }

  const nodes = interactiveNodes()
  const elements = nodes.map(elementToDict)
  const truncated = elements.length >= MAX_ELEMENTS
  const outline = domOutline()
  return {
    url: window.location.href,
    title: document.title || '',
    elements,
    truncated,
    dom: outline,
    domTruncated: outline.length >= MAX_DOM,
    _nodes: nodes,
  }
}
