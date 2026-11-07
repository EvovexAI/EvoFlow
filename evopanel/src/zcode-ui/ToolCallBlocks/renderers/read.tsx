import { SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { isImagePreviewPath } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { PlatformMediaPreview } from "./PlatformMediaPreview.js";
import type { PlatformUiToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const READ_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

/** 摘要行最多展示几枚文件 chip，其余折叠成 +N。 */
const READ_CHIP_VISIBLE_LIMIT = 3;

const READ_PATH_FIELD_KEYS = [
  "path",
  "image_path",
  "imagePath",
  "filePath",
  "file_path",
  "filename",
] as const;

const READ_PATH_LIST_FIELD_KEYS = ["paths", "files", "filePaths", "file_paths"] as const;

export type ReadSummary = {
  path: string;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  entryType: "file" | "directory";
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function extractTaggedValue(text: string, tagName: string): string | undefined {
  const matched = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  const value = matched?.[1]?.trim();
  return value ? value : undefined;
}

function normalizeReadEntryType(value: string | undefined): "file" | "directory" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "dir" || normalized === "directory" || normalized === "folder") {
    return "directory";
  }

  return "file";
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))];
}

/**
 * 把 read / view_image 的 path 入参展开成路径列表。
 * 对齐后端 ``normalize_image_path_args``：支持 string、string[]、JSON 数组字符串；
 * 流式半截 JSON 数组用引号内字面量兜底，避免 basename 变成 ``cliff_heroine.png"]``。
 */
export function coerceReadPathList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupePaths(value.map((item) => (typeof item === "string" ? item : String(item ?? ""))));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (!trimmed.startsWith("[")) {
    return [trimmed];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return dedupePaths(
        parsed.map((item) => (typeof item === "string" ? item : String(item ?? ""))),
      );
    }
    return [trimmed];
  } catch {
    // 流式 ARGS 常停在未闭合数组；抽取已出现的引号串，不要把整段 blob 当单路径。
    const quoted = [...trimmed.matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map((match) => {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          return match[1]?.replace(/\\"/g, '"') ?? "";
        }
      })
      .filter((path) => path.trim().length > 0);
    return dedupePaths(quoted);
  }
}

function collectPathsFromRecord(value: Record<string, unknown>): string[] {
  const paths: string[] = [];

  for (const key of READ_PATH_FIELD_KEYS) {
    if (!(key in value)) {
      continue;
    }
    paths.push(...coerceReadPathList(value[key]));
  }

  for (const key of READ_PATH_LIST_FIELD_KEYS) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const item of candidate) {
      if (typeof item === "string") {
        paths.push(...coerceReadPathList(item));
      } else if (isPlainRecord(item)) {
        paths.push(...collectPathsFromRecord(item));
      }
    }
  }

  return dedupePaths(paths);
}

function readReadMetadataFromRaw(raw: unknown): {
  paths: string[];
  entryType: "file" | "directory";
} {
  if (!isPlainRecord(raw)) {
    return { paths: [], entryType: "file" };
  }

  const rawInput = isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const directPaths = rawInput ? collectPathsFromRecord(rawInput) : [];
  const directType = rawInput
    ? readStringField(rawInput, ["type", "fileType", "entryType"])
    : undefined;

  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const outputText = rawOutput
    ? readStringField(rawOutput, ["output", "text", "content"])
    : undefined;
  const taggedOutputPath = outputText ? extractTaggedValue(outputText, "path") : undefined;
  const taggedOutputType = outputText ? extractTaggedValue(outputText, "type") : undefined;
  if (taggedOutputPath) {
    return {
      paths: coerceReadPathList(taggedOutputPath),
      entryType: normalizeReadEntryType(taggedOutputType),
    };
  }

  const contentItems = Array.isArray(raw.content) ? raw.content : [];
  for (const item of contentItems) {
    if (!isPlainRecord(item)) {
      continue;
    }

    const nestedContent = isPlainRecord(item.content) ? item.content : null;
    const text =
      (nestedContent && readStringField(nestedContent, ["text"])) ??
      readStringField(item, ["text"]);
    const taggedPath = text ? extractTaggedValue(text, "path") : undefined;
    const taggedType = text ? extractTaggedValue(text, "type") : undefined;
    if (taggedPath) {
      return {
        paths: coerceReadPathList(taggedPath),
        entryType: normalizeReadEntryType(taggedType),
      };
    }
  }

  if (directPaths.length > 0) {
    // 有些模型只在 rawInput 里给 filePath，但会在 rawOutput/content 里补充目录类型。
    // 之前这里一旦先读到 rawInput.filePath 就会提前返回成 file，导致目录卡片图标错误。
    // 现在改成“类型优先看显式输出，路径再回退 rawInput”，只在确实没有输出标签时才用 input 兜底。
    return {
      paths: directPaths,
      entryType: normalizeReadEntryType(directType),
    };
  }

  return { paths: [], entryType: "file" };
}

