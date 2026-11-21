/**
 * Debug-oriented page dump for main-panel CDP / platform ui.panel.
 * Captures what a human sees in the selected chat pane (turn texts), not just clickable refs.
 */

/**
 * @param {{ maxTurns?: number, maxCharsPerTurn?: number, includeOffscreen?: boolean }} [opts]
 */
export function collectPanelPageDump(opts = {}) {
  const maxTurns = Math.max(1, Number(opts.maxTurns) || 30)
  const maxCharsPerTurn = Math.max(80, Number(opts.maxCharsPerTurn) || 1200)
  const includeOffscreen = opts.includeOffscreen === true

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    const opacity = style.opacity === '' || style.opacity == null ? 1 : Number(style.opacity)
    if (style.visibility === 'hidden' || style.display === 'none' || !(opacity > 0)) return false
    if (includeOffscreen) return true
    const vh = window.innerHeight || 0
    const vw = window.innerWidth || 0
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw
  }

  function clip(s, n) {
    const t = String(s || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (t.length <= n) return t
    return t.slice(0, n - 1) + '…'
  }

  let selectedSessionKey = ''
  try {
    selectedSessionKey = String(window.__evoflowSelectedSessionKey || '').trim()
  } catch {
    /* ignore */
  }

  let rightActiveKey = null
  let rightCollapsed = null
  try {
    const store = window.__evoflowRightStageStore
    if (store && typeof store.getSnapshot === 'function') {
      const snap = store.getSnapshot()
      rightActiveKey = snap.activeKey
      rightCollapsed = snap.collapsed
    }
  } catch {
    /* ignore */
  }

  let streaming = false
  try {
    const bridge = window.__evoflowPanel && window.__evoflowPanel.getState
      ? null
      : null
    void bridge
  } catch {
    /* ignore */
  }

  // Prefer selected chat host when marked; else document
  let root = document
  try {
    const hosts = [...document.querySelectorAll('.react-chat-host')]
    const selected =
      hosts.find((h) => h.getAttribute('data-selected') === '1') ||
      hosts.find((h) => h.getAttribute('data-focused') === '1') ||
      hosts.find((h) => {
        const sk = h.getAttribute('data-session-key') || h.getAttribute('data-sessionKey') || ''
        return selectedSessionKey && sk === selectedSessionKey
      })
    if (selected) root = selected
  } catch {
    /* ignore */
  }

  const turnEls = [...root.querySelectorAll('[data-turn-id]')]
  const visibleTurns = []
  for (const el of turnEls) {
    if (!includeOffscreen && !isVisible(el)) continue
    const turnId = String(el.getAttribute('data-turn-id') || '').trim()
    const text = clip(el.innerText || el.textContent || '', maxCharsPerTurn)
    if (!text) continue
    const rect = el.getBoundingClientRect()
    visibleTurns.push({
      turnId: turnId || null,
      text,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      inViewport: isVisible(el),
    })
    if (visibleTurns.length >= maxTurns) break
  }

  // Fallback: visible markdown paragraphs in main pane when turn markers missing
  let paragraphs = []
  if (visibleTurns.length === 0) {
    const ps = [...root.querySelectorAll('p, .markdown-body, [class*="markdown"]')]
    for (const el of ps) {
      if (!includeOffscreen && !isVisible(el)) continue
      const text = clip(el.innerText || '', Math.min(400, maxCharsPerTurn))
      if (text.length < 2) continue
      paragraphs.push(text)
      if (paragraphs.length >= maxTurns) break
    }
  }

  let route = ''
  try {
    route = String(window.location.hash || '').replace(/^#/, '') || '/'
  } catch {
    route = ''
  }

  let title = document.title || ''
  try {
    const layout = window.__evoflowChatLayout
    if (layout && layout.activeTitle) title = String(layout.activeTitle)
  } catch {
    /* ignore */
  }

  // Streaming: prefer bridge via getState if mounted on same object later
  try {
    if (typeof window.__evoflowPanel?.getState === 'function') {
      const st = window.__evoflowPanel.getState()
      if (st && st.ok && st.result && typeof st.result.streaming === 'boolean') {
        streaming = st.result.streaming
      }
    }
  } catch {
    /* ignore */
  }

  const transcriptLines = []
  for (const t of visibleTurns) {
    transcriptLines.push(`--- turn ${t.turnId || '?'} (top=${t.top}) ---`)
    transcriptLines.push(t.text)
  }
  if (!transcriptLines.length && paragraphs.length) {
    transcriptLines.push('--- paragraphs (no data-turn-id) ---')
    for (const p of paragraphs) transcriptLines.push(p)
  }

  return {
    kind: 'page_dump',
    at: new Date().toISOString(),
    url: String(window.location.href || ''),
    route,
    title,
    selectedSessionKey: selectedSessionKey || null,
    streaming,
    rightActiveKey,
    rightCollapsed,
    turnCount: visibleTurns.length,
    turnsTruncated: turnEls.length > visibleTurns.length,
    turns: visibleTurns,
    paragraphs,
    transcript: transcriptLines.join('\n'),
  }
}
