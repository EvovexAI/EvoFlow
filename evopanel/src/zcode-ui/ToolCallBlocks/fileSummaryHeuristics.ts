import { computeLineChangeStat } from "@zcode/shared";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf } from "@/lib/path.js";
import { buildUnifiedDiff } from "@/lib/toolDiffPreview.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  type EditKindSource,
  type EditOperationKind,
  type RawToolCallFileSummary,
  isPlainRecord,
  readRawToolCallInput,
  readStringField,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

export type { EditKindSource } from "@/ToolCallBlocks/fileSummaryTypes.js";

function normalizeActionText(value: string) {
  return value.trim().toLowerCase();
}

export function hasWritableToolSemantic(source?: EditKindSource): boolean {
  if (!source) {
    return false;
  }

  // TodoWrite/AskUserQuestion 这类固定工具名不能再靠字符串片段判断写文件。
  // 统一走 tool identity，旧 ZCode Agent 的 kind/title/raw 兼容只留在 resolver fallback 里。
  return resolveToolCallIdentity(source).family === "file-write";
}

function hasReadLikeToolSemantic(source?: EditKindSource): boolean {
  if (!source) {
    return false;
  }

  return resolveToolCallIdentity(source).family === "file-read";
}

function inferEditOperationFromText(value: string): EditOperationKind | null {
  const text = normalizeActionText(value);
  if (!text) {
    return null;
  }

  if (/(delete|deleted|remov(e|ed)|eras(e|ed)|unlink|destroy|rm)\b/.test(text)) {
    return "delete";
  }

  if (/(update|updating|updated)\b/.test(text)) {
    return "update";
  }

  if (/(write|wrote|written|create|creating|created|add|added|save|saved|new)\b/.test(text)) {
    return "write";
  }

  if (
    /(edit|editing|edited|modify|modifying|modified|change|changed|patch|replace|replaced|fix|fixed)\b/.test(
      text,
    )
  ) {
    return "edit";
  }

  return null;
}

function readEditOperationCandidates(source: EditKindSource): string[] {
  const candidates = new Set<string>();

  if (typeof source.title === "string" && source.title.trim().length > 0) {
    candidates.add(source.title);
  }

  if (typeof source.kind === "string" && source.kind.trim().length > 0) {
    candidates.add(source.kind);
  }

  if (isPlainRecord(source.input)) {
    for (const key of ["description", "action", "operation", "mode", "title", "kind"] as const) {
      const value = source.input[key];
      if (typeof value === "string" && value.trim().length > 0) {
        candidates.add(value);
      }
    }
  }

  if (isPlainRecord(source.raw)) {
    const rawKind = source.raw.kind;
    if (typeof rawKind === "string" && rawKind.trim().length > 0) {
      candidates.add(rawKind);
    }

    const rawTitle = source.raw.title;
    if (typeof rawTitle === "string" && rawTitle.trim().length > 0) {
      candidates.add(rawTitle);
    }

    const rawInput = readRawToolCallInput(source.raw);
    if (isPlainRecord(rawInput)) {
      for (const key of ["description", "action", "operation", "mode", "title", "kind"] as const) {
        const value = rawInput[key];
        if (typeof value === "string" && value.trim().length > 0) {
          candidates.add(value);
        }
      }
    }
  }

  return [...candidates];
}

function readRawContentTexts(raw: unknown): string[] {
  if (!isPlainRecord(raw)) {
    return [];
  }

  const texts = new Set<string>();
  const content = raw.content;

  const addText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      texts.add(value);
    }
  };

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isPlainRecord(item)) {
        continue;
      }

      addText(item.text);
      addText(item.content);

      if (isPlainRecord(item.content)) {
        addText(item.content.text);
        addText(item.content.content);
      }
    }
  } else if (isPlainRecord(content)) {
    addText(content.text);
    addText(content.content);
  }

  return [...texts];
}

function readToolCallPathCandidate(source?: EditKindSource): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const value of [
    source.input,
    source.output,
    readRawToolCallInput(source.raw),
    isPlainRecord(source.raw) ? source.raw.rawOutput : undefined,
  ]) {
    if (!isPlainRecord(value)) {
      continue;
    }

    const path = readStringField(value, [
      "path",
      "filePath",
      "file_path",
      "targetPath",
      "target_path",
      "filename",
      "file",
    ]);
    if (path) {
      return path;
    }
  }

  return undefined;
}

function readToolCallContentCandidate(source?: EditKindSource): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const value of [
    source.input,
    source.output,
    readRawToolCallInput(source.raw),
    isPlainRecord(source.raw) ? source.raw.rawOutput : undefined,
  ]) {
    if (!isPlainRecord(value)) {
      continue;
    }

    const content = readStringField(value, [
      "content",
      "newText",
      "new_text",
      "newString",
      "new_string",
      "text",
      "fileContent",
      "file_content",
      "contents",
      "code",
    ]);
    if (content !== undefined) {
      return content;
    }
  }

  return undefined;
}

