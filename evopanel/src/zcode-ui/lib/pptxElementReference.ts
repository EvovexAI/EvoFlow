import type { PresentationPageElement } from "@/presentation/types.js";

export const PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT = "zcode:pptx-element-reference-add-to-chat";
const PPTX_ELEMENT_COMMENT_BLOCK_TITLE = "# Presentation element comments:";
const PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE =
  "Each item below is an independent comment on one presentation element. Treat every non-empty `comment` as the user's instruction for that element, process all of them, and never apply one item's comment to another reference.";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// 标题与 JSON 围栏之间若用通配匹配 directive，正文里出现的同名标题也会命中，
// 并把它之后的用户正文整段吞进尾块。这里改成按 directive 常量精确匹配。
const PPTX_ELEMENT_COMMENT_BLOCK_PATTERN = new RegExp(
  `(?:^|\\n\\n)${escapeRegExp(PPTX_ELEMENT_COMMENT_BLOCK_TITLE)}\\s*\\n\\n${escapeRegExp(
    PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE,
  )}\\s*\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`\\s*$`,
  "u",
);
const PPTX_ELEMENT_LEGACY_BLOCK_PATTERN =
  /(?:^|\n\n)# Presentation elements:\s*\n\n```json\n([\s\S]*?)\n```\s*$/u;

export interface PptxElementReference extends PresentationPageElement {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sourcePath: string;
  sourceTitle: string;
  sourceFingerprint: string;
  selectedText?: string;
  comment?: string;
  textFingerprint?: string;
  capturedAt: number;
}

export interface PptxElementReferenceSource {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sourcePath: string;
  sourceTitle: string;
}

interface ParsedPptxElementReferencePrompt {
  visibleContent: string;
  pptxElementReferences: PptxElementReference[];
}

type PptxElementReferenceAddToChatEvent = CustomEvent<PptxElementReference>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function getPptxElementReferenceWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return workspaceIdentity?.trim() || workspacePath;
}

export function isPptxElementReferenceInWorkspaceScope(
  reference: Pick<PptxElementReference, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
) {
  return (
    getPptxElementReferenceWorkspaceKey(reference.workspacePath, reference.workspaceIdentity) ===
      getPptxElementReferenceWorkspaceKey(scope.workspacePath, scope.workspaceIdentity) &&
    (reference.remoteSessionId ?? "") === (scope.remoteSessionId ?? "")
  );
}

function isPptxElementReferencePayload(payload: unknown): payload is PptxElementReference {
  if (!isRecord(payload) || !isRecord(payload.bounds)) {
    return false;
  }
  const nodeTypes = new Set(["shape", "picture", "chart", "table", "table-cell"]);
  const hasCellCoordinates =
    Number.isInteger(payload.rowIndex) &&
    (payload.rowIndex as number) >= 0 &&
    Number.isInteger(payload.cellIndex) &&
    (payload.cellIndex as number) >= 0;
  return (
    typeof payload.id === "string" &&
    payload.id.length > 0 &&
    typeof payload.workspacePath === "string" &&
    payload.workspacePath.length > 0 &&
    isOptionalString(payload.workspaceIdentity) &&
    isOptionalString(payload.remoteSessionId) &&
    typeof payload.sourcePath === "string" &&
    payload.sourcePath.length > 0 &&
    typeof payload.sourceTitle === "string" &&
    typeof payload.sourceFingerprint === "string" &&
    SHA256_PATTERN.test(payload.sourceFingerprint) &&
    (payload.textFingerprint === undefined ||
      (typeof payload.textFingerprint === "string" &&
        SHA256_PATTERN.test(payload.textFingerprint))) &&
    Number.isInteger(payload.slideIndex) &&
    (payload.slideIndex as number) >= 0 &&
    typeof payload.slidePart === "string" &&
    /^ppt\/slides\/slide[^/]+\.xml$/u.test(payload.slidePart) &&
    typeof payload.nodeId === "string" &&
    payload.nodeId.length > 0 &&
    isOptionalString(payload.nodePath) &&
    typeof payload.nodeName === "string" &&
    typeof payload.nodeType === "string" &&
    nodeTypes.has(payload.nodeType) &&
    isOptionalString(payload.text) &&
    isOptionalString(payload.selectedText) &&
    isOptionalString(payload.comment) &&
    isFiniteNumber(payload.bounds.x) &&
    isFiniteNumber(payload.bounds.y) &&
    isFiniteNumber(payload.bounds.width) &&
    payload.bounds.width >= 0 &&
    isFiniteNumber(payload.bounds.height) &&
    payload.bounds.height >= 0 &&
    Number.isInteger(payload.zIndex) &&
    isFiniteNumber(payload.capturedAt) &&
    (payload.nodeType === "table-cell" ? hasCellCoordinates : true)
  );
}

function createPptxElementReferenceId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pptx-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sha256Fingerprint(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export async function createPptxElementReference(options: {
  element: PresentationPageElement;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sourcePath: string;
  sourceTitle: string;
  sourceFingerprint: string;
  selectedText?: string;
  comment?: string;
}): Promise<PptxElementReference> {
  const selectedText = options.selectedText?.trim();
  const comment = options.comment?.trim();
  return {
    ...options.element,
    id: createPptxElementReferenceId(),
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    sourcePath: options.sourcePath,
    sourceTitle: options.sourceTitle,
    sourceFingerprint: options.sourceFingerprint,
    ...(selectedText ? { selectedText } : {}),
    ...(comment ? { comment } : {}),
    ...(options.element.text
      ? {
          textFingerprint: await sha256Fingerprint(options.element.text.trim()),
        }
      : {}),
    capturedAt: Date.now(),
  };
}

function getReferenceDedupeKey(reference: PptxElementReference) {
  return [
    reference.sourcePath,
    reference.sourceFingerprint,
    reference.slidePart,
    reference.nodeId,
    reference.nodeType === "table-cell" ? reference.rowIndex : "",
    reference.nodeType === "table-cell" ? reference.cellIndex : "",
  ].join("\0");
}

export function addPptxElementReference(
  references: readonly PptxElementReference[],
  reference: PptxElementReference,
): readonly PptxElementReference[] {
  const key = getReferenceDedupeKey(reference);
  const existingIndex = references.findIndex((item) => getReferenceDedupeKey(item) === key);
  if (existingIndex < 0) {
    return [...references, reference];
  }
  return references.map((item, index) => (index === existingIndex ? reference : item));
}

export function buildPromptWithPptxElementReferences(
  text: string,
  references: readonly PptxElementReference[],
) {
  const content = text.trimEnd();
  if (references.length === 0) {
    return content.trim();
  }
  const block = `${PPTX_ELEMENT_COMMENT_BLOCK_TITLE}\n\n${PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE}\n\n\`\`\`json\n${JSON.stringify(
    references,
    null,
    2,
  )}\n\`\`\``;
  return `${content}${content ? "\n\n" : ""}${block}`.trim();
}

