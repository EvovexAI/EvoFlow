/**
 * Agent trace: extract vendor system prompt segments and show a dedicated modal.
 */
import { toast } from '../components/toast.js'
import { AT, biText } from './agent-trace-i18n.js'

/** @param {unknown} content */
function messageContentToPlainText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const typ = String(block.type || '').toLowerCase()
        const t = block.text
        if (typeof t === 'string' && t.trim()) parts.push(t.trim())
        else if (['text', 'input_text', 'output_text'].includes(typ) && typeof t === 'string') parts.push(String(t).trim())
      } else if (typeof block === 'string' && block.trim()) parts.push(block.trim())
    }
    return parts.join('\n')
  }
  if (typeof content === 'object') {
    const o = /** @type {Record<string, unknown>} */ (content)
    if (Array.isArray(o.parts)) return messageContentToPlainText(o.parts)
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

/** @param {unknown} system */
function anthropicStyleSystemToText(system) {
  if (system == null) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((b) => messageContentToPlainText(b)).filter(Boolean).join('\n\n')
  }
  if (typeof system === 'object') return messageContentToPlainText(system)
  return ''
}

/** @param {string[]} segments */
function dedupeIdenticalSystemSegments(segments) {
  const seen = new Set()
  const out = []
  for (const s of segments) {
    const key = String(s || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** @param {Record<string, unknown>} payload */
export function extractSystemPromptSegmentsFromVendorPayload(payload) {
  if (!payload || typeof payload !== 'object') return []
  const segments = []
  const ins = payload.instructions
  if (typeof ins === 'string' && ins.trim()) segments.push(ins.trim())
  const top = anthropicStyleSystemToText(payload.system).trim()
  if (top) segments.push(top)
  const messages = payload.messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const role = String(/** @type {Record<string, unknown>} */ (msg).role || '').trim().toLowerCase()
      if (role !== 'system' && role !== 'developer') continue
      const piece = messageContentToPlainText(/** @type {Record<string, unknown>} */ (msg).content).trim()
      if (piece) segments.push(piece)
    }
  }
  return dedupeIdenticalSystemSegments(segments)
}

/** @param {Record<string, unknown>} payload */
function extractFirstUserMessageAsInstruction(payload) {
  const messages = payload.messages
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (String(/** @type {Record<string, unknown>} */ (msg).role || '').trim().toLowerCase() !== 'user') continue
    const text = messageContentToPlainText(/** @type {Record<string, unknown>} */ (msg).content).trim()
    if (text) return text
    break
  }
  return ''
}

/**
 * Resolve vendor payload + optional precomputed full text from observability / debug rows.
 * @param {unknown} requestObj parsed request_json
 */
export function resolveSystemPromptFromRequestJson(requestObj) {
  if (requestObj == null) return { segments: [], fullText: '' }
  if (typeof requestObj === 'string') {
    const t = requestObj.trim()
    return t ? { segments: [t], fullText: t } : { segments: [], fullText: '' }
  }
  if (typeof requestObj !== 'object') return { segments: [], fullText: '' }
  const rec = /** @type {Record<string, unknown>} */ (requestObj)
  const pre = rec.system_prompt_full
  if (typeof pre === 'string' && pre.trim()) {
    const t = pre.trim()
    return { segments: [t], fullText: t }
  }
  let payload = null
  if (rec.vendor_request && typeof rec.vendor_request === 'object') {
    payload = /** @type {Record<string, unknown>} */ (rec.vendor_request)
  } else if (rec.payload && typeof rec.payload === 'object') {
    payload = /** @type {Record<string, unknown>} */ (rec.payload)
  } else if (rec.messages != null || rec.instructions != null || rec.system != null) {
    payload = rec
  }
  const segments = payload ? extractSystemPromptSegmentsFromVendorPayload(payload) : []
  if (segments.length) {
    const fullText = formatSystemPromptFullText(segments)
    return { segments, fullText }
  }
  const userFallback = payload ? extractFirstUserMessageAsInstruction(payload) : ''
  if (userFallback) {
    return { segments: [userFallback], fullText: userFallback, fromUserMessage: true }
  }
  return { segments: [], fullText: '' }
}

/** @param {string[]} segments */
export function formatSystemPromptFullText(segments) {
  const list = Array.isArray(segments) ? segments.filter((s) => String(s || '').trim()) : []
  if (!list.length) return ''
  if (list.length === 1) return list[0]
  const n = list.length
  const parts = [list[0]]
  for (let i = 1; i < list.length; i++) {
    parts.push(`${biText(AT.vendorSystemPromptSegZh(i + 1, n), AT.vendorSystemPromptSegEn(i + 1, n))}\n\n${list[i]}`)
  }
  return parts.join('\n\n')
}

let _activeOverlay = null
let _installed = false
let _stashSeq = 1
/** @type {Map<string, { segments: string[]; fullText: string }>} */
const _stash = new Map()

/** @param {{ segments: string[]; fullText: string }} data */
export function stashSystemPromptForModal(data) {
  const id = `ats${_stashSeq++}`
  _stash.set(id, data)
  return id
}

