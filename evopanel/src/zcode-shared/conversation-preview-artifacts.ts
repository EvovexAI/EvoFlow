import {
  conversationArtifactTypeSchema,
  type ConversationArtifactType,
} from "./zcode-protocol-v4/rows.js";
import { MEDIA_PREVIEW_FORMATS } from "./media-preview.js";

export type ConversationPreviewFileKind =
  | "markdown"
  | "html"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "video"
  | "audio";

export type ConversationPreviewArtifactType = ConversationArtifactType | "video" | "audio";

export interface ConversationPreviewFileReference {
  end: number;
  kind: ConversationPreviewFileKind;
  path: string;
  raw: string;
  start: number;
}

export interface ConversationPreviewFileChange {
  path: string;
  state?: "active" | "reverted";
}

export interface ConversationPreviewArtifactCandidate {
  artifactType: ConversationPreviewArtifactType;
  displayName: string;
  mimeType: string;
  previewKind: ConversationPreviewFileKind;
  productTurnId: string;
  sourceKind: "user_input_attachment" | "assistant_preview_card";
  sourceRef: string;
  requiresFileChanges: boolean;
}

interface PreviewFileTypeDefinition {
  extensions: readonly string[];
  kind: ConversationPreviewFileKind;
  mimeType: string;
  artifactType: ConversationPreviewArtifactType;
}

const PREVIEW_FILE_TYPES: readonly PreviewFileTypeDefinition[] = [
  {
    extensions: [".md"],
    kind: "markdown",
    mimeType: "text/markdown",
    artifactType: "md",
  },
  {
    extensions: [".html", ".htm"],
    kind: "html",
    mimeType: "text/html",
    artifactType: "html",
  },
  {
    extensions: [".docx"],
    kind: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    artifactType: "docx",
  },
  {
    extensions: [".xlsx"],
    kind: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactType: "xlsx",
  },
  {
    extensions: [".pptx"],
    kind: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    artifactType: "pptx",
  },
  {
    extensions: [".pdf"],
    kind: "pdf",
    mimeType: "application/pdf",
    artifactType: "pdf",
  },
  ...MEDIA_PREVIEW_FORMATS.map(
    ({ extension, kind, mediaType }): PreviewFileTypeDefinition => ({
      extensions: [extension],
      kind,
      mimeType: mediaType,
      artifactType: kind,
    }),
  ),
];

export const CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT = 15;
export const CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT = 10;

