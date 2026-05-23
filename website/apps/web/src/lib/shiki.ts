export type ShikiHighlighter = {
  codeToHtml: (code: string, options: { lang: string; theme?: string; transformers?: unknown[] }) => string;
};

let highlighterPromise: Promise<ShikiHighlighter> | null = null;

const SHIKI_LANGS = [
  "html", "css", "scss", "json", "jsonc",
  "markdown", "md",
  "typescript", "tsx", "javascript", "jsx",
  "python", "py",
  "bash", "shell", "sh",
  "sql", "yaml", "yml",
  "diff", "plaintext",
  "rust", "go", "java", "c", "cpp",
  "xml", "graphql", "toml", "ini",
  "dockerfile",
] as const;

export function mapToShikiLang(lang: string): string {
  const n = lang.toLowerCase();
  if (n === "typescript" || n === "ts") return "typescript";
  if (n === "tsx") return "tsx";
  if (n === "javascript" || n === "js") return "javascript";
  if (n === "jsx") return "jsx";
  if (n === "markdown" || n === "md") return "markdown";
  if (n === "python" || n === "py") return "python";
  if (n === "bash" || n === "shell" || n === "sh" || n === "zsh") return "bash";
  if (n === "yaml" || n === "yml") return "yaml";
  if (n === "scss" || n === "sass") return "scss";
  if (n === "cpp" || n === "c++") return "cpp";
  if (["html", "css", "json", "jsonc", "diff", "sql", "rust", "go", "java", "c", "xml", "graphql", "toml", "ini", "dockerfile"].includes(n)) return n;
  if (n === "text" || n === "plain" || n === "txt") return "plaintext";
  return n || "plaintext";
}

export function createLineNumberTransformer(): unknown {
  return {
    name: "line-number",
    line(node: { properties?: Record<string, unknown> }, line: number) {
      if (node.properties) {
        node.properties["data-line"] = String(line);
        const prev = (node.properties.className as string[]) || [];
        node.properties.className = [...prev, "shiki-line"];
      }
    },
  };
}

export function getHighlighter(): Promise<ShikiHighlighter> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const { createHighlighter } = await import("shiki");
    const highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: [...SHIKI_LANGS],
    });
    return highlighter as unknown as ShikiHighlighter;
  })();
  return highlighterPromise;
}
