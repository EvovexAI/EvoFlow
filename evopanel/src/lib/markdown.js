/**
 * Markdown 渲染器 - 轻量级，支持代码高亮
 * 从 evoflow 移植，去掉 MEDIA 路径处理
 */

import { linkifyWorkspaceAtMentions } from './workspace-file-mention-display.js'
import { isImagePathLike, normalizeLocalImagePath, resolveChatImageSrc } from './chat-image-src.js'

const KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','new','this','class','extends','import',
  'export','from','default','try','catch','finally','throw','async','await',
  'yield','of','in','typeof','instanceof','void','delete','true','false',
  'null','undefined','static','get','set','super','with','debugger',
  'def','print','self','elif','lambda','pass','raise','except','None','True','False',
  'fn','pub','mut','impl','struct','enum','match','use','mod','crate','trait',
  'int','string','bool','float','double','char','byte','long','short','unsigned',
  'package','main','fmt','go','chan','defer','select','type','interface','map','range',
])

export function highlightCode(code, lang) {
  const escaped = escapeHtml(code)
  // Two-phase: mark with control chars first, convert to HTML last
  // Prevents keyword regex from matching "class" inside <span class="..."> attributes
  const S = '\u0002', E = '\u0003'
  const CLS = ['hl-number','hl-comment','hl-string','hl-type','hl-func','hl-keyword']
  return escaped
    .replace(/\b(\d+\.?\d*)\b/g, `${S}0${E}$1${S}c${E}`)
    .replace(/(\/\/.*$|#.*$)/gm, `${S}1${E}$1${S}c${E}`)
    .replace(/(\/\*[\s\S]*?\*\/)/g, `${S}1${E}$1${S}c${E}`)
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|'[^'\n]*'|`[^`]*`)/g,
      `${S}2${E}$1${S}c${E}`)
    .replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, (m, w) =>
      KEYWORDS.has(w) ? m : `${S}3${E}${w}${S}c${E}`)
    .replace(/\b(\w+)(?=\s*\()/g, (m, w) =>
      KEYWORDS.has(w) ? m : `${S}4${E}${w}${S}c${E}`)
    .replace(/\b(\w+)\b/g, (m, w) =>
      KEYWORDS.has(w) ? `${S}5${E}${w}${S}c${E}` : m)
    .replace(new RegExp(String.fromCharCode(2) + '([0-5])' + String.fromCharCode(3), 'g'), (_, i) => `<span class="${CLS[+i]}">`)
    .replace(new RegExp(String.fromCharCode(2) + 'c' + String.fromCharCode(3), 'g'), '</span>')
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const MD_CODE_COPY_BTN = `<button type="button" class="code-copy-btn" aria-label="复制" title="复制" onclick="window.__copyCode(this)">` +
  `<svg class="code-copy-icon code-copy-icon--copy" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>` +
  `</svg>` +
  `<svg class="code-copy-icon code-copy-icon--done" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M20 6 9 17l-5-5"/>` +
  `</svg></button>`

// 预加载 Tauri convertFileSrc
let _convertFileSrc = null
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  import('@tauri-apps/api/core').then(m => { _convertFileSrc = m.convertFileSrc }).catch(() => {})
}

/** 将本地绝对路径 / outputs / 远程 URL 转为聊天区可加载的 src（Gateway serve-file 或 /mnt 回退） */
function resolveImageSrc(src) {
  const u = String(src || '').trim()
  if (!u) return u
  if (/^(https?|data|blob):/.test(u)) return u
  const mapped = resolveChatImageSrc(u)
  if (mapped && mapped !== u) return mapped
  const isWinPath = /^[A-Za-z]:[\\/]/.test(u)
  const isUnixPath = /^\/[^/]/.test(u) && !u.startsWith('/mnt/user-data')
  if ((isWinPath || isUnixPath) && _convertFileSrc) {
    try {
      return _convertFileSrc(u)
    } catch {
      /* ignore */
    }
  }
  return mapped || u
}