const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*，。！？；：、]+/giu;
const FILE_CITATION_RE = /:{1,2}zcode-file-citation\{([^}]*)\}/giu;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const DELIMITED_FILE_PATH_RE =
  /([`"'])([^`"'\r\n]+?\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)\1/giu;
const FILE_PATH_RE =
  /(?:^|[\s("'`,.;:!?，。！？；：、])((?:(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|[\p{L}\p{N}\p{M}\p{S}_.@()-]+[\\/])[\p{L}\p{N}\p{M}\p{S}_.@() -]+?(?:[\\/][\p{L}\p{N}\p{M}\p{S}_.@() -]+?)*|[\p{L}\p{N}\p{M}\p{S}_.@()-]+)\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)(?=$|[\s)"'`,.;:!?，。！？；：、])/giu;

function normalizeSlashes(path: string): string {
  return path.replace(/\\/gu, "/");
}

function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/gu, "")
    .replace(/:\d+(?::\d+)?$/u, "");
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function parseFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const pathname = decodePath(url.pathname);
    if (/^\/[a-zA-Z]:\//u.test(pathname)) return pathname.slice(1);
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${pathname}`;
    return pathname;
  } catch {
    return null;
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

function normalizeRelativePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of normalizeSlashes(path).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/{2,}/gu, "/");
  const prefix = normalized.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join("/")}`;
}

export function resolveConversationPreviewPath(
  workspacePath: string,
  rawPath: string,
): string | null {
  const cleaned = cleanPath(rawPath);
  if (!cleaned) return null;
  // Shell 展示用的 Home-relative 路径不是稳定的预览卡片引用；只有明确 citation 或
  // Markdown/file URL 才能成为候选，避免把正文里的 `~/...` 当成 workspace 文件分享。
  if (/^~[\\/]/u.test(cleaned)) return null;
  const filePath = /^file:\/\//iu.test(cleaned) ? parseFileUrlPath(cleaned) : cleaned;
  if (!filePath) return null;
  if (isAbsolutePath(filePath)) return normalizeAbsolutePath(filePath);
  const relative = normalizeRelativePath(filePath);
  if (relative === null) return null;
  const workspace = normalizeAbsolutePath(workspacePath).replace(/\/$/u, "");
  return `${workspace}/${relative}`;
}

export function getConversationPreviewFileType(path: string): PreviewFileTypeDefinition | null {
  const normalized = cleanPath(path).toLowerCase();
  return (
    PREVIEW_FILE_TYPES.find((definition) =>
      definition.extensions.some((extension) => normalized.endsWith(extension)),
    ) ?? null
  );
}

function getPathLeaf(path: string): string {
  const segments = normalizeSlashes(path).replace(/\/+$/u, "").split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function isInsideWorkspace(path: string, workspacePath: string): boolean {
  const normalizedPath = normalizeAbsolutePath(path).replace(/\/$/u, "");
  const normalizedWorkspace = normalizeAbsolutePath(workspacePath).replace(/\/$/u, "");
  return (
    normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

function rangesOverlap(start: number, end: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function readDirectiveParameter(parameters: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(parameters);
  return match?.[1]?.trim() || undefined;
}

export function extractConversationPreviewFileReferences(
  content: string,
  workspacePath: string,
): ConversationPreviewFileReference[] {
  if (!content.trim()) return [];
  const references: ConversationPreviewFileReference[] = [];
  const protectedRanges: Array<[number, number]> = [];
  const addReference = (raw: string, start: number, end: number) => {
    const path = resolveConversationPreviewPath(workspacePath, raw);
    const definition = path ? getConversationPreviewFileType(path) : null;
    if (!path || !definition) return;
    references.push({ start, end, kind: definition.kind, path, raw });
  };

  for (const match of content.matchAll(FILE_CITATION_RE)) {
    const rawDirective = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + rawDirective.length;
    protectedRanges.push([start, end]);
    const rawPath = readDirectiveParameter(match[1] ?? "", "path");
    if (!rawPath) continue;
    const artifactKind = readDirectiveParameter(match[1] ?? "", "artifact_kind")?.toLowerCase();
    const path = resolveConversationPreviewPath(workspacePath, rawPath);
    const definition = path ? getConversationPreviewFileType(path) : null;
    const citationKind =
      definition?.kind === "docx" ||
      definition?.kind === "xlsx" ||
      definition?.kind === "pptx" ||
      definition?.kind === "pdf" ||
      definition?.kind === "video" ||
      definition?.kind === "audio"
        ? definition.kind
        : null;
    const expectedKind =
      artifactKind === "document"
        ? "docx"
        : artifactKind === "presentation"
          ? "pptx"
          : artifactKind === "workbook"
            ? "xlsx"
            : undefined;
    if (path && citationKind && (expectedKind === undefined || expectedKind === citationKind)) {
      references.push({ start, end, kind: citationKind, path, raw: rawPath });
    }
  }

  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const href = (match[2] ?? "").trim().replace(/^<|>$/gu, "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (rangesOverlap(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    addReference(href, start, end);
  }
  for (const match of content.matchAll(FILE_URL_RE)) {
    const raw = cleanPath(match[0] ?? "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (rangesOverlap(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    addReference(raw, start, end);
  }
  for (const match of content.matchAll(DELIMITED_FILE_PATH_RE)) {
    const raw = (match[2] ?? "").trim();
    const fullStart = match.index ?? 0;
    const fullEnd = fullStart + (match[0]?.length ?? raw.length);
    if (!raw || rangesOverlap(fullStart, fullEnd, protectedRanges)) continue;
    protectedRanges.push([fullStart, fullEnd]);
    addReference(
      raw,
      fullStart + (match[0]?.indexOf(raw) ?? 0),
      fullStart + (match[0]?.indexOf(raw) ?? 0) + raw.length,
    );
  }
  for (const match of content.matchAll(FILE_PATH_RE)) {
    const raw = match[1] ?? "";
    const fullMatch = match[0] ?? raw;
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw);
    const end = start + raw.length;
    if (!raw || rangesOverlap(start, end, protectedRanges)) continue;
    addReference(raw, start, end);
  }

  const seen = new Set<string>();
  const deduplicatedFromLatest = references
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .filter((reference) => {
      const key = normalizeAbsolutePath(reference.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduplicatedFromLatest.reverse();
}

export function buildConversationPreviewArtifactCandidatesFromReferences(input: {
  references: readonly ConversationPreviewFileReference[];
  productTurnId: string;
  workspacePath: string;
  fileChanges?: readonly ConversationPreviewFileChange[];
  enforceWorkspaceBoundary?: boolean;
}): ConversationPreviewArtifactCandidate[] {
  const changes = input.fileChanges ?? [];
  const activePaths = new Set(
    changes
      .filter((change) => change.state !== "reverted")
      .map((change) =>
        normalizeAbsolutePath(
          resolveConversationPreviewPath(input.workspacePath, change.path) ?? change.path,
        ),
      ),
  );
  const revertedPaths = new Set(
    changes
      .filter((change) => change.state === "reverted")
      .map((change) =>
        normalizeAbsolutePath(
          resolveConversationPreviewPath(input.workspacePath, change.path) ?? change.path,
        ),
      ),
  );

  const seen = new Set<string>();
  return [...input.references]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .map((reference): ConversationPreviewArtifactCandidate | null => {
      const definition = getConversationPreviewFileType(reference.path);
      if (!definition) return null;
      const normalizedPath = normalizeAbsolutePath(reference.path);
      if (
        input.enforceWorkspaceBoundary !== false &&
        !isInsideWorkspace(normalizedPath, input.workspacePath)
      ) {
        return null;
      }
      const requiresFileChanges = reference.kind === "markdown" || reference.kind === "html";
      if (
        requiresFileChanges &&
        (!activePaths.has(normalizedPath) || revertedPaths.has(normalizedPath))
      ) {
        return null;
      }
      if (seen.has(normalizedPath)) return null;
      seen.add(normalizedPath);
      return {
        artifactType: definition.artifactType,
        displayName: getPathLeaf(reference.path),
        mimeType: definition.mimeType,
        previewKind: definition.kind,
        productTurnId: input.productTurnId,
        sourceKind: "assistant_preview_card" as const,
        sourceRef: reference.path,
        requiresFileChanges,
      };
    })
    .filter((candidate): candidate is ConversationPreviewArtifactCandidate => candidate !== null)
    .slice(0, CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT);
}

export function buildConversationPreviewArtifactCandidates(input: {
  assistantText: string;
  productTurnId: string;
  workspacePath: string;
  fileChanges?: readonly ConversationPreviewFileChange[];
}): ConversationPreviewArtifactCandidate[] {
  return buildConversationPreviewArtifactCandidatesFromReferences({
    ...input,
    references: extractConversationPreviewFileReferences(input.assistantText, input.workspacePath),
  });
}

export { conversationArtifactTypeSchema };
