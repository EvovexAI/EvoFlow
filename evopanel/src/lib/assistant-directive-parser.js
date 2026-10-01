/**
 * 助手正文特化指令（`::name{key=value …}`）的通用解析器。
 *
 * 与提示词侧约定成对出现：提示词教模型按协议输出指令，本文件是宽容读者——
 * 只负责定位、截取、解参，不理解任何具体指令的业务含义。
 *
 * 设计要点（每处宽容都是实盘教训，且按指令 opt-in，避免误伤其它协议）：
 * - 模型偶尔把 `::` 打成 `:` / `:::`，或使用成对中文智能引号；仅由调用方 opt-in 放宽。
 * - 指令落在 Markdown 代码区间（围栏/行内/`<code>`/`<pre>`）时视为示例原文，不解析。
 * - 流式输出可能截断到一半：未闭合的半截指令与仍是合法前缀的文末尾巴要能被识别，
 *   交给上层在渲染前隐藏，避免协议原文闪现给用户。
 */

/** @typedef {{ start: number, end: number, name: string, raw: string, parameters: Record<string, string> | null }} ParsedAssistantDirective */
/** @typedef {readonly [start: number, end: number]} AssistantTextRange */

/**
 * @typedef {Object} AssistantDirectiveSyntaxOptions
 * @property {boolean} [allowSmartQuotes] 允许成对中文智能引号（“” ‘’）
 * @property {boolean} [allowBacktickQuotes] 允许成对反引号包值（模型常把路径包进行内反引号）
 * @property {boolean} [allowSingleColon] 允许单冒号前缀（`:` 代替 `::`）
 * @property {boolean} [allowTripleColon] 允许三冒号前缀（`:::` 代替 `::`）
 */

/**
 * @typedef {Object} AssistantDirectivePrefixOptions
 * @property {number} [minimumSingleColonPrefixLength]
 * @property {readonly string[]} [singleColonDirectiveNames]
 * @property {readonly string[]} [tripleColonDirectiveNames]
 */

function escapeRegExp(value) {
  return value.replace(/[.*+?${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string} directiveName
 * @param {AssistantDirectiveSyntaxOptions} [options]
 */
function createDirectiveStartPattern(directiveName, options = {}) {
  // 不能全局放宽冒号数，否则 code-comment 等其它协议会被意外兼容。
  // opt-in 时用负向后顾拒绝从连续冒号中间起匹配。
  const minimumColonCount = options.allowSingleColon ? 1 : 2
  const maximumColonCount = options.allowTripleColon ? 3 : 2
  const prefix = `(?<!:):{${minimumColonCount},${maximumColonCount}}`
  return new RegExp(`${prefix}${escapeRegExp(directiveName)}\\s*\\{`, 'g')
}

/** @typedef {{ open: string, close: string }} DirectiveQuoteState */

/**
 * @param {string | undefined} character
 * @param {AssistantDirectiveSyntaxOptions} options
 * @returns {DirectiveQuoteState | null}
 */
function getDirectiveQuoteState(character, options) {
  if (character === '"' || character === "'") {
    return { open: character, close: character }
  }
  // 模型经常把路径包进行内反引号（与 @@…@@ 协议同一毛病）；仅由调用方 opt-in，
  // 否则未识别时值会按裸值截断在第一个空格，含空格的路径解析失败。
  if (options.allowBacktickQuotes && character === '`') {
    return { open: character, close: character }
  }
  // 中文模型输出可能使用成对智能引号；未识别时会退化为未加引号值，
  // 使空格截断路径或把引号字符带入后续文件解析。仅由 citation opt-in，保持其它指令严格。
  if (!options.allowSmartQuotes) return null
  if (character === '“') return { open: character, close: '”' }
  if (character === '‘') return { open: character, close: '’' }
  return null
}

/**
 * @param {string} content
 * @param {number} openBraceIndex
 * @param {AssistantDirectiveSyntaxOptions} options
 * @returns {number} closing brace index, or -1 when unclosed
 */
function findDirectiveClosingBrace(content, openBraceIndex, options) {
  let quote = null
  let escaped = false

  for (let index = openBraceIndex + 1; index < content.length; index += 1) {
    const character = content[index]
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote.close) {
        quote = null
      }
      continue
    }

    const quoteState = getDirectiveQuoteState(character, options)
    if (quoteState) {
      quote = quoteState
    } else if (character === '}') {
      return index
    }
  }

  return -1
}

/**
 * @param {string} source
 * @param {number} start
 * @param {DirectiveQuoteState} quote
 * @returns {{ nextIndex: number, value: string } | null}
 */
function parseQuotedValue(source, start, quote) {
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === quote.close) return { nextIndex: index + 1, value }
    if (character !== '\\' || index + 1 >= source.length) {
      value += character
      continue
    }

    const escapedCharacter = source[index + 1]
    if (
      escapedCharacter === quote.open ||
      escapedCharacter === quote.close ||
      escapedCharacter === '\\'
    ) {
      value += escapedCharacter
    } else {
      // 指令不是 JSON；未知转义必须保留反斜杠，避免把 Windows 路径改坏（`D:\docs` 的 `\d`）。
      value += `\\${escapedCharacter}`
    }
    index += 1
  }

  return null
}

