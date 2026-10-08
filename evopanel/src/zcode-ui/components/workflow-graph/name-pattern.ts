import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * 「名字只在运行时才成形」这件事的唯一渲染点。
 *
 * 分析器给的是形状而不是名字：`` agent(`研究员${i + 1}`) `` 折不成 8 个具体名字（那要求把
 * `map` 展开，而 `×N` 存在的意义正是拒绝展开），能拿到的只有模板两端的字面量。投影因此
 * 只搬两个 affix，省略号在**这里**才补上——与匿名兜底文案同一道理（见 lane-name.ts 头部）：
 * 投影是被 memo 的纯函数，文案与字形都该在渲染时成型，投影里只存数据。
 *
 * 省略号（而不是 `*` 或 `${…}`）是刻意的：它读起来仍然是一个名字，不引入新的视觉词汇。
 */
const ELLIPSIS = "…";

/** 一条车道 / 一张卡片的名字形状；形状取自协议，不在这里另立一套。 */
export type NamePattern = NonNullable<WorkflowCausalityGraphData["lanes"][number]["namePattern"]>;

/**
 * `{head: "研究员"}` → `研究员…`，`{tail: "-worker"}` → `…-worker`，两端都有 → `a…b`。
 *
 * 两个 affix 都缺席时返回 undefined 而不是孤零零一个 `…`：分析器不会发这种 pattern，但契约
 * 上 `{}` 是能通过 `.strict()` 的，这里不替它兜着就会在画面上留一个没有意义的省略号。
 */
export function formatNamePattern(pattern: NamePattern | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const head = pattern.head ?? "";
  const tail = pattern.tail ?? "";
  if (head === "" && tail === "") return undefined;
  return `${head}${ELLIPSIS}${tail}`;
}