function markdownImageTag(alt, src) {
  const normalizedSrc = normalizeLocalImagePath(src.trim())
  const safeSrc = resolveImageSrc(normalizedSrc)
  const escapedSrc = escapeHtml(normalizedSrc).replace(/\\/g, '&#x5c;')
  const safeAlt = escapeHtml(alt)
  return `<img src="${safeSrc}" alt="${safeAlt}" class="msg-img" data-evf-lightbox="1" loading="lazy" decoding="async" onerror="this.onerror=null;this.style.display='none';this.insertAdjacentHTML('afterend','<span style=\\'color:var(--text-tertiary);font-size:12px\\'>[图片无法加载: ${escapedSrc}]</span>')" />`
}

/** Fix Windows paths in markdown images before ``\`` is lost by downstream parsing. */
function protectMarkdownImagePaths(text) {
  return String(text || '').replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (full, alt, src) => {
    const n = normalizeLocalImagePath(src)
    return n !== src ? `![${alt}](${n})` : full
  })
}

const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

/** 中文语境下把 ASCII 直引号换成弯引号（跳过代码块/行内代码） */
export function normalizeCjkTypographyForMarkdown(text) {
  const raw = String(text || '')
  if (!CJK_CHAR_RE.test(raw)) return raw
  const re = /(```[\s\S]*?```|`[^`\n]+`)/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    out += normalizeCjkQuotesInProse(raw.slice(last, m.index))
    out += m[0]
    last = m.index + m[0].length
  }
  out += normalizeCjkQuotesInProse(raw.slice(last))
  return out
}

function normalizeCjkQuotesInProse(prose) {
  if (!CJK_CHAR_RE.test(prose)) return prose
  let open = true
  return prose.replace(/"/g, () => {
    const q = open ? '\u201c' : '\u201d'
    open = !open
    return q
  })
}

/**
 * Markdown 渲染结果 LRU 缓存。
 * 长会话虚拟列表滚动会反复卸载/重挂行组件，每次重挂若无缓存都会在主线程
 * 重新走「解析+代码高亮+DOM 全建」全流程；缓存后直接命中 HTML 字符串。
 * - 上限 64 条（约覆盖一屏 overscan 滚动往返的重复渲染）
 * - 超大文本（>256KB）不缓存，避免内存放大（key 与 value 双份字符串）
 */
const MD_RENDER_CACHE_MAX_ENTRIES = 64
const MD_RENDER_CACHE_MAX_TEXT_CHARS = 262_144
/** 缓存总字符预算（key+value 合计），防长会话大消息把内存吃爆 */
const MD_RENDER_CACHE_MAX_TOTAL_CHARS = 8_000_000
const mdRenderCache = new Map()
let mdRenderCacheTotalChars = 0

function mdCacheGet(text) {
  const key = String(text)
  if (mdRenderCache.has(key)) {
    const html = mdRenderCache.get(key)
    mdRenderCache.delete(key)
    mdRenderCache.set(key, html) // LRU touch：移到最新
    return html
  }
  return undefined
}

function mdCacheSet(text, html) {
  const key = String(text)
  if (key.length > MD_RENDER_CACHE_MAX_TEXT_CHARS) return
  if (mdRenderCache.has(key)) {
    const prev = mdRenderCache.get(key)
    mdRenderCache.delete(key)
    mdRenderCacheTotalChars -= key.length + String(prev).length
  }
  mdRenderCache.set(key, html)
  mdRenderCacheTotalChars += key.length + String(html).length
  // 超条数或超预算：从最旧逐条淘汰（保底留最新 1 条，单条已受 256KB key 上限约束）
  while (
    (mdRenderCacheTotalChars > MD_RENDER_CACHE_MAX_TOTAL_CHARS ||
      mdRenderCache.size > MD_RENDER_CACHE_MAX_ENTRIES) &&
    mdRenderCache.size > 1
  ) {
    const oldest = mdRenderCache.keys().next().value
    if (oldest === undefined) break
    const prev = mdRenderCache.get(oldest)
    mdRenderCache.delete(oldest)
    mdRenderCacheTotalChars -= oldest.length + String(prev).length
  }
}

/** 供外部（如 worker 渲染回调）查询主线程缓存 */
export function lookupMarkdownRenderCache(text) {
  return mdCacheGet(String(text || ''))
}

/** 供外部（如 worker 渲染回调）写入主线程缓存 */
export function cacheMarkdownRenderResult(text, html) {
  mdCacheSet(String(text || ''), String(html || ''))
}

/** 测试用：清空渲染缓存 */
export function clearMarkdownRenderCache() {
  mdRenderCache.clear()
  mdRenderCacheTotalChars = 0
}

export function renderMarkdown(text) {
  if (!text) return ''
  const cached = mdCacheGet(text)
  if (cached !== undefined) return cached
  let html = linkifyWorkspaceAtMentions(
    relaxMarkdownLineBreaks(normalizeCjkTypographyForMarkdown(text)),
  )
  html = protectMarkdownImagePaths(html)
  const mermaidBlocks = []

  // 代码块
  // Support both \n and Windows \r\n newlines.
  html = html.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const l = String(lang || '').trim().toLowerCase()
    // Mermaid: render as diagram container; actual SVG is produced in React after mount.
    if (l === 'mermaid') {
      const normalized = String(code || '').replace(/\r\n/g, '\n').trimEnd()
      const token = `__EVF_MERMAID_${mermaidBlocks.length}__`
      mermaidBlocks.push(`<div class="mermaid">${escapeHtml(normalized)}</div>`)
      return token
    }
    const highlighted = highlightCode(code.trimEnd(), lang)
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : ''
    return `<pre class="md-code-block"${langAttr}>${MD_CODE_COPY_BTN}<code>${highlighted}</code></pre>`
  })

  // Protect evoflow-file links before inline-code pass (belt-and-suspenders if
  // a stray backtick still wraps a linkify result).
  const fileLinkGuard = protectWorkspaceFileLinks(html)
  html = fileLinkGuard.protectedText

  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`)

  // Placeholders trapped as sole <code> content → free them (still placeholders)
  if (fileLinkGuard.slots.length) {
    html = html.replace(
      new RegExp(
        `<code>${EVF_FILE_LINK_PH_START}evffile(\\d+)${EVF_FILE_LINK_PH_END}<\\/code>`,
        'g',
      ),
      (_, idx) => `${EVF_FILE_LINK_PH_START}evffile${idx}${EVF_FILE_LINK_PH_END}`,
    )
  }

  const lines = html.split('\n')
  const result = []
  let inList = false
  let listType = ''

  function isTableRow(line) {
    return /^\s*\|.+\|\s*$/.test(line)
  }

  function isTableSeparator(line) {
    // 形如 | --- | --- | 或 :---: 等
    if (!isTableRow(line)) return false
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
  }

  function parseTable(startIndex) {
    const headerLine = lines[startIndex]
    const sepLine = lines[startIndex + 1]
    if (!isTableRow(headerLine) || !isTableSeparator(sepLine)) return null

    const headerCells = headerLine.split('|').slice(1, -1).map((c) => c.trim())
    const rows = []
    let i = startIndex + 2
    while (i < lines.length && isTableRow(lines[i])) {
      const rowCells = lines[i].split('|').slice(1, -1).map((c) => c.trim())
      rows.push(rowCells)
      i++
    }
    if (!rows.length) return null

    let tableHtml = '<table><thead><tr>'
    for (const cell of headerCells) {
      tableHtml += `<th>${inlineFormat(cell)}</th>`
    }
    tableHtml += '</tr></thead><tbody>'
    for (const row of rows) {
      tableHtml += '<tr>'
      for (let j = 0; j < headerCells.length; j++) {
        const cell = row[j] != null ? row[j] : ''
        tableHtml += `<td>${inlineFormat(cell)}</td>`
      }
      tableHtml += '</tr>'
    }
    tableHtml += '</tbody></table>'
    return { html: tableHtml, nextIndex: i }
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const trimmed = String(line || '').trim()
    const tokenMatch = String(line || '').trim().match(/^__EVF_MERMAID_(\d+)__$/)
    if (tokenMatch) {
      if (inList) { result.push(`</${listType}>`); inList = false }
      const idx = Number(tokenMatch[1])
      if (Number.isFinite(idx) && mermaidBlocks[idx]) {
        result.push(mermaidBlocks[idx])
      }
      continue
    }
    // Fallback: some model outputs Mermaid lines without fenced code block.
    // Detect a Mermaid flowchart block and render it as diagram.
    // Also support "inline hit" (e.g. "... Flowchart flowchart TD ...") after history reflow.
    const flowMatch = trimmed.match(/\bflowchart\s+(TD|LR|RL|BT)\b/i)
    if (flowMatch) {
      if (inList) { result.push(`</${listType}>`); inList = false }
      const flowStart = flowMatch.index ?? 0
      const firstLine = trimmed.slice(flowStart).trim()
      const block = [firstLine]
      let j = i + 1
      while (j < lines.length) {
        const t = String(lines[j] || '').trim()
        if (!t) break
        // Stop when a new markdown section starts.
        if (/^#{1,6}\s+/.test(t)) break
        // Keep likely Mermaid syntax lines.
        if (/^(%%|subgraph\b|end\b|classDef\b|class\b|click\b|style\b|linkStyle\b|[A-Za-z0-9_]+\s*(-->|---|==>|-.->|:::|\{|\[|\(|\|)|[A-Za-z0-9_]+\s*:)/.test(t)) {
          block.push(t)
          j++
          continue
        }
        // If line looks unrelated prose, stop capture.
        if (/[。！？]/.test(t) && !/-->|==>|\[|\{/.test(t)) break
        block.push(t)
        j++
      }
      result.push(`<div class="mermaid">${escapeHtml(block.join('\n'))}</div>`)
      i = j - 1
      continue
    }

    // 跳过 pre 块内容
    if (line.startsWith('<pre')) {
      result.push(line)
      while (i < lines.length - 1 && !lines[i].includes('</pre>')) { i++; result.push(lines[i]) }
      continue
    }

    // 标题（Markdown 支持 h1–h6）
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      if (inList) { result.push(`</${listType}>`); inList = false }
      const level = headingMatch[1].length
      result.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`)
      continue
    }

    // 无序列表
    const ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/)
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) result.push(`</${listType}>`)
        result.push('<ul>'); inList = true; listType = 'ul'
      }
      result.push(`<li>${inlineFormat(ulMatch[1])}</li>`)
      continue
    }

    // 有序列表
    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/)
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) result.push(`</${listType}>`)
        result.push('<ol>'); inList = true; listType = 'ol'
      }
      result.push(`<li>${inlineFormat(olMatch[1])}</li>`)
      continue
    }

    if (inList) { result.push(`</${listType}>`); inList = false }

    // 引用（blockquote）：> text / >> nested
    const bqMatch = line.match(/^(>{1,3})\s?(.*)$/)
    if (bqMatch) {
      const quoteLines = []
      let j = i
      while (j < lines.length) {
        const bqLine = lines[j].match(/^(\s*)(>{1,3})\s?(.*)$/)
        if (!bqLine) break
        quoteLines.push(bqLine[3])
        j++
      }
      if (quoteLines.length) {
        result.push(`<blockquote>${quoteLines.map(l => inlineFormat(l)).join('<br>')}</blockquote>`)
        i = j - 1
        continue
      }
    }

    // 分割线（hr）：--- / *** / ___（可带空格）
    // 注意：这里只处理“单独一行”的分割线，避免误伤普通文本。
    const hrMatch = line.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/)
    if (hrMatch) {
      result.push('<hr />')
      continue
    }

    // Markdown 表格（GFM 风格）：| a | b | + 分隔线 + 多行数据
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const parsed = parseTable(i)
      if (parsed) {
        result.push(parsed.html)
        i = parsed.nextIndex - 1
        continue
      }
    }
    if (line.trim() === '') { result.push(''); continue }
    if (!line.startsWith('<')) { result.push(`<p>${inlineFormat(line)}</p>`) }
    else { result.push(line) }
  }

  if (inList) result.push(`</${listType}>`)
  let out = result.join('\n')
  if (fileLinkGuard.slots.length) {
    out = restoreWorkspaceFileLinks(out, fileLinkGuard.slots)
  }
  mdCacheSet(text, out)
  return out
}

/** 占位符分隔符（勿用 __…__，会被 Markdown 粗体规则吃掉） */
const EVF_FILE_LINK_PH_START = '\x02'
const EVF_FILE_LINK_PH_END = '\x03'

/** 保护 @@…@@ 转成的 evoflow-file 链接，避免 * / __ 规则污染 URL */
function protectWorkspaceFileLinks(text) {
  const slots = []
  const protectedText = String(text || '').replace(
    /\[([^\]]*)\]\((evoflow-file:[^)]+)\)/gi,
    (_, label, url) => {
      const i = slots.length
      slots.push({ label, url })
      return `${EVF_FILE_LINK_PH_START}evffile${i}${EVF_FILE_LINK_PH_END}`
    },
  )
  return { protectedText, slots }
}

function restoreWorkspaceFileLinks(text, slots) {
  if (!slots.length) return text
  const re = new RegExp(`${EVF_FILE_LINK_PH_START}evffile(\\d+)${EVF_FILE_LINK_PH_END}`, 'g')
  return String(text || '').replace(re, (_, idx) => {
    const slot = slots[Number(idx)]
    if (!slot) return _
    const label = slot.label
    const u = String(slot.url || '').trim()
    let rawPath
    try {
      rawPath = decodeURIComponent(u.slice('evoflow-file:'.length))
    } catch {
      rawPath = u.slice('evoflow-file:'.length)
    }
    const safePath = escapeHtml(rawPath)
    return `<button type="button" class="msg-workspace-file-mention" data-evf-file-path="${safePath}" title="${safePath}">${label}</button>`
  })
}

function inlineFormat(text) {
  const { protectedText, slots } = protectWorkspaceFileLinks(text)
  let out = protectedText
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])_(.+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => markdownImageTag(alt, src))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const u = String(url || '').trim()
      if (isImagePathLike(u) || u.startsWith('/mnt/user-data/outputs/')) {
        return markdownImageTag(label, u)
      }
      const safe = /^https?:|^mailto:/i.test(u) ? u : '#'
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
  out = restoreWorkspaceFileLinks(out, slots)
  return out
}

const STREAM_PENDING_MARK = '\x1eEVF_STREAM_PENDING\x1f'

/**
 * 模型流式常把标题、表格行、正文粘在一行（无换行），GFM 无法识别。
 * 在 stabilize / render 前插入必要换行，并在 ATX 标题 # 后补空格。
 * 注意：只做结构性修复（# 后补空格、标题前换行、表格行拆分），
 * 不基于内容猜测插入换行——那会导致正常文本被误拆。
 */
export function relaxMarkdownLineBreaks(text) {
  let s = String(text || '').replace(/\r\n/g, '\n')
  if (!s.trim()) return s

  // 保护代码块和行内代码，避免其中的 # 等字符被标题/表格正则误伤
  const codeSlots = []
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    const i = codeSlots.length
    codeSlots.push(m)
    return `__EVF_CODE_SLOT_${i}__`
  })
  // 双反引号代码跨度（可包含单反引号，如 `` `#` ``），必须在单反引号之前处理
  s = s.replace(/``([\s\S]*?)``/g, (m) => {
    const i = codeSlots.length
    codeSlots.push(m)
    return `__EVF_CODE_SLOT_${i}__`
  })
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = codeSlots.length
    codeSlots.push('`' + code + '`')
    return `__EVF_CODE_SLOT_${i}__`
  })

  s = s.replace(/---+(?=\s*#{1,6})/g, '---\n\n')
  // 中文冒号 `：` / 全角分号 `；` / 全角逗号 `，` 后直接接 ATX 标题也要拆，
  // 否则 `…展开：## 概述这是正文。` 会让第二个标题不被识别。
  s = s.replace(/([。！？；.!?：，])(\s*)(?=#{1,6}(?![0-9]))/g, '$1\n\n')
  s = s.replace(/([^\n#|])(\s*)(#{1,6})(?=[^\s#\n|0-9])/g, '$1\n\n$3')

  // ##一、 / ###A. → ## 一、
  s = s.replace(/(#{1,6})([一二三四五六七八九十百千]+、)/g, '$1 $2')
  s = s.replace(/(#{1,6})([A-Za-z][A-Za-z0-9]*\.)/g, '$1 $2')

  // 表格行粘连：|a|b||c|d| → 行间换行（保留首尾 |）
  // 只对以 | 开头的行（表格行）应用，避免普通文本中的 || 被误拆为换行
  s = s
    .split('\n')
    .map((line) =>
      /^\s*\|/.test(line) ? line.replace(/\|(\|[^|\n])/g, '|\n$1') : line,
    )
    .join('\n')

  s = s
    .split('\n')
    .map((line) => {
      const hm = line.match(/^(#{1,6})\s*(.+)$/)
      if (hm) {
        const hashes = hm[1]
        const rest = hm[2].trim()
        if (!/^(#{1,6})\s/.test(line)) return `${hashes} ${rest}`
      }
      return line
    })
    .join('\n')

  // 恢复代码块和行内代码
  s = s.replace(/__EVF_CODE_SLOT_(\d+)__/g, (_, i) => codeSlots[Number(i)] || '')

  return s
}

function isTableRowLine(line) {
  return /^\s*\|.+\|\s*$/.test(String(line || ''))
}

/**
 * 流式表格分片末尾常见形态：尾行 `|-----|-----` 缺右侧 `|`，或表头 `| 列A | 列B`
 * 缺尾 `|`。`isTableRowLine` 要求首尾都有 `|`，会把这类未闭合行漏掉，结果整段表格
 * 不进 stabilize 的 PENDING 分支，被 GFM 解析为普通段落 → 用户看到 `|----|----`
 * 等原始字符。
 *
 * 这里识别「以 `|` 起头但尾部 `|` 未闭合」的行；只有当后面再到新一行（已经知道收到
 * 完整结构）时才会被 `normalizeStreamingTableLines` 补齐——所以 stabilize 用它来
 * 判断「是否仍在表格块尾部」，进而挂 PENDING。
 */
function isTableRowLineLoose(line) {
  const s = String(line || '').trim()
  if (!s) return false
  if (/^\|.+\|\s*$/.test(s)) return true
  // 表头 / 分隔行 / 数据行尾部 `|` 尚未送达
  // 要求至少 2 个 `|`：避免 shell 管道命令（如 `| grep foo`）或含单个 `|` 的普通文本被误判为表格行
  return /^\|.+\|/.test(s)
}

function isTableSeparatorLine(line) {
  if (!isTableRowLine(line)) return false
  const cells = String(line || '')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

/** 流式分片常把 GFM 分隔行拆成 `|`、`||` 或 `|------` 等未闭合片段 */
function isIncompleteTableSeparatorLine(line) {
  const s = String(line || '').trim()
  if (!s || isTableSeparatorLine(s)) return false
  if (/^\|+$/.test(s)) return true
  if (/^\|/.test(s) && /[-]/.test(s)) return true
  return false
}

function tableRowCells(line) {
  return String(line || '')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
}

/** 流式分片常把 |------ 与 |---------| 拆成两行，或把表头与分隔行粘在同一行 */
function normalizeStreamingTableLines(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    let ln = String(lines[i] || '')
    const trimmed = ln.trim()
    if (!trimmed) {
      out.push('')
      continue
    }

    const glued = trimmed.match(/^(\|.+\|)\s*(\|[\s:\-|]+\|)\s*$/)
    if (glued && isTableSeparatorLine(glued[2])) {
      out.push(glued[1].trim(), glued[2].trim())
      continue
    }

    if (/^\|[\s:\-|]+\s*$/.test(trimmed) && !/\|\s*$/.test(trimmed)) {
      const next = String(lines[i + 1] || '').trim()
      if (next.startsWith('|')) {
        out.push((trimmed + next.replace(/^\|/, '')).replace(/\|\s*\|/g, '|'))
        i++
        continue
      }
    }

    out.push(ln)
  }
  return out
}

function renderStreamingTableHtml(lines) {
  const rows = normalizeStreamingTableLines(lines.filter((l) => String(l || '').trim()))
  if (!rows.length || !isTableRowLine(rows[0])) return ''

  let html = '<table class="msg-streaming-table-partial"><thead><tr>'
  for (const cell of tableRowCells(rows[0])) {
    html += `<th>${inlineFormat(cell)}</th>`
  }
  html += '</tr></thead>'

  let bodyStart = 1
  if (rows.length > 1 && (isTableSeparatorLine(rows[1]) || isIncompleteTableSeparatorLine(rows[1]))) {
    bodyStart = 2
  }

  if (bodyStart < rows.length) {
    html += '<tbody>'
    for (let i = bodyStart; i < rows.length; i++) {
      if (!isTableRowLine(rows[i]) || isTableSeparatorLine(rows[i]) || isIncompleteTableSeparatorLine(rows[i])) {
        continue
      }
      html += '<tr>'
      for (const cell of tableRowCells(rows[i])) {
        html += `<td>${inlineFormat(cell)}</td>`
      }
      html += '</tr>'
    }
    html += '</tbody>'
  }
  html += '</table>'
  return html
}

/**
 * 流式未闭合块延后渲染：闭合代码围栏；末尾不完整 GFM 表格拆到 pending。
 * @param {string} text
 * @returns {string} 可安全 renderMarkdown 的正文 + 可选 pending 标记
 */
export function stabilizeMarkdownForStreaming(text) {
  let s = relaxMarkdownLineBreaks(text)
  if (!s) return ''

  const fenceCount = (s.match(/```/g) || []).length
  if (fenceCount % 2 === 1) s += '\n```\n'

  let lines = normalizeStreamingTableLines(s.split('\n'))
  let end = lines.length
  while (end > 0 && !String(lines[end - 1] || '').trim()) end--
  lines = lines.slice(0, end)

  let tableStart = end
  // 用 loose 版本回退：兼容未闭合的表头 `| A | B` 或分隔行 `|-----|-----`。
  // 之前 isTableRowLine 强制首尾 `|`，流式表格末段（缺右 `|`）无法进入 PENDING，
  // 导致 GFM 直接把 `|-----|-----` 当普通文本渲染。
  while (tableStart > 0 && isTableRowLineLoose(lines[tableStart - 1])) tableStart--
  // 表头后紧跟 `|` / `||` 等分隔行分片时，单行 `|` 不满足 loose，需把表头拉回同一块。
  for (let i = 0; i < end - 1; i++) {
    if (
      isTableRowLine(lines[i]) &&
      !isTableSeparatorLine(lines[i]) &&
      isIncompleteTableSeparatorLine(lines[i + 1])
    ) {
      if (i < tableStart) tableStart = i
      break
    }
  }

  if (tableStart < end) {
    const block = lines.slice(tableStart, end)
    // 仅当块内至少有一行是完整表格行（首尾都有 |）时才进 PENDING 分支；
    // 否则可能是含 | 的普通文本（如 shell 管道），不应降级渲染。
    const hasAnyCompleteRow = block.some((l) => isTableRowLine(l))
    if (!hasAnyCompleteRow) {
      return lines.join('\n')
    }
    const hasHeader = isTableRowLine(block[0])
    const hasSep = block.length > 1 && isTableSeparatorLine(block[1])
    const hasIncompleteSep = block.length > 1 && isIncompleteTableSeparatorLine(block[1])
    const hasData =
      block.length > 2 && isTableRowLine(block[2]) && !isTableSeparatorLine(block[2])
    const validFull = hasHeader && hasSep && hasData
    const validPartial = hasHeader && hasSep
    if (hasHeader && hasIncompleteSep) {
      const stable = lines.slice(0, tableStart).join('\n')
      const pending = block.join('\n')
      return stable + (stable && pending ? '\n' : '') + STREAM_PENDING_MARK + pending
    }
    if (!validFull && !validPartial) {
      const stable = lines.slice(0, tableStart).join('\n')
      const pending = block.join('\n')
      return stable + (stable && pending ? '\n' : '') + STREAM_PENDING_MARK + pending
    }
    if (validPartial && !validFull) {
      const stable = lines.slice(0, tableStart).join('\n')
      const pending = block.join('\n')
      return stable + (stable && pending ? '\n' : '') + STREAM_PENDING_MARK + pending
    }
  }

  return lines.join('\n')
}

function renderStreamingPendingBlock(raw) {
  const lines = normalizeStreamingTableLines(
    relaxMarkdownLineBreaks(String(raw || ''))
      .split('\n')
      .filter((l) => String(l || '').trim()),
  )
  if (!lines.length) return ''

  const parts = []
  let i = 0
  while (i < lines.length) {
    if (isTableRowLine(lines[i])) {
      let j = i
      while (j < lines.length) {
        const ln = lines[j]
        if (isTableRowLine(ln) || isTableSeparatorLine(ln) || isIncompleteTableSeparatorLine(ln)) j++
        else break
      }
      const tableHtml = renderStreamingTableHtml(lines.slice(i, j))
      if (tableHtml) parts.push(tableHtml)
      else {
        for (let k = i; k < j; k++) {
          const body = tableRowCells(lines[k])
            .map((c) => inlineFormat(c))
            .join('<span class="msg-streaming-table-sep"> · </span>')
          parts.push(`<p class="msg-streaming-table-row">${body}</p>`)
        }
      }
      i = j
      continue
    }
    parts.push(`<p>${inlineFormat(lines[i])}</p>`)
    i++
  }
  return parts.join('\n')
}

/** 流式展示：已闭合块正常 Markdown；末尾半成品表格用简化行展示（避免 | 源码撑乱版式） */
export function renderMarkdownStreaming(text) {
  const stabilized = stabilizeMarkdownForStreaming(text)
  const idx = stabilized.indexOf(STREAM_PENDING_MARK)
  if (idx < 0) return renderMarkdown(stabilized)
  const stable = stabilized.slice(0, idx)
  const pending = stabilized.slice(idx + STREAM_PENDING_MARK.length)
  let html = stable ? renderMarkdown(stable) : ''
  const pendingHtml = renderStreamingPendingBlock(pending)
  if (pendingHtml) {
    html += `<div class="msg-markdown-streaming-pending">${pendingHtml}</div>`
  }
  return html
}

if (typeof window !== 'undefined') {
  window.__copyCode = function(btn) {
    const pre = btn.closest('pre')
    const code = pre?.querySelector('code')
    if (!code) return
    const done = () => {
      btn.classList.add('code-copy-btn--ok')
      window.setTimeout(() => btn.classList.remove('code-copy-btn--ok'), 1600)
    }
    navigator.clipboard.writeText(code.innerText).then(done).catch(() => {
      btn.classList.add('code-copy-btn--err')
      window.setTimeout(() => btn.classList.remove('code-copy-btn--err'), 1600)
    })
  }
}