export function parsePromptPptxElementReferences(
  content: string,
): ParsedPptxElementReferencePrompt {
  const blockMatch =
    PPTX_ELEMENT_COMMENT_BLOCK_PATTERN.exec(content) ??
    PPTX_ELEMENT_LEGACY_BLOCK_PATTERN.exec(content);
  if (!blockMatch || blockMatch.index < 0 || blockMatch[1] === undefined) {
    return { visibleContent: content, pptxElementReferences: [] };
  }
  try {
    const parsed: unknown = JSON.parse(blockMatch[1]);
    if (!Array.isArray(parsed)) {
      return { visibleContent: content, pptxElementReferences: [] };
    }
    const references = parsed.filter(isPptxElementReferencePayload);
    if (references.length !== parsed.length || references.length === 0) {
      return { visibleContent: content, pptxElementReferences: [] };
    }
    return {
      visibleContent: content.slice(0, blockMatch.index).trimEnd(),
      pptxElementReferences: references,
    };
  } catch {
    return { visibleContent: content, pptxElementReferences: [] };
  }
}

export function isPptxElementReferenceAddToChatEvent(
  event: Event,
): event is PptxElementReferenceAddToChatEvent {
  return (
    event.type === PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT &&
    "detail" in event &&
    isPptxElementReferencePayload((event as CustomEvent<unknown>).detail)
  );
}

export function dispatchPptxElementReferenceAddToChat(reference: PptxElementReference) {
  window.dispatchEvent(
    new CustomEvent(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, {
      detail: reference,
    }),
  );
}
