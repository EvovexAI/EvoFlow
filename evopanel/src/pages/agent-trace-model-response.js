/**
 * Parse model invocation ``response_json`` for the SQLite「模型请求」table.
 */

/** @typedef {{ name: string; argsPreview: string; argsFull: unknown }} ParsedToolCall */
/** @typedef {{
 *   kind: 'empty' | 'error' | 'tools' | 'content' | 'tools_and_content';
 *   kindLabelZh: string;
 *   kindLabelEn: string;
 *   toolNames: string[];
 *   tools: ParsedToolCall[];
 *   contentText: string;
 *   hasTools: boolean;
 *   hasContent: boolean;
 * }} ModelResponseSummary */

/** @param {unknown} msg */
function messageBody(msg) {
  if (!msg || typeof msg !== 'object') return null
  const m = /** @type {Record<string, unknown>} */ (msg)
  const data = m.data
  if (data && typeof data === 'object') return /** @type {Record<string, unknown>} */ (data)
  return m
}

/** @param {unknown} tc */
function toolCallName(tc) {
  if (!tc || typeof tc !== 'object') return ''
  const t = /** @type {Record<string, unknown>} */ (tc)
  const fn = t.function
  if (fn && typeof fn === 'object') {
    const n = /** @type {Record<string, unknown>} */ (fn).name
    if (n != null && String(n).trim()) return String(n).trim()
  }
  if (t.name != null && String(t.name).trim()) return String(t.name).trim()
  return ''
}

/** @param {unknown} raw */
function argsObjectFromToolCall(raw) {
  if (!raw || typeof raw !== 'object') return null
  const t = /** @type {Record<string, unknown>} */ (raw)
  if (t.args != null && typeof t.args === 'object' && !Array.isArray(t.args)) {
    return t.args
  }
  const fn = t.function
  if (fn && typeof fn === 'object') {
    const args = /** @type {Record<string, unknown>} */ (fn).arguments
    if (typeof args === 'string' && args.trim()) {
      try {
        return JSON.parse(args)
      } catch {
        return args
      }
    }
    if (args != null && typeof args === 'object') return args
  }
  if (t.args != null) return t.args
  return null
}

/** @param {unknown} raw @param {number} maxLen */
function previewText(raw, maxLen) {
  if (raw == null) return ''
  let s
  if (typeof raw === 'string') s = raw
  else {
    try {
      s = JSON.stringify(raw)
    } catch {
      s = String(raw)
    }
  }
  const t = s.trim()
  if (!t) return ''
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t
}

/** @param {unknown} content */
function contentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p == null) return ''
        if (typeof p === 'string') return p
        if (typeof p !== 'object') return String(p)
        const pr = /** @type {Record<string, unknown>} */ (p)
        if (pr.type === 'text' && pr.text != null) return String(pr.text)
        if (pr.text != null) return String(pr.text)
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content).trim()
}

/** @param {Record<string, unknown>} body */
function collectFromMessageBody(body, toolNames, tools, contentParts) {
  const c = contentToText(body.content)
  if (c) contentParts.push(c)
  const toolCallLists = [body.tool_calls]
  const ak = body.additional_kwargs
  if (ak && typeof ak === 'object') {
    toolCallLists.push(/** @type {Record<string, unknown>} */ (ak).tool_calls)
  }
  for (const tcs of toolCallLists) {
    if (!Array.isArray(tcs)) continue
    for (const tc of tcs) {
      const name = toolCallName(tc) || '?'
      toolNames.push(name)
      const argsFull = argsObjectFromToolCall(tc)
      tools.push({
        name,
        argsPreview: previewText(argsFull ?? tc, 120),
        argsFull: argsFull ?? tc,
      })
    }
  }
}

