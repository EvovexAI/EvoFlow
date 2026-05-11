/**
 * 官网对外标识：正式域名、联系邮箱、发布主体（与 GitHub 仓库名 EvoFlow 区分）。
 */
export const siteIdentity = {
  /** 规范域名（无末尾斜杠） */
  siteUrl: "https://www.evovexai.com",
  contactEmail: "cloud@evovexai.com",
  publisherName: "Evovex AI",
} as const;

/** EvoVex 品牌定名（简版，供 README / 站尾等复用） */
export const evoVexBrand = {
  name: "EvoVex",
  sloganZh: "EvoVex · AI 进化破局",
  sloganEn: "EvoVex, AI Evolve Beyond Complexity",
  /** 词源 + 一句核心（中文） */
  blurbZh:
    "Evo（Evolve，进化迭代）+ Vex（解构难题）+ AI（推理与编排）；AI 持续进化，智能解构复杂。",
  blurbEn:
    "Evolve + break complexity + AI core: autonomous reasoning and adaptive orchestration beyond complex workloads.",
} as const;

/** 用于文案展示，例如 `www.evovexai.com` */
export function siteUrlForDisplay(): string {
  return siteIdentity.siteUrl.replace(/^https:\/\//, "");
}
