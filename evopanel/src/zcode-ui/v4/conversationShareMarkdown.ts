import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
  type AssistantTextRange,
} from "@/lib/assistantDirectiveParser.js";
import { extractZCodeFileCitationDirectives } from "@/lib/zcodeFileCitation.js";

function resolveCitationFileName(path: string): string {
  const normalizedPath = path.trim().replaceAll("\\", "/");
  return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/**
 * `![alt](dest ...)` 的图片语法。dest 允许 `<...>` 包裹（可含空格）或裸 URL；
 * 尾部可选 title 原样保留 —— 只去掉开头那个 `!`，其余字节不动。
 */
const markdownImagePattern = /!(\[[^\]]*\]\((?:<[^>\n]*>|[^)\s]*)(?:[^)\n]*)\))/gu;

/** 会让访客浏览器向第三方发起请求的图片地址：绝对 http(s) 与协议相对 `//host`。 */
function isRemoteImageDestination(destination: string): boolean {
  const trimmed = destination.trim().replace(/^<|>$/gu, "");
  return /^(?:https?:)?\/\//iu.test(trimmed);
}

function readImageDestination(imageSyntax: string): string {
  // imageSyntax 形如 `[alt](dest "title")`，取第一个 `(` 之后到首个空白/结尾之间的部分。
  const open = imageSyntax.indexOf("(");
  const inner = imageSyntax.slice(open + 1, -1);
  if (inner.startsWith("<")) return inner.slice(0, inner.indexOf(">") + 1);
  const whitespace = inner.search(/\s/u);
  return whitespace < 0 ? inner : inner.slice(0, whitespace);
}

/**
 * 把远程图片降级为普通链接。
 *
 * 公开分享页（ConversationShareReadonlyTimeline）不传 workspacePath /
 * sessionId / readAttachment，MarkdownImage 会 fallback 到 `displaySrc = resolvedSrc`
 * 并渲染 `<img src={远程} loading="lazy">`，于是任意匿名访客一打开页面就自动向
 * 发布者指定的第三方发起请求，泄露 IP / UA / Referer —— 等价于发布者可控的 tracking
 * pixel。这个版本的 streamdown 没有 allowedImagePrefixes 可用（linkSafety 也已关闭），
 * 所以在唯一的公开投影 choke point 上剥离：`![alt](url)` → `[alt](url)`，
 * 不发自动请求、信息不丢、访客点击才加载，且对已发布的旧分享立即生效。
 * 只处理 http(s) 与协议相对地址：data: 不走网络，相对路径落在自身 origin。
 */
function degradeRemoteImages(
  markdown: string,
  protectedRanges: readonly AssistantTextRange[],
): string {
  const matches = [...markdown.matchAll(markdownImagePattern)].filter(
    (match) =>
      !overlapsAssistantTextRanges(match.index, match.index + match[0].length, protectedRanges) &&
      isRemoteImageDestination(readImageDestination(match[1]!)),
  );
  let result = markdown;
  // 从后往前替换，避免前面的改写让后面的 index 失效。
  for (const match of matches.reverse()) {
    result = `${result.slice(0, match.index)}${match[1]!}${result.slice(match.index + match[0].length)}`;
  }
  return result;
}

/**
 * 分享正文不能把本地 citation directive 直接交给 MessageResponse：它既会暴露路径，
 * 也会在拥有 workspace authority 的情况下被解释成文件操作。公开投影只保留唯一匹配
 * 的 artifact display name；代码块里的协议示例由 directive parser 保护并保持原文。
 *
 * 同时剥离远程图片的自动加载，见 degradeRemoteImages。
 */
export function normalizeConversationShareMarkdown(
  markdown: string,
  artifactNames: ReadonlyMap<string, string> = new Map(),
): string {
  const protectedRanges = findMarkdownCodeRanges(markdown);
  const directives = extractZCodeFileCitationDirectives(markdown).filter(
    (directive) => !overlapsAssistantTextRanges(directive.start, directive.end, protectedRanges),
  );

  let result = markdown;
  for (const directive of [...directives].reverse()) {
    const fileName = directive.path ? resolveCitationFileName(directive.path) : "";
    const candidates = [...artifactNames.values()].filter(
      (displayName) => displayName.trim().toLowerCase() === fileName.toLowerCase(),
    );
    const replacement = candidates.length === 1 ? candidates[0]!.trim() : "";
    result = `${result.slice(0, directive.start)}${replacement}${result.slice(directive.end)}`;
  }
  // citation 剥离只会缩短正文且不产生新的图片语法，但代码围栏范围可能左移，
  // 因此对改写后的正文重新求一次保护区间，再做图片降级。
  return degradeRemoteImages(result, findMarkdownCodeRanges(result));
}