function readReadMetadataFromValue(value: unknown): {
  paths: string[];
  entryType: "file" | "directory";
} {
  if (!isPlainRecord(value)) {
    return { paths: [], entryType: "file" };
  }

  return {
    paths: collectPathsFromRecord(value),
    entryType: normalizeReadEntryType(readStringField(value, ["type", "fileType", "entryType"])),
  };
}

function createReadSummary(
  path: string,
  options: {
    fileName?: string;
    entryType?: "file" | "directory";
  } = {},
): ReadSummary {
  const entryType = options.entryType ?? "file";
  const descriptor = resolveFileDisplayDescriptor(path);

  return {
    path,
    fileName: options.fileName ?? descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: entryType === "directory" ? FOLDER_FILE_ICON_SRC : descriptor.fileIconSrc,
    entryType,
  };
}

export function buildReadSummaries(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ReadSummary[] {
  const input = toolCall.input;
  if (isPlainRecord(input) && Array.isArray(input.parsed_cmd)) {
    const cwd =
      typeof input.cwd === "string" && input.cwd.trim().length > 0
        ? input.cwd.trim().replace(/\/+$/, "")
        : null;

    const summaries: ReadSummary[] = [];
    for (const item of input.parsed_cmd) {
      if (!isPlainRecord(item) || item.type !== "read") {
        continue;
      }

      const relativePath =
        typeof item.path === "string" && item.path.trim().length > 0 ? item.path.trim() : undefined;
      const fileName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : relativePath
            ? (relativePath.split("/").filter(Boolean).pop() ?? relativePath)
            : undefined;

      if (!relativePath && !fileName) {
        continue;
      }

      const absolutePath =
        relativePath && cwd && !relativePath.startsWith("/")
          ? `${cwd}/${relativePath}`
          : (relativePath ?? fileName ?? "read");

      summaries.push(
        createReadSummary(absolutePath, {
          fileName,
          entryType: "file",
        }),
      );
    }
    if (summaries.length > 0) {
      return summaries;
    }
  }

  const directInputMetadata = readReadMetadataFromValue(input);
  if (directInputMetadata.paths.length > 0) {
    // 一些 provider 的 read/update 事件直接把文件路径放在 input.file_path，
    // 不会补 parsed_cmd，也不一定把相同字段镜像到 raw.rawInput.filePath。
    // 多图 batch 时 path / image_path 可能是 string[] 或 JSON 数组字符串。
    return directInputMetadata.paths.map((path) =>
      createReadSummary(path, {
        entryType: directInputMetadata.entryType,
      }),
    );
  }

  const rawMetadata = readReadMetadataFromRaw(toolCall.raw);
  return rawMetadata.paths.map((path) =>
    createReadSummary(path, {
      entryType: rawMetadata.entryType,
    }),
  );
}

export function buildReadSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ReadSummary | null {
  return buildReadSummaries(toolCall)[0] ?? null;
}

export function ReadFileChip({
  summary,
  clickable,
  onClick,
}: {
  summary: ReadSummary;
  clickable: boolean;
  onClick?: () => void;
}) {
  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-foreground-subtle hover:underline"
        title={summary.path}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
        {/* 文件名优先完整展示；完整路径放 title，避免与次要路径抢宽被截成 sp_... */}
        <span className="max-w-full shrink-0 truncate">{summary.fileName}</span>
      </button>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle"
      title={summary.path}
    >
      <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="max-w-full shrink-0 truncate">{summary.fileName}</span>
    </span>
  );
}

