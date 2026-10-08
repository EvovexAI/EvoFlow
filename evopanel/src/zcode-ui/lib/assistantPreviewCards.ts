import {
  buildConversationPreviewArtifactCandidatesFromReferences,
  CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
} from "@zcode/shared";
import {
  cleanAssistantFilePathCandidate,
  getAssistantPreviewFileTypeDefinition,
  isAssistantPreviewHtmlPath,
  parseAssistantFileUrlPath,
  resolveAssistantRawFilePath,
  type AssistantFileReference,
  type AssistantFilePathResolveOptions,
  type AssistantPreviewFileKind,
  type AssistantPreviewFileSubtitleId,
} from "@/lib/assistantFileReferences.js";
import { decodeFilePathUriEscapes, getPathLeaf, toFileUrl } from "@/lib/path.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

export {
  extractAssistantFileReferences,
  hasAssistantPreviewFileChangeCandidates,
  isAssistantPreviewHtmlPath,
} from "@/lib/assistantFileReferences.js";
export type {
  AssistantFileReference,
  AssistantPreviewFileKind,
} from "@/lib/assistantFileReferences.js";

export const ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT = CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT;
export const ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT = CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT;

export interface AssistantPreviewCardsAutoOpenRequest {
  key: string;
  sources: CodeViewerSource[];
}

export type AssistantPreviewCard =
  | {
      id: string;
      type: "website";
      title: string;
      subtitleId: "chat.previewCards.website" | "chat.previewCards.htmlWebsite";
      url: string;
      filePath?: string;
    }
  | {
      id: string;
      type: "markdown";
      kind: "markdown";
      title: string;
      subtitleId: "chat.previewCards.markdown";
      path: string;
    }
  | {
      id: string;
      type: "file";
      kind: Exclude<AssistantPreviewFileKind, "markdown" | "html">;
      title: string;
      subtitleId: Exclude<
        AssistantPreviewFileSubtitleId,
        "chat.previewCards.markdown" | "chat.previewCards.htmlWebsite"
      >;
      path: string;
    };

export interface AssistantPreviewCardFileStatService {
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
}

const LOCALHOST_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#][^\s<>()\]`"'*，。！？；：、]*)?/gi;
const STRICT_LOCALHOST_URL_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#][^\s<>()\]`"'*，。！？；：、]*)?$/i;
const STRICT_FILE_HTML_URL_RE =
  /^file:\/\/(?:localhost\/|\/|[^/\s<>()\]`"'*，。！？；：、]+\/)[^\s<>()\]`"'*，。！？；：、]+\.html?(?:[?#][^\s<>()\]`"'*，。！？；：、]*)?$/i;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;

interface AssistantPreviewCardOptions {
  changedFilePaths?: readonly string[];
  homePath?: string;
  suppressWebRemoteCards?: boolean;
}

interface PositionedCard {
  card: AssistantPreviewCard;
  position: number;
}

function normalizeTrailingUrlText(url: string): string {
  return url.trim().replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, "");
}

export function isValidAssistantPreviewWebsiteUrl(url: string): boolean {
  const trimmedUrl = normalizeTrailingUrlText(url.trim());
  if (!trimmedUrl) return false;

  const isLocalHttpUrl = STRICT_LOCALHOST_URL_RE.test(trimmedUrl);
  const isFileHtmlUrl = STRICT_FILE_HTML_URL_RE.test(trimmedUrl);
  if (!isLocalHttpUrl && !isFileHtmlUrl) return false;

  try {
    const parsedUrl = new URL(trimmedUrl);
    if (parsedUrl.protocol === "file:") return isFileHtmlUrl;

    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : null;
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      parsedUrl.username.length === 0 &&
      parsedUrl.password.length === 0 &&
      (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1") &&
      (port === null || (port > 0 && port <= 65_535))
    );
  } catch {
    return false;
  }
}

function normalizeMarkdownHref(href: string): string {
  return href.trim().replace(/^<|>$/g, "");
}

