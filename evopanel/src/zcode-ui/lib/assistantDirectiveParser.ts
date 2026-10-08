interface ParsedAssistantDirective {
  end: number;
  name: string;
  parameters: Readonly<Record<string, string>> | null;
  raw: string;
  start: number;
}

export type AssistantTextRange = readonly [start: number, end: number];

interface AssistantDirectiveSyntaxOptions {
  allowSmartQuotes?: boolean;
  allowSingleColon?: boolean;
  allowTripleColon?: boolean;
}

interface AssistantDirectivePrefixOptions {
  minimumSingleColonPrefixLength?: number;
  singleColonDirectiveNames?: readonly string[];
  tripleColonDirectiveNames?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createDirectiveStartPattern(
  directiveName: string,
  options: AssistantDirectiveSyntaxOptions = {},
): RegExp {
  // 模型偶尔把文件引用的双冒号输出成单/三冒号；不能全局放宽，否则
  // code-comment 等协议也会被意外兼容。opt-in 时同时拒绝从连续冒号中间起匹配。
  const minimumColonCount = options.allowSingleColon ? 1 : 2;
  const maximumColonCount = options.allowTripleColon ? 3 : 2;
  const prefix = `(?<!:):{${minimumColonCount},${maximumColonCount}}`;
  return new RegExp(`${prefix}${escapeRegExp(directiveName)}\\s*\\{`, "g");
}

interface DirectiveQuoteState {
  close: string;
  open: string;
}

function getDirectiveQuoteState(
  character: string | undefined,
  options: AssistantDirectiveSyntaxOptions,
): DirectiveQuoteState | null {
  if (character === '"' || character === "'") {
    return { open: character, close: character };
  }
  // 中文模型输出可能使用成对智能引号；未识别时会退化为未加引号值，
  // 使空格截断路径或把引号字符带入后续文件解析。仅由 citation opt-in，保持其它 directive 严格。
  if (!options.allowSmartQuotes) return null;
  if (character === "“") return { open: character, close: "”" };
  if (character === "‘") return { open: character, close: "’" };
  return null;
}

function findDirectiveClosingBrace(
  content: string,
  openBraceIndex: number,
  options: AssistantDirectiveSyntaxOptions,
): number {
  let quote: DirectiveQuoteState | null = null;
  let escaped = false;

  for (let index = openBraceIndex + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote.close) {
        quote = null;
      }
      continue;
    }

    const quoteState = getDirectiveQuoteState(character, options);
    if (quoteState) {
      quote = quoteState;
    } else if (character === "}") {
      return index;
    }
  }

  return -1;
}

function parseQuotedValue(
  source: string,
  start: number,
  quote: DirectiveQuoteState,
): { nextIndex: number; value: string } | null {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote.close) return { nextIndex: index + 1, value };
    if (character !== "\\" || index + 1 >= source.length) {
      value += character;
      continue;
    }

    const escapedCharacter = source[index + 1]!;
    if (
      escapedCharacter === quote.open ||
      escapedCharacter === quote.close ||
      escapedCharacter === "\\"
    ) {
      value += escapedCharacter;
    } else {
      // Directive 不是 JSON；未知转义必须保留反斜杠，避免把 Windows 路径改坏。
      value += `\\${escapedCharacter}`;
    }
    index += 1;
  }

  return null;
}

function parseDirectiveParameters(
  source: string,
  options: AssistantDirectiveSyntaxOptions,
): Record<string, string> | null {
  const parameters: Record<string, string> = {};
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) return parameters;

    const nameMatch = /^[a-zA-Z_][a-zA-Z\d_-]*/.exec(source.slice(index));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    index += name.length;

    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") return null;
    index += 1;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) return null;

    let value: string;
    const quote = getDirectiveQuoteState(source[index], options);
    if (quote) {
      const parsedValue = parseQuotedValue(source, index, quote);
      if (!parsedValue) return null;
      value = parsedValue.value;
      index = parsedValue.nextIndex;
    } else {
      const valueStart = index;
      while (index < source.length && !/[\s,]/.test(source[index] ?? "")) index += 1;
      value = source.slice(valueStart, index);
      if (!value) return null;
    }

    if (index < source.length && !/[\s,]/.test(source[index] ?? "")) return null;
    parameters[name] = value;
  }

  return parameters;
}

export function extractAssistantDirectives(
  content: string,
  directiveName: string,
  options: AssistantDirectiveSyntaxOptions = {},
): ParsedAssistantDirective[] {
  if (!content.trim() || !directiveName.trim()) return [];

  const startPattern = createDirectiveStartPattern(directiveName, options);
  const directives: ParsedAssistantDirective[] = [];
  let consumedUntil = 0;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    if (start < consumedUntil) continue;
    const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
    if (openBraceIndex < start) continue;

    const closingBraceIndex = findDirectiveClosingBrace(content, openBraceIndex, options);
    if (closingBraceIndex < 0) continue;
    const end = closingBraceIndex + 1;
    consumedUntil = end;
    directives.push({
      start,
      end,
      name: directiveName,
      raw: content.slice(start, end),
      parameters: parseDirectiveParameters(
        content.slice(openBraceIndex + 1, closingBraceIndex),
        options,
      ),
    });
  }

  return directives;
}

