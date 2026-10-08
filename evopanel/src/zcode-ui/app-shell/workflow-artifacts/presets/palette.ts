/**
 * 预置图表的序列调色板与**次级编码**。
 *
 * 颜色直接复用设计系统里既有的 `--color-usage-chart-1..6`（DESIGN.md「Color Usage Rules」：
 * 用语义 token，不自造一次性色值）。这套 token 在四套主题（light / dark / zai-light / zai-dark）
 * 里都有定义，因此图表天然跟着主题走，组件里不需要任何主题分支。
 *
 * **为什么每条序列还要带一个虚线样式**：这 6 个色槽在色觉障碍（protan / deutan）下不是两两可分的
 * ——把它们喂给 dataviz 的调色板校验脚本，紫↔蓝、橙↔红两对在 all-pairs 下低于 ΔE 8 的门槛。
 * 校验脚本对这种情况给出的唯一合法出路是「配次级编码」：所以这里每条序列除了颜色还固定带一种
 * 线型，图例与直接标注也一律在场，身份从不只由颜色承担（DESIGN.md「Use semantic status colors
 * together with readable text, never by color alone」的同一条精神）。调色板本身是仓库级资产。
 */

/** 色槽数 = 一张图最多画几条序列；超出的 y 字段不画（宁可少画也不循环复用颜色）。 */
export const ARTIFACT_CHART_MAX_SERIES = 6;

/** 第 index 条序列的颜色（CSS 变量引用，主题切换即时生效）。 */
export function artifactSeriesColorVar(index: number): string {
  return `var(--color-usage-chart-${(index % ARTIFACT_CHART_MAX_SERIES) + 1})`;
}

const SERIES_DASH: readonly (string | undefined)[] = [
  undefined,
  "6 3",
  "2 3",
  "9 3 2 3",
  "1 3",
  "12 4",
];

/** 第 index 条序列的线型；第一条是实线。 */
export function artifactSeriesDash(index: number): string | undefined {
  return SERIES_DASH[index % SERIES_DASH.length];
}

const SERIES_SYMBOL = ["circle", "cross", "diamond", "square", "triangle", "star"] as const;

/** 散点图的点形；与线型同理，是颜色之外的第二条身份线索。 */
export function artifactSeriesSymbol(index: number): (typeof SERIES_SYMBOL)[number] {
  return SERIES_SYMBOL[index % SERIES_SYMBOL.length]!;
}
