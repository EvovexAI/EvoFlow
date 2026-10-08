import type { Plugin } from "unified";

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  children?: MarkdownNode[];
  position?: { end?: MarkdownPoint; start?: MarkdownPoint };
  title?: string | null;
  type: string;
  url?: string;
}

// 盘符绝对路径与 UNC。只有命中它们才回原文切片，普通 URL 完全不进本插件的改写面。
// UNC 这里只要求单个前导反斜杠：源码里的 `\\host` 中 `\\` 自身就是一次标点转义，
// 解析后只剩一个反斜杠，要求两个反而会把真正需要还原的 UNC 全部漏掉。
const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;

// CommonMark：链接目标里的 `\X` 只在 X 是 ASCII 标点时才产出 X，其余原样保留。
// 四段区间依次是 !-/、:-@、[-`、{-~，合起来正好是全部 ASCII 标点。
const punctuationEscapePattern = /\\([!-/:-@[-`{-~])/gu;

function unescapeCommonMarkPunctuation(raw: string): string {
  return raw.replace(punctuationEscapePattern, "$1");
}

/**
 * 按节点形态切出 destination 原文。
 *
 * - 行内 `link` / `image`：`[label](dest)` / `![alt](dest)`，取收尾 `)` 之前的片段。
 *   Windows 路径不含 `](`，所以在门禁之内取最后一个分隔符是安全的；这样 label/alt
 *   内部的方括号也不会把切片带偏。
 * - `definition`：`[ref]: dest`，取 `]:` 之后的片段。引用式链接的 URL 由 definition
 *   提供，同一个转义丢失在这里同样成立，必须一起还原。
 */
function extractRawDestination(node: MarkdownNode, slice: string): string | null {
  if (node.type === "definition") {
    const marker = slice.indexOf("]:");
    return marker < 0 ? null : slice.slice(marker + 2).trim();
  }

  if (!slice.endsWith(")")) return null;
  const marker = slice.lastIndexOf("](");
  return marker < 0 ? null : slice.slice(marker + 2, -1).trim();
}

/**
 * 从 VFile 原文里取回该节点未被反转义的 destination 原文。
 *
 * `[x](C:\Users\developer\.zcode\a.png)` 在 remark-parse 阶段就会把 `\.`
 * 当成标点转义吃掉（`\U` `\z` `\w` 这些因为后面不是标点而幸存），mdast 拿到的
 * 是 `C:\Users\developer.zcode\a.png`。丢失发生在解析期，rehype 阶段的既有改写插件
 * 看到的已经是丢失后的字符串，无从还原——所以必须在 remark 阶段做。
 *
 * 只有「原文按 CommonMark 规则反转义后恰好等于 node.url」才认为切片正确且还原
 * 无歧义；否则宁可保持现状，不写入可能错误的路径。
 */
function recoverRawDestination(node: MarkdownNode, source: string): string | null {
  const url = node.url;
  if (typeof url !== "string" || !windowsDestinationPattern.test(url)) return null;
  // 带 title 的链接需要解析引号语法才能定位 destination 结尾，切错就会把引号算进
  // 路径；本场景不出现，直接放弃还原。
  if (node.title !== null && node.title !== undefined) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;

  const raw = extractRawDestination(node, source.slice(start, end));
  // 尖括号形式的转义规则与裸形式不同，同样按不还原处理。
  if (raw === null || !raw || raw.startsWith("<") || raw === url) return null;
  if (unescapeCommonMarkPunctuation(raw) !== url) return null;

  return raw;
}

export const windowsFileLinkEscapeRemarkPlugin: Plugin =
  function windowsFileLinkEscapeRemarkPlugin() {
    return (tree: unknown, file: unknown) => {
      const source = String(file ?? "");
      if (!source) return;

      const visit = (node: MarkdownNode): void => {
        if (node.type === "link" || node.type === "image" || node.type === "definition") {
          const raw = recoverRawDestination(node, source);
          if (raw !== null) node.url = raw;
        }

        node.children?.forEach(visit);
      };

      visit(tree as MarkdownNode);
    };
  };