/**
 * @param {string} titleText
 * @param {{ segments?: string[]; fullText?: string }} data
 */
export function openAgentTraceSystemPromptModal(titleText, data) {
  const segments = Array.isArray(data?.segments) ? data.segments.filter((s) => String(s || '').trim()) : []
  const fromUserMessage = !!data?.fromUserMessage
  const fullText =
    (typeof data?.fullText === 'string' && data.fullText.trim()) ||
    formatSystemPromptFullText(segments) ||
    ''
  const charCount = fullText.length

  if (_activeOverlay) {
    _activeOverlay.remove()
    _activeOverlay = null
  }

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay agent-trace-json-modal-overlay agent-trace-sys-prompt-modal-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', titleText || biText(AT.detailKeys.systemPromptFullZh, AT.detailKeys.systemPromptFullEn))

  const title = titleText || biText(AT.detailKeys.systemPromptFullZh, AT.detailKeys.systemPromptFullEn)
  const countLabel = biText(AT.systemPromptCharCountZh(charCount), AT.systemPromptCharCountEn(charCount))
  const sourceHint = fromUserMessage
    ? biText('（来自 user 消息模板，非独立 system 角色）', '(from user message template, not a separate system role)')
    : ''

  overlay.innerHTML = `
    <div class="modal agent-trace-json-modal-panel agent-trace-sys-prompt-modal-panel">
      <div class="agent-trace-sys-prompt-modal-head">
        <div class="agent-trace-sys-prompt-modal-title">${escapeHtml(title)}</div>
        <div class="agent-trace-sys-prompt-modal-meta">${escapeHtml(countLabel)}${sourceHint ? `<span class="agent-trace-sys-prompt-source-hint">${escapeHtml(sourceHint)}</span>` : ''}</div>
      </div>
      <div class="agent-trace-json-modal-body agent-trace-sys-prompt-modal-body" data-at-sys-prompt-body></div>
      <div class="agent-trace-json-modal-foot">
        <span class="agent-trace-json-modal-foot-grow" aria-hidden="true"></span>
        <button type="button" class="btn btn-secondary btn-sm" data-at-sys-prompt-copy>${biText('复制', 'Copy')}</button>
        <button type="button" class="btn btn-primary btn-sm" data-at-sys-prompt-close>${biText('关闭', 'Close')}</button>
      </div>
    </div>
  `

  const bodyEl = overlay.querySelector('[data-at-sys-prompt-body]')
  if (bodyEl) {
    if (!segments.length) {
      const empty = document.createElement('p')
      empty.className = 'form-hint agent-trace-sys-prompt-empty'
      empty.textContent = biText(AT.vendorSystemPromptNoneZh, AT.vendorSystemPromptNoneEn)
      bodyEl.appendChild(empty)
    } else if (segments.length === 1) {
      const pre = document.createElement('pre')
      pre.className = 'agent-trace-json-modal-text'
      pre.spellcheck = false
      pre.textContent = segments[0]
      bodyEl.appendChild(pre)
    } else {
      segments.forEach((seg, idx) => {
        const block = document.createElement('section')
        block.className = 'agent-trace-sys-prompt-seg'
        const lab = document.createElement('div')
        lab.className = 'agent-trace-sys-prompt-seg-label'
        lab.textContent = biText(AT.vendorSystemPromptSegZh(idx + 1, segments.length), AT.vendorSystemPromptSegEn(idx + 1, segments.length))
        const pre = document.createElement('pre')
        pre.className = 'agent-trace-json-modal-text'
        pre.spellcheck = false
        pre.textContent = seg
        block.appendChild(lab)
        block.appendChild(pre)
        bodyEl.appendChild(block)
      })
    }
  }

  document.body.appendChild(overlay)
  _activeOverlay = overlay

  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    if (_activeOverlay === overlay) _activeOverlay = null
  }

  overlay.querySelector('[data-at-sys-prompt-close]')?.addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  overlay.querySelector('[data-at-sys-prompt-copy]')?.addEventListener('click', async () => {
    if (!fullText) {
      toast(biText('无可复制内容', 'Nothing to copy'), 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(fullText)
      toast(biText('已复制到剪贴板', 'Copied to clipboard'), 'success')
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = fullText
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        toast(biText('已复制到剪贴板', 'Copied to clipboard'), 'success')
      } catch {
        toast(biText('复制失败', 'Copy failed'), 'error')
      }
    }
  })

  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  overlay.querySelector('[data-at-sys-prompt-close]')?.focus()
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function installAgentTraceSystemPromptDelegate() {
  if (_installed) return
  _installed = true
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.agent-trace-sys-prompt-open')
    if (!btn) return
    e.preventDefault()
    const title = btn.getAttribute('data-sys-prompt-title') || biText(AT.detailKeys.systemPromptFullZh, AT.detailKeys.systemPromptFullEn)
    const id = btn.getAttribute('data-sys-prompt-ref')
    if (!id || !_stash.has(id)) return
    openAgentTraceSystemPromptModal(title, _stash.get(id))
  })
}