function cleanMarkdownLinkTitle(title: string): string | null {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  if (
    !normalizedTitle ||
    normalizedTitle.length > 80 ||
    /^https?:\/\//i.test(normalizedTitle) ||
    /[*_`[\]<>]/.test(normalizedTitle) ||
    /^[)"'`,.;:!?，。！？；：、）】》]+/.test(normalizedTitle) ||
    !/[a-zA-Z0-9\u4e00-\u9fff]/.test(normalizedTitle)
  ) {
    return null;
  }
  return normalizedTitle;
}

export function shouldOpenAssistantHtmlInBrowser(params: {
  path: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): boolean {
  return (
    isAssistantPreviewHtmlPath(params.path) &&
    !params.workspaceIdentity?.trim() &&
    !params.workspaceRemoteSessionId
  );
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function resolveChangedFilePath(workspacePath: string, path: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) {
    return cleanAssistantFilePathCandidate(path);
  }
  return resolveAssistantRawFilePath(workspacePath, path) ?? path;
}

function findMatchingChangedFilePath(
  reference: AssistantFileReference,
  changedFilePaths: readonly string[],
  workspacePath: string,
): string | null {
  const normalizedReferencePath = normalizePathForCompare(reference.path);
  const normalizedChangedPaths = changedFilePaths.map((path) => {
    const resolvedPath = resolveChangedFilePath(workspacePath, path);
    return { path: resolvedPath, normalized: normalizePathForCompare(resolvedPath) };
  });
  const exact = normalizedChangedPaths.find(
    (candidate) => candidate.normalized === normalizedReferencePath,
  );
  if (exact) return exact.path;

  const cleanedRaw = cleanAssistantFilePathCandidate(reference.raw);
  if (cleanedRaw.includes("/") || cleanedRaw.includes("\\") || /^file:/i.test(cleanedRaw)) {
    return null;
  }
  const leafMatches = normalizedChangedPaths.filter(
    (candidate) => getPathLeaf(candidate.normalized) === cleanedRaw,
  );
  return leafMatches.length === 1 ? leafMatches[0]!.path : null;
}

function getWebsiteTitleFromMarkdownLink(content: string, url: string): string | null {
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const label = match[1] ? cleanMarkdownLinkTitle(match[1]) : null;
    const href = match[2] ? normalizeTrailingUrlText(normalizeMarkdownHref(match[2])) : "";
    if (label && href === url && !/^https?:\/\//i.test(label)) return label;
  }
  return null;
}

function getWebsiteFallbackTitle(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const pathLeaf = getPathLeaf(decodeURI(parsedUrl.pathname));
    return pathLeaf && pathLeaf !== "/" ? pathLeaf : parsedUrl.host;
  } catch {
    return url;
  }
}

function resolveLocalhostHtmlChangedPath(
  url: string,
  workspacePath: string,
  changedFilePaths: readonly string[],
  options: AssistantFilePathResolveOptions = {},
): string | null {
  try {
    const parsedUrl = new URL(url);
    const pathname = decodeFilePathUriEscapes(parsedUrl.pathname).replace(/^\/+/, "");
    if (!isAssistantPreviewHtmlPath(pathname)) return null;
    const path = resolveAssistantRawFilePath(workspacePath, pathname, options);
    if (!path) return null;
    return findMatchingChangedFilePath(
      { start: 0, end: 0, kind: "html", path, raw: pathname },
      changedFilePaths,
      workspacePath,
    );
  } catch {
    return null;
  }
}

function buildFileCard(reference: AssistantFileReference): AssistantPreviewCard {
  const definition = getAssistantPreviewFileTypeDefinition(reference.path)!;
  if (reference.kind === "markdown") {
    return {
      id: `markdown:${reference.path}`,
      type: "markdown",
      kind: "markdown",
      title: getPathLeaf(reference.path),
      subtitleId: "chat.previewCards.markdown",
      path: reference.path,
    };
  }
  if (reference.kind === "html") {
    return {
      id: `website:${toFileUrl(reference.path)}`,
      type: "website",
      title: getPathLeaf(reference.path),
      subtitleId: "chat.previewCards.htmlWebsite",
      url: toFileUrl(reference.path),
      filePath: reference.path,
    };
  }
  return {
    id: `file:${reference.kind}:${reference.path}`,
    type: "file",
    kind: reference.kind,
    title: getPathLeaf(reference.path),
    subtitleId: definition.subtitleId as Extract<
      AssistantPreviewCard,
      { type: "file" }
    >["subtitleId"],
    path: reference.path,
  };
}

