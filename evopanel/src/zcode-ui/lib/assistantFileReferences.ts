import {
  resolveMarkdownFileLink,
  type MarkdownFileLinkResolveOptions,
} from "@/lib/markdownFileLink.js";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import { decodeFilePathUriEscapes, joinFilePath } from "@/lib/path.js";
import { MEDIA_PREVIEW_FORMATS } from "@zcode/shared";
import {
  extractZCodeFileCitationDirectives,
  resolveZCodeFileCitationPreviewKind,
} from "@/lib/zcodeFileCitation.js";
import {
  isBalancedAssistantPathQuotePair,
  isAssistantPathQuoteCharacter,
  stripBalancedAssistantPathQuotes,
} from "@/lib/assistantPathQuotes.js";

export type AssistantPreviewFileKind =
  | "markdown"
  | "html"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "video"
  | "audio";

export type AssistantPreviewFileSubtitleId =
  | "chat.previewCards.markdown"
  | "chat.previewCards.htmlWebsite"
  | "chat.previewCards.docx"
  | "chat.previewCards.xlsx"
  | "chat.previewCards.pptx"
  | "chat.previewCards.pdf"
  | "chat.previewCards.video"
  | "chat.previewCards.audio";

interface AssistantPreviewFileTypeDefinition {
  extensions: readonly string[];
  kind: AssistantPreviewFileKind;
  subtitleId: AssistantPreviewFileSubtitleId;
}

export interface AssistantFileReference {
  end: number;
  kind: AssistantPreviewFileKind;
  path: string;
  raw: string;
  start: number;
}

export type AssistantFilePathResolveOptions = MarkdownFileLinkResolveOptions;

// 新增文件类型只需登记扩展名和展示文案；正文抽取、卡片排序和批量校验复用同一路径。
const ASSISTANT_PREVIEW_FILE_TYPES: readonly AssistantPreviewFileTypeDefinition[] = [
  { extensions: [".md"], kind: "markdown", subtitleId: "chat.previewCards.markdown" },
  {
    extensions: [".html", ".htm"],
    kind: "html",
    subtitleId: "chat.previewCards.htmlWebsite",
  },
  { extensions: [".docx"], kind: "docx", subtitleId: "chat.previewCards.docx" },
  { extensions: [".xlsx"], kind: "xlsx", subtitleId: "chat.previewCards.xlsx" },
  { extensions: [".pptx"], kind: "pptx", subtitleId: "chat.previewCards.pptx" },
  { extensions: [".pdf"], kind: "pdf", subtitleId: "chat.previewCards.pdf" },
  ...MEDIA_PREVIEW_FORMATS.map(
    ({ extension, kind }): AssistantPreviewFileTypeDefinition => ({
      extensions: [extension],
      kind,
      subtitleId: kind === "video" ? "chat.previewCards.video" : "chat.previewCards.audio",
    }),
  ),
];

