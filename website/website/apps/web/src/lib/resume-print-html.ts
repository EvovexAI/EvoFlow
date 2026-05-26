/** 将 buildResumeMarkdown 产出的受限 Markdown 转为可打印 HTML */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

export function resumeMarkdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const parts: string[] = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      parts.push("</ul>");
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      closeList();
      parts.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      parts.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeList();
      parts.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
    } else if (line.startsWith("#### ")) {
      closeList();
      parts.push(`<h4>${inlineMarkdown(line.slice(5))}</h4>`);
    } else if (line === "---") {
      closeList();
      parts.push("<hr />");
    } else if (/^\d+\.\s/.test(line)) {
      closeList();
      parts.push(`<p class="ol-item">${inlineMarkdown(line)}</p>`);
    } else if (line.startsWith("- ")) {
      if (!listOpen) {
        parts.push("<ul>");
        listOpen = true;
      }
      parts.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      parts.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  return parts.join("\n");
}

export function resumePrintDocumentHtml(bodyHtml: string, locale: string): string {
  const title = locale === "en" ? "Resume" : "个人简历";
  return `<!DOCTYPE html>
<html lang="${locale === "en" ? "en" : "zh-CN"}">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    @page { size: A4; margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    body {
      font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.55;
      color: #1c1917;
      background: #fff;
      margin: 0;
      padding: 0;
    }
    main { max-width: 180mm; margin: 0 auto; }
    h1 { font-size: 20pt; margin: 0 0 0.35em; letter-spacing: -0.02em; }
    h2 {
      font-size: 13pt;
      margin: 1.4em 0 0.5em;
      padding-bottom: 0.25em;
      border-bottom: 1px solid #e7e5e4;
      page-break-after: avoid;
    }
    h3 { font-size: 11pt; margin: 1.1em 0 0.4em; page-break-after: avoid; }
    h4 { font-size: 10.5pt; margin: 0.9em 0 0.35em; page-break-after: avoid; }
    p { margin: 0.45em 0; }
    p.ol-item { margin-left: 0.2em; }
    ul { margin: 0.35em 0 0.6em; padding-left: 1.25em; }
    li { margin: 0.2em 0; }
    hr { border: none; border-top: 1px solid #e7e5e4; margin: 1em 0; }
    a { color: #6d28d9; text-decoration: none; }
    strong { font-weight: 600; }
    em { color: #57534e; }
    h2, h3, h4 { break-inside: avoid; }
    li, p { orphans: 2; widows: 2; }
  </style>
</head>
<body>
  <main>${bodyHtml}</main>
</body>
</html>`;
}