function ReadFileChipList({
  summaries,
  canOpenPreview,
  onOpenPreview,
}: {
  summaries: readonly ReadSummary[];
  canOpenPreview: boolean;
  onOpenPreview: (summary: ReadSummary) => void;
}) {
  if (summaries.length === 0) {
    return null;
  }

  if (summaries.length === 1) {
    const summary = summaries[0]!;
    return (
      <ReadFileChip
        summary={summary}
        clickable={canOpenPreview && summary.entryType === "file"}
        onClick={() => onOpenPreview(summary)}
      />
    );
  }

  const visible = summaries.slice(0, READ_CHIP_VISIBLE_LIMIT);
  const hiddenCount = summaries.length - visible.length;
  const allPaths = summaries.map((summary) => summary.path).join("\n");

  return (
    <span
      className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden"
      title={allPaths}
    >
      {visible.map((summary) => (
        <span key={summary.path} className="inline-flex min-w-0 shrink-0">
          <ReadFileChip
            summary={summary}
            clickable={canOpenPreview && summary.entryType === "file"}
            onClick={() => onOpenPreview(summary)}
          />
        </span>
      ))}
      {hiddenCount > 0 ? <span className="shrink-0 text-foreground-subtle">+{hiddenCount}</span> : null}
    </span>
  );
}

export function ReadToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText, onOpenCodeViewer } = context;
  const { toolCall } = toolCallNode;
  const summaries = useMemo(() => buildReadSummaries(toolCall), [toolCall]);
  const imageMedia = useMemo((): NonNullable<PlatformUiToolResultDisplay["media"]> => {
    return summaries
      .filter((summary) => summary.entryType === "file" && isImagePreviewPath(summary.path))
      .map((summary) => ({
        kind: "image",
        mimeType: "image/*",
        absolutePath: summary.path,
        artifactUri: summary.path,
      }));
  }, [summaries]);
  const canOpenPreview = Boolean(onOpenCodeViewer);
  const openFilePreview = useCallback(
    (summary: ReadSummary) => {
      if (summary.entryType !== "file" || !onOpenCodeViewer) {
        return;
      }

      onOpenCodeViewer({
        type: "file",
        title: summary.fileName,
        path: summary.path,
      });
    },
    [onOpenCodeViewer],
  );
  const primaryText = useMemo(
    () =>
      summaries.length > 0 ? (
        <ReadFileChipList
          summaries={summaries}
          canOpenPreview={canOpenPreview}
          onOpenPreview={openFilePreview}
        />
      ) : (
        (toolCall.title ?? toolCall.kind ?? intl.formatMessage({ id: "chat.toolCall.read.read" }))
      ),
    [canOpenPreview, intl, openFilePreview, summaries, toolCall.kind, toolCall.title],
  );
  const renderContent = useCallback(
    () =>
      imageMedia.length > 0 ? (
        <PlatformMediaPreview media={imageMedia} label="读取图片" />
      ) : null,
    [imageMedia],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={imageMedia.length > 0}
        forceOpen={imageMedia.length > 0 && !isRunning && toolCall.status !== "failed"}
        kindLabel={intl.formatMessage({
          id: isRunning ? "chat.toolCall.read.reading" : "chat.toolCall.kind.read",
        })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        // 窄栏里父路径常被截成半截且挤掉文件名；完整路径改挂 chip title。
        secondaryText={undefined}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={imageMedia.length > 0 ? renderContent : undefined}
        content={imageMedia.length > 0 ? undefined : null}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