function getCardSeenKey(card: AssistantPreviewCard): string {
  const filePath = getAssistantPreviewCardFilePath(card);
  if (filePath) return `file:${normalizePathForCompare(filePath)}`;
  try {
    const parsedUrl = new URL(card.type === "website" ? card.url : "");
    return parsedUrl.pathname === "/" && !parsedUrl.search && !parsedUrl.hash
      ? `url:${parsedUrl.origin}`
      : `url:${parsedUrl.href}`;
  } catch {
    return card.id;
  }
}

export function buildAssistantPreviewCardsFromReferences(
  content: string,
  workspacePath: string,
  references: readonly AssistantFileReference[],
  options: AssistantPreviewCardOptions = {},
): AssistantPreviewCard[] {
  if (!content.trim()) return [];

  const changedFilePaths = options.changedFilePaths ?? [];
  const positionedCards: PositionedCard[] = [];
  let hasLocalHttpPreview = false;

  for (const match of content.matchAll(LOCALHOST_URL_RE)) {
    const url = normalizeTrailingUrlText(match[0] ?? "");
    if (!isValidAssistantPreviewWebsiteUrl(url)) continue;
    // Web 远控没有本地端口转发或 HTML 运行环境；在候选上限前过滤，避免隐藏卡片占位。
    if (options.suppressWebRemoteCards) continue;
    const filePath = resolveLocalhostHtmlChangedPath(url, workspacePath, changedFilePaths, {
      homePath: options.homePath,
    });
    hasLocalHttpPreview = true;
    positionedCards.push({
      position: match.index ?? 0,
      card: {
        id: `website:${url}`,
        type: "website",
        title:
          filePath !== null
            ? getPathLeaf(filePath)
            : (getWebsiteTitleFromMarkdownLink(content, url) ?? getWebsiteFallbackTitle(url)),
        subtitleId: "chat.previewCards.website",
        url,
        ...(filePath ? { filePath } : {}),
      },
    });
  }

  const fileReferences: AssistantFileReference[] = [];
  for (const reference of references) {
    if (options.suppressWebRemoteCards && reference.kind === "html") continue;
    if (reference.kind === "html" && hasLocalHttpPreview) continue;

    let resolvedReference = reference;
    if (reference.kind === "markdown" || reference.kind === "html") {
      const changedPath = findMatchingChangedFilePath(reference, changedFilePaths, workspacePath);
      if (!changedPath) continue;
      resolvedReference = { ...reference, path: changedPath };
    }
    fileReferences.push(resolvedReference);
  }

  const previewCandidates = buildConversationPreviewArtifactCandidatesFromReferences({
    references: fileReferences,
    productTurnId: "",
    workspacePath,
    fileChanges: changedFilePaths.map((path) => ({ path, state: "active" as const })),
    // Renderer 仍需展示已解析的 Home-relative/file URL 卡片；Share Service 会在自己的
    // Host source 上再次执行 workspace 边界校验。
    enforceWorkspaceBoundary: false,
  });
  const referencesByPath = new Map(
    fileReferences.map((reference) => [normalizePathForCompare(reference.path), reference]),
  );
  for (const candidate of previewCandidates) {
    const reference = referencesByPath.get(normalizePathForCompare(candidate.sourceRef));
    if (!reference) continue;
    positionedCards.push({
      position: reference.start,
      card: buildFileCard({ ...reference, path: candidate.sourceRef }),
    });
  }

  positionedCards.sort((left, right) => right.position - left.position);
  const seen = new Set<string>();
  const cards: AssistantPreviewCard[] = [];
  for (const candidate of positionedCards) {
    const key = getCardSeenKey(candidate.card);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(candidate.card);
    if (cards.length === ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT) break;
  }
  return cards;
}

export function getAssistantPreviewCardFilePath(card: AssistantPreviewCard): string | null {
  return card.type === "website"
    ? (card.filePath ?? parseAssistantFileUrlPath(card.url))
    : card.path;
}

export function requiresAssistantPreviewCardFileStat(card: AssistantPreviewCard): boolean {
  return getAssistantPreviewCardFilePath(card) !== null;
}