/** @param {unknown} response */
export function summarizeModelResponse(response) {
  /** @type {ModelResponseSummary} */
  const empty = {
    kind: 'empty',
    kindLabelZh: '—',
    kindLabelEn: '—',
    toolNames: [],
    tools: [],
    contentText: '',
    hasTools: false,
    hasContent: false,
  }
  if (response == null) return empty
  if (typeof response === 'string') {
    const t = response.trim()
    if (!t) return empty
    return {
      kind: 'content',
      kindLabelZh: '文本',
      kindLabelEn: 'Text',
      toolNames: [],
      tools: [],
      contentText: t,
      hasTools: false,
      hasContent: true,
    }
  }
  if (typeof response !== 'object') return empty

  const root = /** @type {Record<string, unknown>} */ (response)
  if (root.error != null) {
    const err = root.error
    let msg
    if (typeof err === 'object' && err !== null) {
      const er = /** @type {Record<string, unknown>} */ (err)
      msg = er.message != null ? String(er.message) : JSON.stringify(err)
    } else {
      msg = String(err)
    }
    return {
      kind: 'error',
      kindLabelZh: '错误',
      kindLabelEn: 'Error',
      toolNames: [],
      tools: [],
      contentText: msg.trim(),
      hasTools: false,
      hasContent: Boolean(msg.trim()),
    }
  }

  const toolNames = []
  /** @type {ParsedToolCall[]} */
  const tools = []
  const contentParts = []

  const generations = root.generations
  if (Array.isArray(generations)) {
    for (const row of generations) {
      const gens = Array.isArray(row) ? row : [row]
      for (const g of gens) {
        if (!g || typeof g !== 'object') continue
        const gen = /** @type {Record<string, unknown>} */ (g)
        const text = gen.text != null ? String(gen.text).trim() : ''
        if (text) contentParts.push(text)
        const body = messageBody(gen.message)
        if (body) collectFromMessageBody(body, toolNames, tools, contentParts)
      }
    }
  }

  const choices = root.choices
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      if (!ch || typeof ch !== 'object') continue
      const choice = /** @type {Record<string, unknown>} */ (ch)
      const msg = choice.message
      if (msg && typeof msg === 'object') {
        const body = messageBody(msg)
        if (body) collectFromMessageBody(body, toolNames, tools, contentParts)
      }
      const delta = choice.delta
      if (delta && typeof delta === 'object') {
        const body = messageBody(delta)
        if (body) collectFromMessageBody(body, toolNames, tools, contentParts)
      }
    }
  }

  const messages = root.messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const body = messageBody(msg)
      if (body) collectFromMessageBody(body, toolNames, tools, contentParts)
    }
  }

  const contentText = [...new Set(contentParts.filter(Boolean))].join('\n\n').trim()
  const uniqueToolNames = [...new Set(toolNames.filter((n) => n && n !== '?'))]
  const hasTools = tools.length > 0
  const hasContent = Boolean(contentText)

  if (!hasTools && !hasContent) return empty

  if (hasTools && hasContent) {
    return {
      kind: 'tools_and_content',
      kindLabelZh: '工具+文本',
      kindLabelEn: 'Tools+text',
      toolNames: uniqueToolNames,
      tools,
      contentText,
      hasTools: true,
      hasContent: true,
    }
  }
  if (hasTools) {
    return {
      kind: 'tools',
      kindLabelZh: '工具',
      kindLabelEn: 'Tools',
      toolNames: uniqueToolNames,
      tools,
      contentText: '',
      hasTools: true,
      hasContent: false,
    }
  }
  return {
    kind: 'content',
    kindLabelZh: '文本',
    kindLabelEn: 'Text',
    toolNames: [],
    tools: [],
    contentText,
    hasTools: false,
    hasContent: true,
  }
}

/** @param {ModelResponseSummary['kind']} kind */
function kindTagClass(kind) {
  if (kind === 'tools') return 'el-tag--warning'
  if (kind === 'content') return 'el-tag--success'
  if (kind === 'tools_and_content') return 'el-tag--info'
  if (kind === 'error') return 'el-tag--danger'
  return 'el-tag--info'
}

/**
 * @param {ModelResponseSummary} summary
 * @param {{ escHtml: (s: unknown) => string }} ctx
 */
export function renderModelResponseTypeCell(summary, { escHtml }) {
  if (summary.kind === 'empty') return '<span class="el-obs-muted">—</span>'
  const cls = kindTagClass(summary.kind)
  return `<span class="el-tag ${cls}" title="${escHtml(summary.kindLabelEn)}">${escHtml(summary.kindLabelZh)}</span>`
}

/**
 * @param {ModelResponseSummary} summary
 * @param {{ escHtml: (s: unknown) => string; trunc: (s: unknown, n?: number) => string; stashJsonForModal: (obj: unknown) => string; rowLabel: string }} ctx
 */
export function renderModelResponsePreviewCell(summary, { escHtml, trunc, stashJsonForModal, rowLabel }) {
  if (summary.kind === 'empty') return '<span class="el-obs-muted">—</span>'

  const parts = []

  if (summary.hasTools && summary.tools.length) {
    const items = summary.tools
      .map((t) => {
        const nameHtml = `<code class="agent-trace-model-tool-name">${escHtml(t.name)}</code>`
        if (!t.argsPreview) return `<li class="agent-trace-model-tool-item">${nameHtml}</li>`
        const argsId = stashJsonForModal(t.argsFull)
        const title = `工具参数 · ${t.name} · ${rowLabel}`
        return `<li class="agent-trace-model-tool-item">${nameHtml}
          <button type="button" class="agent-trace-json-modal-open agent-trace-model-tool-args-btn" data-json-ref="${escHtml(argsId)}" data-json-title="${escHtml(title)}">${escHtml(trunc(t.argsPreview, 72))}</button>
        </li>`
      })
      .join('')
    parts.push(`<ul class="agent-trace-model-tool-list">${items}</ul>`)
  }

  if (summary.hasContent && summary.contentText) {
    const contentId = stashJsonForModal(summary.contentText)
    const preview = trunc(summary.contentText, 96)
    parts.push(
      `<button type="button" class="agent-trace-json-modal-open agent-trace-model-content-preview" data-json-ref="${escHtml(contentId)}" data-json-title="${escHtml(`模型返回内容 · ${rowLabel}`)}">${escHtml(preview)}</button>`,
    )
  }

  return parts.length
    ? `<div class="agent-trace-model-response-preview">${parts.join('')}</div>`
    : '<span class="el-obs-muted">—</span>'
}