/**
 * @param {string} source
 * @param {AssistantDirectiveSyntaxOptions} options
 * @returns {Record<string, string> | null}
 */
function parseDirectiveParameters(source, options) {
  /** @type {Record<string, string>} */
  const parameters = {}
  let index = 0

  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index] ?? '')) index += 1
    if (index >= source.length) return parameters

    const nameMatch = /^[a-zA-Z_][a-zA-Z\d_-]*/.exec(source.slice(index))
    if (!nameMatch) return null
    const name = nameMatch[0]
    index += name.length

    while (index < source.length && /\s/.test(source[index] ?? '')) index += 1
    if (source[index] !== '=') return null
    index += 1
    while (index < source.length && /\s/.test(source[index] ?? '')) index += 1
    if (index >= source.length) return null

    let value
    const quote = getDirectiveQuoteState(source[index], options)
    if (quote) {
      const parsedValue = parseQuotedValue(source, index, quote)
      if (!parsedValue) return null
      value = parsedValue.value
      index = parsedValue.nextIndex
    } else {
      const valueStart = index
      while (index < source.length && !/[\s,]/.test(source[index] ?? '')) index += 1
      value = source.slice(valueStart, index)
      if (!value) return null
    }

    if (index < source.length && !/[\s,]/.test(source[index] ?? '')) return null
    parameters[name] = value
  }

  return parameters
}

/**
 * 提取正文中所有完整闭合的指令（含参数解析结果）。
 * @param {string} content
 * @param {string} directiveName
 * @param {AssistantDirectiveSyntaxOptions} [options]
 * @returns {ParsedAssistantDirective[]}
 */
export function extractAssistantDirectives(content, directiveName, options = {}) {
  if (!content.trim() || !directiveName.trim()) return []

  const startPattern = createDirectiveStartPattern(directiveName, options)
  /** @type {ParsedAssistantDirective[]} */
  const directives = []
  let consumedUntil = 0
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0
    if (start < consumedUntil) continue
    const openBraceIndex = start + (match[0]?.lastIndexOf('{') ?? -1)
    if (openBraceIndex < start) continue

    const closingBraceIndex = findDirectiveClosingBrace(content, openBraceIndex, options)
    if (closingBraceIndex < 0) continue
    const end = closingBraceIndex + 1
    consumedUntil = end
    directives.push({
      start,
      end,
      name: directiveName,
      raw: content.slice(start, end),
      parameters: parseDirectiveParameters(
        content.slice(openBraceIndex + 1, closingBraceIndex),
        options,
      ),
    })
  }

  return directives
}

/**
 * @param {AssistantTextRange[]} ranges
 * @returns {AssistantTextRange[]}
 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  /** @type {Array<[number, number]>} */
  const merged = []
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end)
    } else {
      merged.push([start, end])
    }
  }
  return merged
}

/**
 * 标出 Markdown 代码区间：围栏块、行内代码、<code>/<pre>。
 * 落在这些区间里的指令是示例原文，不是协议输出。
 * @param {string} content
 * @returns {AssistantTextRange[]}
 */
export function findMarkdownCodeRanges(content) {
  /** @type {Array<[number, number]>} */
  const ranges = []
  /** @type {Array<[number, number]>} */
  const fencedRanges = []
  let fence = null
  let lineStart = 0

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex + 1
    const line = content.slice(lineStart, newlineIndex < 0 ? content.length : newlineIndex)
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) {
        fence = { character: marker[0], length: marker.length, start: lineStart }
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fencedRanges.push([fence.start, lineEnd])
        fence = null
      }
    }
    lineStart = lineEnd
  }
  if (fence) fencedRanges.push([fence.start, content.length])
  ranges.push(...fencedRanges)

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0
    ranges.push([start, start + (match[0]?.length ?? 0)])
  }

  const isFenced = (index) => fencedRanges.some(([start, end]) => index >= start && index < end)
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '`' || isFenced(index)) continue
    let markerLength = 1
    while (content[index + markerLength] === '`') markerLength += 1
    const marker = '`'.repeat(markerLength)
    const closingIndex = content.indexOf(marker, index + markerLength)
    if (closingIndex < 0 || isFenced(closingIndex)) {
      index += markerLength - 1
      continue
    }
    ranges.push([index, closingIndex + markerLength])
    index = closingIndex + markerLength - 1
  }

  return mergeRanges(ranges)
}

