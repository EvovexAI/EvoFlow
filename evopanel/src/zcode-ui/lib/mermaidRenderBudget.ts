const MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS = 20_000;
const MERMAID_AUTO_RENDER_MAX_LINES = 600;
const MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE = 1_500;

type MermaidDocumentVisibilityState = "visible" | "hidden" | "prerender" | "unloaded" | "unknown";

type MermaidAutoRenderSkipReason =
  | "document-hidden"
  | "source-too-large"
  | "line-count-too-large"
  | "complexity-too-large";

interface MermaidAutoRenderMetrics {
  sourceChars: number;
  lineCount: number;
  edgeLikeTokenCount: number;
  nodeLikeTokenCount: number;
  complexityScore: number;
}

type MermaidAutoRenderDecision =
  | {
      shouldRender: true;
      metrics: MermaidAutoRenderMetrics;
    }
  | {
      shouldRender: false;
      reason: MermaidAutoRenderSkipReason;
      metrics: MermaidAutoRenderMetrics;
    };

interface MermaidAutoRenderOptions {
  documentVisibilityState?: MermaidDocumentVisibilityState;
  maxSourceChars?: number;
  maxLines?: number;
  maxComplexityScore?: number;
}

const MERMAID_EDGE_TOKEN_PATTERN = /(?:<-->|<--|-->|---|-\.->|==>|--x|--o|x--|o--)/gu;
const MERMAID_NODE_TOKEN_PATTERN =
  /(?:^|\n)\s*[A-Za-z][\w-]*(?:\[[^\]\n]{0,200}\]|\([^)\n]{0,200}\)|\{[^}\n]{0,200}\})/gu;

function countPatternMatches(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(value)) {
    count += 1;
  }
  return count;
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }

  let lineCount = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }
  return lineCount;
}

export function getCurrentMermaidDocumentVisibility(): MermaidDocumentVisibilityState {
  if (typeof document === "undefined") {
    return "visible";
  }

  const visibilityState = document.visibilityState as MermaidDocumentVisibilityState | undefined;
  if (
    visibilityState === "visible" ||
    visibilityState === "hidden" ||
    visibilityState === "prerender" ||
    visibilityState === "unloaded"
  ) {
    return visibilityState;
  }

  return document.hidden ? "hidden" : "visible";
}

function measureMermaidSource(source: string): MermaidAutoRenderMetrics {
  const sourceChars = source.length;
  const lineCount = countLines(source);
  const edgeLikeTokenCount = countPatternMatches(source, MERMAID_EDGE_TOKEN_PATTERN);
  const nodeLikeTokenCount = countPatternMatches(source, MERMAID_NODE_TOKEN_PATTERN);
  const complexityScore = lineCount + edgeLikeTokenCount + nodeLikeTokenCount;

  return {
    sourceChars,
    lineCount,
    edgeLikeTokenCount,
    nodeLikeTokenCount,
    complexityScore,
  };
}

export function resolveMermaidAutoRenderDecision(
  source: string,
  options: MermaidAutoRenderOptions = {},
): MermaidAutoRenderDecision {
  const metrics = measureMermaidSource(source);
  const documentVisibilityState = options.documentVisibilityState ?? "visible";
  const maxSourceChars = options.maxSourceChars ?? MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS;
  const maxLines = options.maxLines ?? MERMAID_AUTO_RENDER_MAX_LINES;
  const maxComplexityScore = options.maxComplexityScore ?? MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE;

  // Mermaid/DOMPurify 渲染会在 native 层构造大 DOM/SVG 字符串，事后 catch 或截断无法阻止 OOM。
  // 因此必须在进入 Mermaid render 前按源码规模和页面可见性做预算门禁。
  if (documentVisibilityState !== "visible" && documentVisibilityState !== "unknown") {
    return {
      shouldRender: false,
      reason: "document-hidden",
      metrics,
    };
  }

  if (metrics.sourceChars > maxSourceChars) {
    return {
      shouldRender: false,
      reason: "source-too-large",
      metrics,
    };
  }

  if (metrics.lineCount > maxLines) {
    return {
      shouldRender: false,
      reason: "line-count-too-large",
      metrics,
    };
  }

  if (metrics.complexityScore > maxComplexityScore) {
    return {
      shouldRender: false,
      reason: "complexity-too-large",
      metrics,
    };
  }

  return {
    shouldRender: true,
    metrics,
  };
}
