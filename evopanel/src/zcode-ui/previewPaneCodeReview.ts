import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { CodeReviewCodeViewerSource } from "@/lib/codeViewer.js";

interface CodeReviewContentProjection {
  focusedRange: CodeCommentRange | null;
  inlineComments: readonly CodeCommentPreview[];
  targetLineOutOfRange: boolean;
  topComment: CodeCommentPreview | null;
}

export function resolveCodeReviewContentProjection(
  source: CodeReviewCodeViewerSource,
  content: string,
): CodeReviewContentProjection {
  // Persisted / platform-opened codeViewer tabs can arrive as type:code-review
  // without a review payload; reading review.startLine used to crash the pane.
  const review = source?.review;
  if (!review || typeof review !== "object") {
    return {
      focusedRange: null,
      inlineComments: [],
      targetLineOutOfRange: false,
      topComment: null,
    };
  }
  const startLine = review.startLine;
  const endLine = review.endLine ?? startLine;
  const hasRange =
    Number.isInteger(startLine) &&
    Number.isInteger(endLine) &&
    startLine !== undefined &&
    endLine !== undefined &&
    startLine > 0 &&
    endLine >= startLine;
  const lineCount = String(content || "").split(/\r\n|\r|\n/).length;
  const rangeIsVisible = hasRange && endLine <= lineCount;
  const comment: CodeCommentPreview = {
    id: String(review.requestId || "code-review"),
    sourcePath: source.path,
    sourceTitle: source.title,
    startLine: hasRange ? startLine : 1,
    endLine: hasRange ? endLine : 1,
    selectedText: "",
    comment: String(review.body || ""),
  };

  return {
    focusedRange: rangeIsVisible ? { startLine: startLine!, endLine: endLine! } : null,
    inlineComments: rangeIsVisible ? [comment] : [],
    targetLineOutOfRange: hasRange && !rangeIsVisible,
    topComment: rangeIsVisible ? null : comment,
  };
}