/**
 * @param {number} start
 * @param {number} end
 * @param {readonly AssistantTextRange[]} ranges
 * @returns {boolean}
 */
export function overlapsAssistantTextRanges(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart)
}

/**
 * 找到末尾“未闭合指令”的起始位置（流式进行中用）。
 * 只有仍然符合“参数前缀”形态的半截指令才返回起点；闭合引号后出现普通正文时
 * 参数解析会失败，此时保留原文，避免缺失 `}` 把后文吞掉。
 * @param {string} content
 * @param {string} directiveName
 * @param {readonly AssistantTextRange[]} [protectedRanges]
 * @param {AssistantDirectiveSyntaxOptions} [options]
 * @returns {number | null}
 */
export function findUnclosedAssistantDirectiveStart(
  content,
  directiveName,
  protectedRanges = [],
  options = {},
) {
  const startPattern = createDirectiveStartPattern(directiveName, options)
  let unclosedStart = null
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0
    const openBraceIndex = start + (match[0]?.lastIndexOf('{') ?? -1)
    if (
      openBraceIndex < start ||
      overlapsAssistantTextRanges(start, openBraceIndex + 1, protectedRanges)
    ) {
      continue
    }
    if (findDirectiveClosingBrace(content, openBraceIndex, options) < 0) {
      const parameterPrefix = content.slice(openBraceIndex + 1)
      let quote = null
      let escaped = false
      for (const character of parameterPrefix) {
        if (quote !== null) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === quote.close) quote = null
        } else {
          quote = getDirectiveQuoteState(character, options)
        }
      }
      const isParameterPrefix =
        parseDirectiveParameters(parameterPrefix, options) !== null ||
        quote !== null ||
        /(?:^|[\s,])[a-zA-Z_][a-zA-Z\d_-]*\s*(?:=\s*)?$/.test(parameterPrefix)
      if (isParameterPrefix) unclosedStart = start
    }
  }
  return unclosedStart
}

/**
 * 流式尾部可能刚开始输出特化指令时，先把仍匹配协议名称前缀的内容暂存。
 * 只检查文末连续尾部，且跳过 Markdown 代码区间；一旦前缀分叉，返回 null 让正文照常显示。
 * @param {string} content
 * @param {readonly string[]} directiveNames
 * @param {readonly AssistantTextRange[]} [protectedRanges]
 * @param {AssistantDirectivePrefixOptions} [options]
 * @returns {number | null}
 */
export function findAssistantDirectivePrefixStart(
  content,
  directiveNames,
  protectedRanges = [],
  options = {},
) {
  const singleColonNames = new Set(options.singleColonDirectiveNames ?? [])
  const tripleColonNames = new Set(options.tripleColonDirectiveNames ?? [])
  const minimumSingleColonPrefixLength = options.minimumSingleColonPrefixLength ?? 2

  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index] !== ':') continue
    if (content[index - 1] === ':') continue
    if (overlapsAssistantTextRanges(index, index + 1, protectedRanges)) continue

    const suffix = content.slice(index)
    const isPrefix = directiveNames.some((directiveName) => {
      const canonicalName = `::${directiveName}`
      const tripleColonName = `:::${directiveName}`
      if (
        tripleColonNames.has(directiveName) &&
        suffix.startsWith(':::') &&
        (tripleColonName.startsWith(suffix) ||
          (suffix.startsWith(tripleColonName) &&
            /^\s*$/.test(suffix.slice(tripleColonName.length))))
      ) {
        return true
      }
      if (
        suffix.startsWith('::') &&
        (canonicalName.startsWith(suffix) ||
          (suffix.startsWith(canonicalName) && /^\s*$/.test(suffix.slice(canonicalName.length))))
      ) {
        return true
      }

      if (!singleColonNames.has(directiveName) || suffix.length < minimumSingleColonPrefixLength) {
        return false
      }
      const compatibilityName = `:${directiveName}`
      if (compatibilityName.startsWith(suffix)) return true
      return (
        suffix.startsWith(compatibilityName) && /^\s*$/.test(suffix.slice(compatibilityName.length))
      )
    })
    if (isPrefix) return index
  }
  return null
}
