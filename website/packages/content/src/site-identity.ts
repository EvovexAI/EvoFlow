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
  sloganZh: "Evovex · AI",
  sloganEn: "Evovex, AI",
  /** 词源 + 一句核心（中文） */
  blurbZh:
    "迭代进化 重塑 AI 新范式",
  blurbEn:
    "Iterative Evolution Reshape the New AI Paradigm",
} as const; 

/** 用于文案展示，例如 `www.evovexai.com` */
export function siteUrlForDisplay(): string {
  return siteIdentity.siteUrl.replace(/^https:\/\//, "");
}
