export function isMermaidLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

const MERMAID_AUTODETECT_LANGUAGES = new Set(["", "text", "txt", "plain"]);
const MERMAID_LEADING_DIRECTIVE_PATTERN = /^---[\s\S]*?---\s*/;
const MERMAID_DIAGRAM_START_PATTERN =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|c4(?:Context|Container|Component|Dynamic|Deployment))/i;

function isLikelyMermaidCode(code: string): boolean {
  const firstMeaningfulLine = code
    .trim()
    .replace(MERMAID_LEADING_DIRECTIVE_PATTERN, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  return firstMeaningfulLine
    ? MERMAID_DIAGRAM_START_PATTERN.test(firstMeaningfulLine.trim())
    : false;
}

export function shouldRenderMermaidCodeBlock(language: string, code: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  if (isMermaidLanguage(normalizedLanguage)) {
    return true;
  }

  // 模型经常输出未标注语言的 Mermaid fenced code block。
  // 只在纯文本/空语言里做窄首行识别，避免把显式 ts/js/sh 等普通代码误渲染成图表。
  return MERMAID_AUTODETECT_LANGUAGES.has(normalizedLanguage) && isLikelyMermaidCode(code);
}
