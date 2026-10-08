const ASSISTANT_PATH_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
};
const ASSISTANT_PATH_ENCODED_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "%22": "%22",
  "%27": "%27",
  "%60": "%60",
  "%E2%80%98": "%E2%80%99",
  "%E2%80%9C": "%E2%80%9D",
};

export function isBalancedAssistantPathQuotePair(opening: string, closing: string): boolean {
  return ASSISTANT_PATH_QUOTE_PAIRS[opening] === closing;
}

export function isAssistantPathQuoteCharacter(character: string | undefined): boolean {
  return (
    character === '"' ||
    character === "'" ||
    character === "`" ||
    character === "“" ||
    character === "”" ||
    character === "‘" ||
    character === "’"
  );
}

/**
 * 仅去掉文件路径外围成对引号；不匹配时保留原文，避免把异常模型输出
 * 或文件名中的引号静默改写成另一个路径。
 */
export function stripBalancedAssistantPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  // rehype-harden 可能把带空格的相对 Markdown 目标规整成 `/“path”`；
  // 仅在引号内容仍是相对路径时还原这个保护层，不影响真正的绝对路径。
  if (trimmed.startsWith("/")) {
    const protectedRelative = stripBalancedAssistantPathQuotes(trimmed.slice(1));
    if (protectedRelative !== trimmed.slice(1)) {
      return protectedRelative.startsWith("./") || protectedRelative.startsWith("/")
        ? protectedRelative
        : `/${protectedRelative}`;
    }
  }

  const relativePrefix = trimmed.startsWith("./") ? "./" : "";
  const candidate = relativePrefix ? trimmed.slice(2) : trimmed;
  if (candidate.length < 2) return trimmed;

  const closingQuote = ASSISTANT_PATH_QUOTE_PAIRS[candidate[0]!];
  if (closingQuote && isBalancedAssistantPathQuotePair(candidate[0]!, candidate.at(-1)!)) {
    return `${relativePrefix}${candidate.slice(1, -1).trim()}`;
  }

  const upperCandidate = candidate.toUpperCase();
  for (const [encodedOpening, encodedClosing] of Object.entries(
    ASSISTANT_PATH_ENCODED_QUOTE_PAIRS,
  )) {
    if (
      upperCandidate.startsWith(encodedOpening) &&
      upperCandidate.endsWith(encodedClosing) &&
      candidate.length > encodedOpening.length + encodedClosing.length
    ) {
      return `${relativePrefix}${candidate.slice(encodedOpening.length, -encodedClosing.length).trim()}`;
    }
  }
  return trimmed;
}
