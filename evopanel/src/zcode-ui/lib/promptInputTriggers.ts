export type PromptInputTrigger = "/" | "@" | "$" | "#";

export interface ActivePromptInputTrigger {
  trigger: PromptInputTrigger;
  query: string;
}

export function getPromptInputTriggerSignature(
  activeTrigger: ActivePromptInputTrigger | null,
): string | null {
  return activeTrigger ? `${activeTrigger.trigger}:${activeTrigger.query}` : null;
}

export interface PromptInputSuggestionItem {
  id: string;
  trigger: PromptInputTrigger;
  value: string;
  label: string;
  description: string;
  keywords?: string[];
  data?: {
    path?: string;
    scope?: "built-in" | "workspace" | "user" | "plugin";
    source?: "built-in" | "user" | "plugin";
    model?: string;
  };
}

type PromptInputReplacementCandidates = string | readonly string[];

const ACTIVE_TRIGGER_RE = /(^|\s)([/@$#¥￥])([^\s/@$#¥￥]*)$/;
// 中文输入通常不在句中插入空格；仅放宽 @，避免改变 slash、skill、session 面板的触发边界。
const ACTIVE_MENTION_TRIGGER_RE =
  /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])(@)([^\s/@$#¥￥]*)$/u;
// 放宽中文紧邻 @ 后，`联系邮箱@example.com` / `用户@例子.公司` 会被当成 mention。
// 仅在汉字直接紧邻 @ 时拒绝域名形态（`x.y`）的 query；中文标点后（`看看，@foo.bar`）和
// 空格后的 `@foo.bar` 不是邮箱形态，保持触发。
const DOMAIN_LIKE_QUERY_RE = /\S\.\S/;
const HAN_PREFIX_RE = /\p{Script=Han}/u;
const ACTIVE_TRIGGER_TAIL_RE = /^[^\s/@$#¥￥]*/;

function normalizePromptInputTriggerAlias(trigger: string): PromptInputTrigger {
  if (trigger === "¥" || trigger === "￥") {
    // 部分键盘/输入法输入 skill trigger 时会产生 `¥` 或全角 `￥`。
    // 这里只把触发语义归一为 `$`，让它唤起 skill 面板；不在输入层改写用户实际输入字符。
    return "$";
  }

  return trigger as PromptInputTrigger;
}

function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

function scorePromptInputSuggestion(
  suggestion: PromptInputSuggestionItem,
  query: string,
): number | null {
  const valueScore = scoreFuzzyMatch(suggestion.value, query);
  const labelScore = scoreFuzzyMatch(suggestion.label, query);
  const descriptionScore = scoreFuzzyMatch(suggestion.description, query);
  const keywordScore = Math.min(
    ...(suggestion.keywords ?? []).map((keyword) => {
      const score = scoreFuzzyMatch(keyword, query);
      return score === null ? Number.POSITIVE_INFINITY : score + 450;
    }),
    Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    valueScore ?? Number.POSITIVE_INFINITY,
    labelScore !== null ? labelScore + 50 : Number.POSITIVE_INFINITY,
    descriptionScore !== null ? descriptionScore + 250 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

export function extractActivePromptInputTrigger(
  textBeforeCursor: string,
): ActivePromptInputTrigger | null {
  const match =
    ACTIVE_MENTION_TRIGGER_RE.exec(textBeforeCursor) ?? ACTIVE_TRIGGER_RE.exec(textBeforeCursor);
  if (!match) {
    return null;
  }
  if (HAN_PREFIX_RE.test(match[1] ?? "") && DOMAIN_LIKE_QUERY_RE.test(match[3] ?? "")) {
    return null;
  }

  return {
    trigger: normalizePromptInputTriggerAlias(match[2] ?? ""),
    query: match[3] ?? "",
  };
}

export function getActivePromptInputTokenTailLength(
  activeTrigger: ActivePromptInputTrigger,
  textAfterCursor: string,
  replacementCandidates: PromptInputReplacementCandidates,
): number {
  if (activeTrigger.query.length === 0) {
    // 用户在已有文字前插入裸触发符时，光标后的正文不是当前 token 的补全部分。
    // 之前会把这些正文当 tail 一起替换，导致选中 @/#/$// 候选后清掉后面的文字。
    return 0;
  }

  const tailMatch = ACTIVE_TRIGGER_TAIL_RE.exec(textAfterCursor);
  const tailText = tailMatch?.[0] ?? "";
  if (!tailText) {
    return 0;
  }

  const normalizedQuery = activeTrigger.query.toLowerCase();
  const candidates = Array.isArray(replacementCandidates)
    ? replacementCandidates
    : [replacementCandidates];
  let matchedTailLength = 0;

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim().replace(/^[/@$#¥￥]+/, "");
    if (!candidate) {
      continue;
    }

    const normalizedCandidate = candidate.toLowerCase();
    if (!normalizedCandidate.startsWith(normalizedQuery)) {
      continue;
    }

    const expectedTail = candidate.slice(activeTrigger.query.length);
    if (!expectedTail) {
      continue;
    }

    const comparableLength = Math.min(tailText.length, expectedTail.length);
    const typedTail = tailText.slice(0, comparableLength);
    // 完整 `/goal` 后紧贴的正文若被当作同一个 token 的 tail 会整段删除。
    // 这里只删除“候选值未输入后缀”能对上的那一小段，比如 `/go|al` 里的 `al`。
    if (expectedTail.toLowerCase().startsWith(typedTail.toLowerCase())) {
      matchedTailLength = Math.max(matchedTailLength, comparableLength);
    }
  }

  return matchedTailLength;
}

export function filterPromptInputSuggestions(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): PromptInputSuggestionItem[] {
  if (query === null) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return suggestions;
  }

  return suggestions
    .map((suggestion, index) => {
      const bestScore = scorePromptInputSuggestion(suggestion, normalizedQuery);
      if (bestScore === null) {
        return null;
      }

      return {
        index,
        score: bestScore,
        suggestion,
      };
    })
    .filter(
      (
        item,
      ): item is {
        index: number;
        score: number;
        suggestion: PromptInputSuggestionItem;
      } => item !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return left.suggestion.label.localeCompare(right.suggestion.label);
    })
    .map((item) => item.suggestion);
}

export function getBestPromptInputSuggestionIndex(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): number {
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  if (!normalizedQuery) {
    return 0;
  }

  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  suggestions.forEach((suggestion, index) => {
    const score = scorePromptInputSuggestion(suggestion, normalizedQuery);
    if (score === null) {
      return;
    }

    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}
