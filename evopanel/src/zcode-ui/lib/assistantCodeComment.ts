import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";
import {
  resolveAssistantRawFilePath,
  type AssistantFilePathResolveOptions,
} from "@/lib/assistantFileReferences.js";

export type AssistantCodeCommentPriority = 0 | 1 | 2 | 3;

export interface AssistantCodeComment {
  body: string;
  endLine?: number;
  file: string;
  priority?: AssistantCodeCommentPriority;
  sourceEnd: number;
  sourceStart: number;
  startLine?: number;
  title: string;
}

export interface AssistantCodeCommentCard extends AssistantCodeComment {
  displayPath: string;
  id: string;
  path: string;
}

interface AssistantCodeCommentProjection {
  comments: AssistantCodeComment[];
  visibleText: string;
}

const CODE_COMMENT_DIRECTIVE_NAME = "code-comment";

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

function parsePriority(value: string | undefined): AssistantCodeCommentPriority | undefined {
  if (!value || !/^[0-3]$/.test(value)) return undefined;
  return Number.parseInt(value, 10) as AssistantCodeCommentPriority;
}

function extractAssistantCodeComments(content: string): AssistantCodeComment[] {
  const protectedRanges = findMarkdownCodeRanges(content);
  return extractAssistantDirectives(content, CODE_COMMENT_DIRECTIVE_NAME).flatMap((directive) => {
    if (
      !directive.parameters ||
      overlapsAssistantTextRanges(directive.start, directive.start + 1, protectedRanges)
    ) {
      return [];
    }

    const title = directive.parameters.title?.trim();
    const body = directive.parameters.body?.trim();
    const file = directive.parameters.file?.trim();
    if (!title || !body || !file) return [];

    const startLine = parsePositiveInteger(directive.parameters.start);
    const parsedEndLine = parsePositiveInteger(directive.parameters.end);
    const hasValidRange =
      startLine !== undefined && (parsedEndLine === undefined || parsedEndLine >= startLine);
    const priority = parsePriority(directive.parameters.priority);

    return [
      {
        title,
        body,
        file,
        sourceStart: directive.start,
        sourceEnd: directive.end,
        ...(hasValidRange
          ? {
              startLine,
              endLine: parsedEndLine ?? startLine,
            }
          : {}),
        ...(priority !== undefined ? { priority } : {}),
      },
    ];
  });
}

function replacementForComment(
  content: string,
  comment: AssistantCodeComment,
): { end: number; replacement: string; start: number } {
  const lineStart = content.lastIndexOf("\n", comment.sourceStart - 1) + 1;
  const nextNewline = content.indexOf("\n", comment.sourceEnd);
  const lineEnd = nextNewline < 0 ? content.length : nextNewline;
  const prefix = content.slice(lineStart, comment.sourceStart);
  const suffix = content.slice(comment.sourceEnd, lineEnd);
  if (!prefix.trim() && !suffix.trim()) {
    return {
      start: lineStart,
      end: nextNewline < 0 ? lineEnd : nextNewline + 1,
      replacement: "",
    };
  }
  return {
    start: comment.sourceStart,
    end: comment.sourceEnd,
    replacement: " ",
  };
}

export function projectAssistantCodeComments(
  content: string,
  options: { streaming: boolean },
): AssistantCodeCommentProjection {
  const comments = extractAssistantCodeComments(content);
  const replacements = comments.map((comment) => replacementForComment(content, comment));

  if (options.streaming) {
    const protectedRanges = findMarkdownCodeRanges(content);
    const unclosedStart = findUnclosedAssistantDirectiveStart(
      content,
      CODE_COMMENT_DIRECTIVE_NAME,
      protectedRanges,
    );
    if (unclosedStart !== null) {
      // 流式尾部如果直接交给 Markdown，会在闭合前把内部协议原文闪给用户。
      replacements.push({ start: unclosedStart, end: content.length, replacement: "" });
    } else {
      const prefixStart = findAssistantDirectivePrefixStart(
        content,
        [CODE_COMMENT_DIRECTIVE_NAME, "zcode-file-citation"],
        protectedRanges,
        {
          minimumSingleColonPrefixLength: ":zcode".length,
          singleColonDirectiveNames: ["zcode-file-citation"],
          tripleColonDirectiveNames: ["zcode-file-citation"],
        },
      );
      if (prefixStart !== null) {
        replacements.push({ start: prefixStart, end: content.length, replacement: "" });
      }
    }
  }

  let visibleText = content;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    visibleText =
      visibleText.slice(0, replacement.start) +
      replacement.replacement +
      visibleText.slice(replacement.end);
  }

  return { comments, visibleText };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWindowsWorkspacePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const normalizedWorkspace = normalizePath(workspacePath);
  const normalizedFile = normalizePath(filePath);
  const windows = isWindowsWorkspacePath(workspacePath);
  const comparedWorkspace = windows ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
  const comparedFile = windows ? normalizedFile.toLowerCase() : normalizedFile;
  if (!comparedFile.startsWith(`${comparedWorkspace}/`)) return null;
  return normalizedFile.slice(normalizedWorkspace.length + 1);
}

export function buildAssistantCodeCommentCards(
  content: string,
  workspacePath: string,
  limit = 50,
  options: AssistantFilePathResolveOptions = {},
): AssistantCodeCommentCard[] {
  return extractAssistantCodeComments(content)
    .flatMap((comment) => {
      const path = resolveAssistantRawFilePath(workspacePath, comment.file, options);
      const displayPath = path ? resolveWorkspaceRelativePath(workspacePath, path) : null;
      if (!path || !displayPath) return [];
      return [
        {
          ...comment,
          id: `code-comment:${comment.sourceStart}:${path}`,
          path,
          displayPath,
        },
      ];
    })
    .slice(0, limit);
}
