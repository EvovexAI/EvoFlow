export const CODE_COMMENT_ADD_TO_CHAT_EVENT = "zcode:code-comment-add-to-chat";
export const CODE_COMMENT_REMOVE_FROM_CHAT_EVENT = "zcode:code-comment-remove-from-chat";
export const CODE_COMMENT_REMOVE_BROADCAST_CHANNEL = "code-comment:remove-from-chat";
export const CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL = "code-comment:restore-preview";

export interface CodeCommentRange {
  startLine: number;
  endLine: number;
}

export interface CodeCommentPayload extends CodeCommentRange {
  id?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sourcePath?: string;
  sourceTitle: string;
  selectedText: string;
  comment: string;
  contextLabel?: string;
  commentLabel?: string;
}

export interface CodeCommentComposerAttachment extends CodeCommentPayload {
  id: string;
}

export interface CodeCommentRemovePayload {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CodeCommentPreview extends CodeCommentRange {
  id: string;
  sourcePath?: string;
  sourceTitle: string;
  selectedText: string;
  comment: string;
}

interface ParsedCodeCommentPrompt {
  visibleContent: string;
  codeCommentAttachments: CodeCommentComposerAttachment[];
}

type CodeCommentAddToChatEvent = CustomEvent<CodeCommentPayload>;
type CodeCommentRemoveFromChatEvent = CustomEvent<CodeCommentRemovePayload>;

const removedCodeCommentKeys = new Set<string>();

export function getCodeCommentWorkspaceKey(workspacePath: string, workspaceIdentity?: string) {
  return workspaceIdentity?.trim() || workspacePath;
}

function getCodeCommentRemovalKey(payload: CodeCommentRemovePayload) {
  return `${getCodeCommentWorkspaceKey(payload.workspacePath, payload.workspaceIdentity)}\0${payload.id}`;
}

export function isCodeCommentMarkedRemoved(payload: CodeCommentRemovePayload) {
  return removedCodeCommentKeys.has(getCodeCommentRemovalKey(payload));
}

export function markCodeCommentRemoved(payload: CodeCommentRemovePayload) {
  removedCodeCommentKeys.add(getCodeCommentRemovalKey(payload));
}

export function unmarkCodeCommentRemoved(payload: CodeCommentRemovePayload) {
  removedCodeCommentKeys.delete(getCodeCommentRemovalKey(payload));
}

export function isCodeCommentAddToChatEvent(event: Event): event is CodeCommentAddToChatEvent {
  return (
    event.type === CODE_COMMENT_ADD_TO_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

export function isCodeCommentRemoveFromChatEvent(
  event: Event,
): event is CodeCommentRemoveFromChatEvent {
  return (
    event.type === CODE_COMMENT_REMOVE_FROM_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

export function isCodeCommentRemovePayload(payload: unknown): payload is CodeCommentRemovePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as CodeCommentRemovePayload).id === "string" &&
    (payload as CodeCommentRemovePayload).id.length > 0 &&
    typeof (payload as CodeCommentRemovePayload).workspacePath === "string" &&
    (payload as CodeCommentRemovePayload).workspacePath.length > 0 &&
    ((payload as CodeCommentRemovePayload).workspaceIdentity === undefined ||
      typeof (payload as CodeCommentRemovePayload).workspaceIdentity === "string")
  );
}

export function isCodeCommentPayload(payload: unknown): payload is CodeCommentPayload {
  const candidate = payload as CodeCommentPayload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.length > 0 &&
    (candidate.workspaceIdentity === undefined ||
      typeof candidate.workspaceIdentity === "string") &&
    typeof candidate.sourcePath === "string" &&
    candidate.sourcePath.length > 0 &&
    typeof candidate.sourceTitle === "string" &&
    candidate.sourceTitle.length > 0 &&
    typeof candidate.selectedText === "string" &&
    typeof candidate.comment === "string" &&
    Number.isFinite(candidate.startLine) &&
    Number.isFinite(candidate.endLine)
  );
}

function buildCodeCommentMarkdown(payload: CodeCommentPayload) {
  const lineLabel =
    payload.startLine === payload.endLine
      ? String(payload.startLine)
      : `${payload.startLine}-${payload.endLine}`;

  return `## Comment\nFile: ${payload.sourcePath ?? payload.sourceTitle}\nSide: R\nLines: ${lineLabel}\nSelected text:\n\`\`\`\n${payload.selectedText.trim()}\n\`\`\`\nComment:\n${payload.comment.trim()}\n`;
}

function buildCodeCommentsBlock(attachments: readonly CodeCommentComposerAttachment[]) {
  if (attachments.length === 0) {
    return "";
  }

  return `# Code comments:\n\n${attachments
    .map((attachment, index) =>
      buildCodeCommentMarkdown(attachment).replace("## Comment", `## Comment ${index + 1}`),
    )
    .join("\n")}`;
}

export function buildPromptWithCodeComments(
  text: string,
  attachments: readonly CodeCommentComposerAttachment[],
) {
  const content = text.trimEnd();
  const commentsBlock = buildCodeCommentsBlock(attachments);
  if (!commentsBlock) {
    return content.trim();
  }

  return `${content}${content ? "\n\n" : ""}${commentsBlock}`.trim();
}

function getSourceTitle(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function parseLineRange(value: string): CodeCommentRange | null {
  const normalized = value.trim().replace(/^L/i, "");
  const match = /^(\d+)(?:\s*-\s*L?(\d+))?$/.exec(normalized);
  if (!match) {
    return null;
  }

  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }

  return {
    startLine,
    endLine,
  };
}

function parseCodeCommentItem(
  rawItem: string,
  index: number,
  workspacePath: string,
  workspaceIdentity?: string,
): CodeCommentComposerAttachment | null {
  const fileMatch = /^File:\s*(.+)$/m.exec(rawItem);
  const linesMatch = /^Lines:\s*(.+)$/m.exec(rawItem);
  const selectedTextMatch =
    /Selected text:\s*\n```(?:[^\n`]*)?\n([\s\S]*?)\n```\s*\nComment:\s*\n?([\s\S]*)$/m.exec(
      rawItem,
    );
  if (!fileMatch || !linesMatch || !selectedTextMatch) {
    return null;
  }

  const filePath = fileMatch[1];
  const lines = linesMatch[1];
  const selectedText = selectedTextMatch[1];
  const rawComment = selectedTextMatch[2];
  if (!filePath || !lines || selectedText === undefined || rawComment === undefined) {
    return null;
  }

  const range = parseLineRange(lines);
  if (!range) {
    return null;
  }

  const sourcePath = filePath.trim();
  const comment = rawComment.trim();

  return {
    id: `parsed-code-comment-${index + 1}-${range.startLine}-${range.endLine}`,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    sourcePath,
    sourceTitle: getSourceTitle(sourcePath),
    startLine: range.startLine,
    endLine: range.endLine,
    selectedText: selectedText.trim(),
    comment,
  };
}

export function parsePromptCodeComments(
  content: string,
  options: {
    workspacePath: string;
    workspaceIdentity?: string;
  },
): ParsedCodeCommentPrompt {
  // 这里不能使用 multiline 的 `$`，否则非贪婪匹配会在第一行 `## Comment 1` 后提前停止，
  // 导致持久化消息无法解析回 comment 附件，只能把原始 markdown 暴露在聊天气泡里。
  const blockMatch = /(?:^|\n\n)# Code comments:\s*\n\n([\s\S]*?)\s*$/.exec(content);
  if (!blockMatch || blockMatch.index < 0) {
    return {
      visibleContent: content,
      codeCommentAttachments: [],
    };
  }

  const rawBlock = blockMatch[1];
  if (rawBlock === undefined) {
    return {
      visibleContent: content,
      codeCommentAttachments: [],
    };
  }
  const rawItems = rawBlock
    .split(/\n(?=## Comment(?:\s+\d+)?\n)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const codeCommentAttachments = rawItems
    .map((item, index) =>
      parseCodeCommentItem(item, index, options.workspacePath, options.workspaceIdentity),
    )
    .filter((item): item is CodeCommentComposerAttachment => item !== null);

  if (codeCommentAttachments.length === 0) {
    return {
      visibleContent: content,
      codeCommentAttachments: [],
    };
  }

  return {
    visibleContent: content.slice(0, blockMatch.index).trimEnd(),
    codeCommentAttachments,
  };
}

export function dispatchCodeCommentAddToChat(payload: CodeCommentPayload) {
  const event = new CustomEvent(CODE_COMMENT_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

export function dispatchCodeCommentRemoveFromChat(payload: CodeCommentRemovePayload) {
  markCodeCommentRemoved(payload);
  window.dispatchEvent(
    new CustomEvent(CODE_COMMENT_REMOVE_FROM_CHAT_EVENT, {
      detail: payload,
    }),
  );
}