function readToolCallBeforeAfterCandidate(
  source?: EditKindSource,
): { oldText: string; newText: string } | null {
  if (!source) {
    return null;
  }

  for (const value of [
    source.input,
    source.output,
    readRawToolCallInput(source.raw),
    isPlainRecord(source.raw) ? source.raw.rawOutput : undefined,
    source.raw,
  ]) {
    if (!isPlainRecord(value)) {
      continue;
    }

    const oldText = readStringField(value, [
      "oldText",
      "old_string",
      "oldString",
      "before",
      "old_content",
      "oldContent",
    ]);
    const newText = readStringField(value, [
      "newText",
      "new_string",
      "newString",
      "after",
      "new_content",
      "newContent",
      "content",
    ]);
    if (oldText !== undefined && newText !== undefined) {
      return { oldText, newText };
    }
  }

  return null;
}

export function buildFallbackRawToolCallFileSummary(
  source?: EditKindSource,
): RawToolCallFileSummary[] {
  const path = readToolCallPathCandidate(source);
  if (!path) {
    return [];
  }

  if (hasReadLikeToolSemantic(source)) {
    return [];
  }

  if (!hasWritableToolSemantic(source)) {
    return [];
  }

  const inferredOperation = source ? inferEditOperation([], [], source) : null;
  if (!inferredOperation) {
    return [];
  }

  const descriptor = resolveFileDisplayDescriptor(path);
  const actionLabel: RawToolCallFileSummary["actionLabel"] =
    inferredOperation === "write"
      ? "Created"
      : inferredOperation === "delete"
        ? "Deleted"
        : "Edited";
  const content = readToolCallContentCandidate(source);
  const beforeAfter = readToolCallBeforeAfterCandidate(source);
  const changeStat =
    actionLabel === "Created" && content !== undefined
      ? computeLineChangeStat(null, content)
      : actionLabel === "Deleted" && content !== undefined
        ? computeLineChangeStat(content, "")
        : actionLabel === "Edited" && beforeAfter
          ? computeLineChangeStat(beforeAfter.oldText, beforeAfter.newText)
          : undefined;
  const patch =
    actionLabel === "Created" && content !== undefined
      ? buildUnifiedDiff("", content, getPathLeaf(path))
      : actionLabel === "Edited" && beforeAfter
        ? buildUnifiedDiff(beforeAfter.oldText, beforeAfter.newText, getPathLeaf(path))
        : null;

  return [
    {
      path,
      actionLabel,
      operationKind: inferredOperation,
      fileName: descriptor.fileName,
      filePath: descriptor.filePath,
      fileIconSrc: descriptor.fileIconSrc,
      changeStat,
      patch,
    },
  ];
}

function readEditOperationCandidatesByPhase(source: EditKindSource): string[] {
  const prioritized = new Set<string>();
  const raw = source.raw;
  const isRunning = isPlainRecord(raw) && raw.status === "pending";
  const isCompleted = isPlainRecord(raw) && raw.status === "completed";
  const shouldIgnoreCompletedContent = hasReadLikeToolSemantic(source);

  if (isRunning && typeof source.title === "string" && source.title.trim().length > 0) {
    prioritized.add(source.title);
  }

  if (isCompleted && !shouldIgnoreCompletedContent) {
    for (const text of readRawContentTexts(raw)) {
      prioritized.add(text);
    }
  }

  for (const candidate of readEditOperationCandidates(source)) {
    prioritized.add(candidate);
  }

  return [...prioritized];
}

export function inferEditOperation(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  source?: EditKindSource,
): EditOperationKind | null {
  if (source && !hasWritableToolSemantic(source)) {
    // 之前 search / explore / execute 等非写类工具，只要标题或输出里带 delete/remove，
    // 就可能被文本启发式误判成 delete。这里先要求工具本身具备“写文件”语义，再继续细分操作。
    return null;
  }

  if (operationKinds.length > 0) {
    const allWrite = operationKinds.every((kind) => kind === "write");
    const allUpdate = operationKinds.every((kind) => kind === "update");
    const allDelete = operationKinds.every((kind) => kind === "delete");

    if (allWrite) {
      return "write";
    }

    if (allUpdate) {
      return "update";
    }

    if (allDelete) {
      return "delete";
    }

    return "edit";
  }

  if (source) {
    for (const candidate of readEditOperationCandidatesByPhase(source)) {
      const inferred = inferEditOperationFromText(candidate);
      if (inferred) {
        return inferred;
      }
    }
  }

  if (actionLabels.length === 0) {
    return null;
  }

  const allCreated = actionLabels.every((label) => label === "Created");
  const allEdited = actionLabels.every((label) => label === "Edited");
  const allDeleted = actionLabels.every((label) => label === "Deleted");

  if (allCreated) {
    return "write";
  }

  if (allDeleted) {
    return "delete";
  }

  if (allEdited || actionLabels.length > 0) {
    return "edit";
  }

  return null;
}
