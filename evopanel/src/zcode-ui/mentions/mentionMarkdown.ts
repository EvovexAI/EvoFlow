const LINK_MENTION_MARKDOWN_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const INLINE_MENTION_TOKEN_PATTERN =
  /(^|\s)(\$[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._-]+|@[a-zA-Z0-9._-]+|#sess_[a-zA-Z0-9._-]+)(?=$|\s)/g;

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replaceAll("\\", "\\\\").replaceAll(">", "\\>");
}

function unescapeMarkdownText(text: string): string {
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }

    result += text[index];
  }

  return result;
}

function normalizeMarkdownDestination(destination: string): string {
  if (
    destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    destination.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)
  ) {
    return destination;
  }

  // Streamdown/rehype-harden 会把 `foo/bar.ts` 这种裸路径当成自定义协议 `foo:`，
  // 结果用户消息里的文件引用会被渲染成 `[blocked]`。这里统一补成 `./foo/bar.ts`，
  // 让它明确成为相对路径链接，既保留 Markdown 语义，也能通过安全校验正常展示。
  return `./${destination}`;
}

function normalizeFileMentionRelativePath(
  relativePath: string,
  kind: "file" | "directory",
): string {
  const trimmedRelativePath = relativePath.trim();
  if (kind === "directory") {
    return `${trimmedRelativePath.replace(/[\\/]+$/, "")}/`;
  }

  return trimmedRelativePath;
}

export function buildFileMentionMarkdown(
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
): string {
  const normalizedRelativePath = normalizeFileMentionRelativePath(relativePath, kind);
  return `[${escapeMarkdownLabel(label)}](${escapeMarkdownDestination(normalizeMarkdownDestination(normalizedRelativePath))})`;
}

export function buildSkillMentionMarkdown(label: string, skillPath?: string): string {
  if (!skillPath) {
    return `$${label}`;
  }

  return `[${escapeMarkdownLabel(`$${label}`)}](${escapeMarkdownDestination(normalizeMarkdownDestination(skillPath))})`;
}

export function buildSubagentMentionMarkdown(label: string): string {
  return `@${label}`;
}

export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel || trimmedLabel === sessionId) {
    return `#${sessionId}`;
  }
  return `[${escapeMarkdownLabel(`#${trimmedLabel}`)}](#${escapeMarkdownDestination(sessionId)})`;
}

// Plugin 引用的 canonical 持久化载体：
// `[@Label](plugin://stable-id)`。身份只在 destination；label 仅用于展示。
export function buildPluginMentionMarkdown(label: string, pluginId: string): string {
  return `[${escapeMarkdownLabel(`@${label}`)}](plugin://${escapeMarkdownDestination(pluginId)})`;
}

type MentionTextPart =
  | { type: "text"; text: string }
  | { type: "file"; label: string }
  | { type: "directory"; label: string }
  | { type: "skill"; label: string }
  | { type: "command"; label: string }
  | { type: "subagent"; label: string }
  | { type: "session"; label: string }
  | { type: "plugin"; label: string; pluginId?: string };

const PLUGIN_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePluginStableId(destination: string): string | undefined {
  if (!destination.startsWith("plugin://")) return undefined;
  const candidate = destination.slice("plugin://".length);
  return candidate.length <= 256 && PLUGIN_STABLE_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

/**
 * 将技能 slug（如 code-review）格式化为聊天气泡中的可读标题（Code Review）。
 * 已是包含空格的短语时原样返回，避免破坏用户自定义展示名。
 */
export function formatSkillMentionDisplayLabel(label: string): string {
  const t = label.trim();
  if (!t) {
    return label;
  }
  if (t.includes(" ") && !t.includes("-") && !t.includes("_")) {
    return t;
  }
  const words = t.split(/[-_]/).filter(Boolean);
  if (words.length === 0) {
    return label;
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function isDirectoryMentionDestination(destination: string): boolean {
  return /[\\/]$/.test(destination);
}

function parseInlineMentionTokens(segment: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of segment.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) {
      continue;
    }
    const matchStart = match.index ?? 0;
    const tokenStart = matchStart + prefix.length;
    if (tokenStart > cursor) {
      parts.push({
        type: "text",
        text: segment.slice(cursor, tokenStart),
      });
    }
    if (token.startsWith("$")) {
      parts.push({ type: "skill", label: token.slice(1) });
    } else if (token.startsWith("/")) {
      parts.push({ type: "command", label: token.slice(1) });
    } else if (token.startsWith("@")) {
      parts.push({ type: "subagent", label: token.slice(1) });
    } else if (token.startsWith("#")) {
      parts.push({ type: "session", label: token.slice(1) });
    } else {
      parts.push({ type: "text", text: token });
    }
    cursor = tokenStart + token.length;
  }

  if (cursor < segment.length) {
    parts.push({ type: "text", text: segment.slice(cursor) });
  }

  return parts;
}

export function parseMentionMarkdown(content: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  LINK_MENTION_MARKDOWN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of content.matchAll(LINK_MENTION_MARKDOWN_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const label = match[1] ? unescapeMarkdownText(match[1]) : "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push(...parseInlineMentionTokens(content.slice(cursor, matchStart)));
    }
    if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
      parts.push({ type: "session", label: label.startsWith("#") ? label.slice(1) : label });
    } else if (destination.startsWith("plugin://")) {
      // Plugin 引用链接绝不能落入 file 分支或被当外链处理；
      // 发送后曾只保留 label，消息层失去 stable ID，只能固定显示兜底图标。
      // 这里原样保留合法 destination 身份供 UI 与 Session catalog 关联；非法目标仍保持
      // display-only，不做 label 猜测、percent decode 或 canonical 改写。
      const pluginId = parsePluginStableId(destination);
      parts.push({
        type: "plugin",
        label: label.startsWith("@") ? label.slice(1) : label,
        ...(pluginId ? { pluginId } : {}),
      });
    } else if (label.startsWith("$")) {
      parts.push({ type: "skill", label: label.slice(1) });
    } else if (isDirectoryMentionDestination(destination)) {
      // 目录 mention 之前只按普通 file 还原，消息回显层拿不到 folder 语义，
      // 于是文件夹候选在气泡里会继续显示成普通文件图标。这里根据链接目标是否以斜杠结尾恢复目录类型。
      parts.push({ type: "directory", label: label.startsWith("@") ? label.slice(1) : label });
    } else {
      parts.push({ type: "file", label: label.startsWith("@") ? label.slice(1) : label });
    }
    cursor = matchStart + fullMatch.length;
  }

  if (cursor < content.length) {
    parts.push(...parseInlineMentionTokens(content.slice(cursor)));
  }

  return parts;
}
