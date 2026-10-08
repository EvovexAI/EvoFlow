import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
} from "@/lib/assistantDirectiveParser.js";

type ZCodeFileCitationPreviewKind = "docx" | "xlsx" | "pptx" | "pdf" | "video" | "audio";

interface ZCodeFileCitation {
  artifactKind?: string;
  end: number;
  path: string;
  purpose?: string;
  raw: string;
  start: number;
}

interface ZCodeFileCitationDirective {
  artifactKind?: string;
  end: number;
  path?: string;
  purpose?: string;
  raw: string;
  start: number;
}

interface ZCodeFileCitationProjection {
  visibleText: string;
}

const ARTIFACT_KIND_TO_PREVIEW_KIND: Readonly<
  Record<string, Exclude<ZCodeFileCitationPreviewKind, "pdf">>
> = {
  audio: "audio",
  document: "docx",
  presentation: "pptx",
  video: "video",
  workbook: "xlsx",
};
const PREVIEW_EXTENSION_TO_KIND: Readonly<Record<string, ZCodeFileCitationPreviewKind>> = {
  ".docx": "docx",
  ".flac": "audio",
  ".m4a": "audio",
  ".m4v": "video",
  ".mov": "video",
  ".mp3": "audio",
  ".mp4": "video",
  ".ogg": "audio",
  ".opus": "audio",
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".wav": "audio",
  ".webm": "video",
  ".weba": "audio",
};
const ZCODE_FILE_CITATION_DIRECTIVE_NAME = "zcode-file-citation";
const ZCODE_FILE_CITATION_SINGLE_COLON_PREFIX_LENGTH = ":zcode".length;
const ZCODE_FILE_CITATION_SYNTAX = {
  allowSingleColon: true,
  allowSmartQuotes: true,
  allowTripleColon: true,
} as const;

export function extractZCodeFileCitationDirectives(content: string): ZCodeFileCitationDirective[] {
  return extractAssistantDirectives(
    content,
    ZCODE_FILE_CITATION_DIRECTIVE_NAME,
    ZCODE_FILE_CITATION_SYNTAX,
  ).map((directive) => ({
    start: directive.start,
    end: directive.end,
    raw: directive.raw,
    ...(directive.parameters?.path?.trim() ? { path: directive.parameters.path.trim() } : {}),
    ...(directive.parameters?.purpose !== undefined
      ? { purpose: directive.parameters.purpose }
      : {}),
    ...(directive.parameters?.artifact_kind !== undefined
      ? { artifactKind: directive.parameters.artifact_kind }
      : {}),
  }));
}

export function extractZCodeFileCitations(content: string): ZCodeFileCitation[] {
  return extractZCodeFileCitationDirectives(content).flatMap((directive) =>
    directive.path
      ? [
          {
            ...directive,
            path: directive.path,
          },
        ]
      : [],
  );
}

/**
 * 仅在流式尾部隐藏未闭合 citation。完整 citation 继续交给 remark 插件投影为正文链接，
 * 卡片是否生成仍由终态 row gate 决定。异常模型输出若已换行继续正文，则保留原文，避免
 * 一个缺失 `}` 的指令把后续回答全部吞掉；代码块中的协议样例也不参与隐藏。
 */
export function projectZCodeFileCitations(
  content: string,
  options: { streaming: boolean },
): ZCodeFileCitationProjection {
  if (!options.streaming || !content) return { visibleText: content };

  const protectedRanges = findMarkdownCodeRanges(content);
  const unclosedStart = findUnclosedAssistantDirectiveStart(
    content,
    ZCODE_FILE_CITATION_DIRECTIVE_NAME,
    protectedRanges,
    ZCODE_FILE_CITATION_SYNTAX,
  );
  if (unclosedStart === null) {
    const prefixStart = findAssistantDirectivePrefixStart(
      content,
      ["code-comment", ZCODE_FILE_CITATION_DIRECTIVE_NAME],
      protectedRanges,
      {
        minimumSingleColonPrefixLength: ZCODE_FILE_CITATION_SINGLE_COLON_PREFIX_LENGTH,
        singleColonDirectiveNames: [ZCODE_FILE_CITATION_DIRECTIVE_NAME],
        tripleColonDirectiveNames: [ZCODE_FILE_CITATION_DIRECTIVE_NAME],
      },
    );
    return prefixStart === null
      ? { visibleText: content }
      : { visibleText: content.slice(0, prefixStart) };
  }

  return {
    visibleText: content.slice(0, unclosedStart),
  };
}

function inferPreviewKindFromPath(path: string): ZCodeFileCitationPreviewKind | null {
  const normalizedPath = path.trim().toLowerCase();
  for (const [extension, kind] of Object.entries(PREVIEW_EXTENSION_TO_KIND)) {
    if (normalizedPath.endsWith(extension)) return kind;
  }
  return null;
}

export function resolveZCodeFileCitationPreviewKind(params: {
  artifactKind?: string;
  path: string;
}): ZCodeFileCitationPreviewKind | null {
  const inferredKind = inferPreviewKindFromPath(params.path);
  if (params.artifactKind === undefined) return inferredKind;

  const artifactKind = ARTIFACT_KIND_TO_PREVIEW_KIND[params.artifactKind.trim().toLowerCase()];
  return artifactKind && artifactKind === inferredKind ? artifactKind : null;
}