function mergeRanges(ranges: AssistantTextRange[]): AssistantTextRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function findMarkdownCodeRanges(content: string): AssistantTextRange[] {
  const ranges: Array<[number, number]> = [];
  const fencedRanges: Array<[number, number]> = [];
  let fence: { character: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf("\n", lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex + 1;
    const line = content.slice(lineStart, newlineIndex < 0 ? content.length : newlineIndex);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        fence = {
          character: marker[0] as "`" | "~",
          length: marker.length,
          start: lineStart,
        };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fencedRanges.push([fence.start, lineEnd]);
        fence = null;
      }
    }
    lineStart = lineEnd;
  }
  if (fence) fencedRanges.push([fence.start, content.length]);
  ranges.push(...fencedRanges);

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0;
    ranges.push([start, start + (match[0]?.length ?? 0)]);
  }

  const isFenced = (index: number) =>
    fencedRanges.some(([start, end]) => index >= start && index < end);
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "`" || isFenced(index)) continue;
    let markerLength = 1;
    while (content[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closingIndex = content.indexOf(marker, index + markerLength);
    if (closingIndex < 0 || isFenced(closingIndex)) {
      index += markerLength - 1;
      continue;
    }
    ranges.push([index, closingIndex + markerLength]);
    index = closingIndex + markerLength - 1;
  }

  return mergeRanges(ranges);
}

export function overlapsAssistantTextRanges(
  start: number,
  end: number,
  ranges: readonly AssistantTextRange[],
): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function findUnclosedAssistantDirectiveStart(
  content: string,
  directiveName: string,
  protectedRanges: readonly AssistantTextRange[] = [],
  options: AssistantDirectiveSyntaxOptions = {},
): number | null {
  const startPattern = createDirectiveStartPattern(directiveName, options);
  let unclosedStart: number | null = null;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
    if (
      openBraceIndex < start ||
      overlapsAssistantTextRanges(start, openBraceIndex + 1, protectedRanges)
    ) {
      continue;
    }
    if (findDirectiveClosingBrace(content, openBraceIndex, options) < 0) {
      // 只有仍然符合“参数前缀”的半截 directive 才隐藏。闭合引号后又出现
      // 普通正文时，参数解析会失败，于是保留原文，避免缺失 `}` 把后文吞掉。
      const parameterPrefix = content.slice(openBraceIndex + 1);
      let quote: DirectiveQuoteState | null = null;
      let escaped = false;
      for (const character of parameterPrefix) {
        if (quote !== null) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === quote.close) quote = null;
        } else {
          quote = getDirectiveQuoteState(character, options);
        }
      }
      const isParameterPrefix =
        parseDirectiveParameters(parameterPrefix, options) !== null ||
        quote !== null ||
        /(?:^|[\s,])[a-zA-Z_][a-zA-Z\d_-]*\s*(?:=\s*)?$/.test(parameterPrefix);
      if (isParameterPrefix) unclosedStart = start;
    }
  }
  return unclosedStart;
}

/**
 * 流式尾部可能刚开始输出特化 directive 时，先把仍然匹配协议名称前缀的内容暂存。
 * 只检查文末连续尾部，且跳过 Markdown 代码范围；一旦前缀分叉，返回 null 让正文照常显示。
 */
export function findAssistantDirectivePrefixStart(
  content: string,
  directiveNames: readonly string[],
  protectedRanges: readonly AssistantTextRange[] = [],
  options: AssistantDirectivePrefixOptions = {},
): number | null {
  const singleColonNames = new Set(options.singleColonDirectiveNames ?? []);
  const tripleColonNames = new Set(options.tripleColonDirectiveNames ?? []);
  const minimumSingleColonPrefixLength = options.minimumSingleColonPrefixLength ?? 2;

  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index] !== ":") continue;
    if (content[index - 1] === ":") continue;
    if (overlapsAssistantTextRanges(index, index + 1, protectedRanges)) continue;

    const suffix = content.slice(index);
    const isPrefix = directiveNames.some((directiveName) => {
      const canonicalName = `::${directiveName}`;
      const tripleColonName = `:::${directiveName}`;
      if (
        tripleColonNames.has(directiveName) &&
        suffix.startsWith(":::") &&
        (tripleColonName.startsWith(suffix) ||
          (suffix.startsWith(tripleColonName) &&
            /^\s*$/.test(suffix.slice(tripleColonName.length))))
      ) {
        return true;
      }
      if (
        suffix.startsWith("::") &&
        (canonicalName.startsWith(suffix) ||
          (suffix.startsWith(canonicalName) && /^\s*$/.test(suffix.slice(canonicalName.length))))
      ) {
        return true;
      }

      if (!singleColonNames.has(directiveName) || suffix.length < minimumSingleColonPrefixLength) {
        return false;
      }
      const compatibilityName = `:${directiveName}`;
      if (compatibilityName.startsWith(suffix)) return true;
      return (
        suffix.startsWith(compatibilityName) && /^\s*$/.test(suffix.slice(compatibilityName.length))
      );
    });
    if (isPrefix) return index;
  }
  return null;
}