const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*“”‘’，。！？；：、]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const DELIMITED_FILE_PATH_RE =
  /([`"'“”‘’])([^`"'“”‘’\r\n]+?\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)([`"'“”‘’])/giu;
const FILE_PATH_RE =
  /(?:^|[\s("'`“”‘’,.;:!?，。！？；：、])((?:(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|[\p{L}\p{N}\p{M}\p{S}_.@()-]+[\\/])[\p{L}\p{N}\p{M}\p{S}_.@() -]+?(?:[\\/][\p{L}\p{N}\p{M}\p{S}_.@() -]+?)*|[\p{L}\p{N}\p{M}\p{S}_.@()-]+)\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)(?=$|[\s)"'`“”‘’,.;:!?，。！？；：、])/giu;

export function cleanAssistantFilePathCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

export function getAssistantPreviewFileTypeDefinition(
  path: string,
): AssistantPreviewFileTypeDefinition | null {
  const normalizedPath = cleanAssistantFilePathCandidate(path).toLowerCase();
  return (
    ASSISTANT_PREVIEW_FILE_TYPES.find((definition) =>
      definition.extensions.some((extension) => normalizedPath.endsWith(extension)),
    ) ?? null
  );
}

export function isAssistantPreviewHtmlPath(path: string): boolean {
  return getAssistantPreviewFileTypeDefinition(path)?.kind === "html";
}

export function parseAssistantFileUrlPath(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "file:") return null;

    const decodedPathname = decodeFilePathUriEscapes(parsedUrl.pathname);
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) return decodedPathname.slice(1);
    if (parsedUrl.hostname && parsedUrl.hostname !== "localhost") {
      return `//${parsedUrl.hostname}${decodedPathname}`;
    }
    return decodedPathname;
  } catch {
    return null;
  }
}

export function resolveAssistantRawFilePath(
  workspacePath: string,
  rawPath: string,
  options: AssistantFilePathResolveOptions = {},
): string | null {
  if (/^file:\/\//i.test(rawPath)) return parseAssistantFileUrlPath(rawPath);

  const cleanedPath = cleanAssistantFilePathCandidate(rawPath);
  if (!cleanedPath || cleanedPath.startsWith("http://") || cleanedPath.startsWith("https://")) {
    return null;
  }
  // `~` 是 Home-relative 语义；Host Home 尚未注入或使用了 `~other` 时必须失败关闭，
  // 不能继续走 `./${cleanedPath}` 的 workspace-relative 兜底分支。
  if (/^~(?:[\\/]|[^\\/]+[\\/])/.test(cleanedPath)) {
    return resolveMarkdownFileLink(workspacePath, cleanedPath, options)?.path ?? null;
  }

  const parsedLink = resolveMarkdownFileLink(workspacePath, rawPath, options);
  if (parsedLink) return parsedLink.path;

  if (!cleanedPath.includes("/") && !cleanedPath.includes("\\")) {
    return joinFilePath(workspacePath, cleanedPath);
  }
  return resolveMarkdownFileLink(workspacePath, `./${cleanedPath}`, options)?.path ?? null;
}

function normalizeMarkdownHref(href: string): string {
  return stripBalancedAssistantPathQuotes(href.trim().replace(/^<|>$/g, ""));
}

function overlapsRanges(start: number, end: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function extractAssistantFileReferences(
  content: string,
  workspacePath: string,
  options: AssistantFilePathResolveOptions = {},
): AssistantFileReference[] {
  if (!content.trim()) return [];

  const references: AssistantFileReference[] = [];
  const protectedRanges: Array<[number, number]> = [];

  for (const citation of extractZCodeFileCitationDirectives(content)) {
    // Citation 必须占用完整保护区间，否则内部 path 会再次被普通文件正则抽取，
    // 从而绕过 citation 只允许 Office/PDF 卡片的产品边界。
    protectedRanges.push([citation.start, citation.end]);
    if (!citation.path) continue;
    const path = resolveAssistantRawFilePath(workspacePath, citation.path, options);
    const kind = path
      ? resolveZCodeFileCitationPreviewKind({
          artifactKind: citation.artifactKind,
          path,
        })
      : null;
    if (path && kind) {
      references.push({
        start: citation.start,
        end: citation.end,
        kind,
        path,
        raw: citation.path,
      });
    }
  }

  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const href = match[2] ? normalizeMarkdownHref(match[2]) : "";
    const path = resolveAssistantRawFilePath(workspacePath, href, options);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (overlapsRanges(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    if (path && definition) {
      references.push({ start, end, kind: definition.kind, path, raw: href });
    }
  }

  for (const match of content.matchAll(FILE_URL_RE)) {
    const raw = (match[0] ?? "").replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, "");
    const path = parseAssistantFileUrlPath(raw);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (overlapsRanges(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    if (path && definition) {
      references.push({ start, end, kind: definition.kind, path, raw });
    }
  }

  for (const match of content.matchAll(DELIMITED_FILE_PATH_RE)) {
    const candidate = match[2] ?? "";
    const raw = candidate.trim();
    const fullMatch = match[0] ?? raw;
    const fullStart = match.index ?? 0;
    const fullEnd = fullStart + fullMatch.length;
    if (!raw || overlapsRanges(fullStart, fullEnd, protectedRanges)) continue;
    if (!isBalancedAssistantPathQuotePair(match[1] ?? "", match[3] ?? "")) {
      // 错配引号不能让内部路径再被通用正则捞出，否则 malformed 输出仍会生成卡片。
      protectedRanges.push([fullStart, fullEnd]);
      continue;
    }

    if (/^~[^\\/]+[\\/]/.test(raw) || (/^~[\\/]/.test(raw) && !options.homePath)) {
      protectedRanges.push([fullStart, fullEnd]);
      continue;
    }

    const path = resolveAssistantRawFilePath(workspacePath, raw, options);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    if (path && definition) {
      const start = fullStart + fullMatch.indexOf(raw);
      const end = start + raw.length;
      protectedRanges.push([fullStart, fullEnd]);
      references.push({ start, end, kind: definition.kind, path, raw });
    }
  }

  for (const match of content.matchAll(FILE_PATH_RE)) {
    const raw = match[1] ?? "";
    const fullMatch = match[0] ?? raw;
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw);
    const end = start + raw.length;
    if (overlapsRanges(start, end, protectedRanges)) continue;

    // 普通正文里的 `~/...` 是给用户看的 shell 路径，不是稳定的预览卡片引用。
    // 明确的 zcode-file-citation 仍在上面的专用分支处理。
    if (/^~[\\/]/.test(raw)) {
      protectedRanges.push([start, end]);
      continue;
    }

    const precedingCharacter = content[start - 1];
    const followingCharacter = content[end];
    const hasQuoteBoundary =
      isAssistantPathQuoteCharacter(precedingCharacter) ||
      isAssistantPathQuoteCharacter(followingCharacter);
    if (
      hasQuoteBoundary &&
      !isBalancedAssistantPathQuotePair(precedingCharacter ?? "", followingCharacter ?? "")
    ) {
      // 单侧或错配引号不能让内部路径绕过定界符保护而生成卡片。
      protectedRanges.push([start, end]);
      continue;
    }

    const path = resolveAssistantRawFilePath(workspacePath, raw, options);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    if (path && definition) {
      references.push({ start, end, kind: definition.kind, path, raw });
    }
  }

  const genericReferences = extractConversationPreviewFileReferences(content, workspacePath);
  for (const reference of genericReferences) {
    if (overlapsRanges(reference.start, reference.end, protectedRanges)) continue;
    if (references.some((candidate) => candidate.path === reference.path)) continue;
    references.push(reference);
  }

  return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function hasAssistantPreviewFileChangeCandidates(
  content: string,
  workspacePath: string,
  options: AssistantFilePathResolveOptions = {},
): boolean {
  return extractAssistantFileReferences(content, workspacePath, options).some(
    (reference) => reference.kind === "markdown" || reference.kind === "html",
  );
}
