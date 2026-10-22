// 表格渲染变体："zcode"（默认，工具条 + 横向虚拟滚动）/ "evoflow"（旧表格壳：
// MD/CSV 复制 + 放大对话框）。仅 V4ZCodeTimeline 提供 "evoflow"——
// 消息区在 V4 面板里用 EvoFlow 自有表格壳渲染表格，其余宿主保持 ZCode 表格。
import { createContext, type ReactNode } from "react";

export const MarkdownTableVariantContext = createContext<"zcode" | "evoflow">("zcode");

export function MarkdownTableVariantProvider({
  value,
  children,
}: {
  value: "zcode" | "evoflow";
  children: ReactNode;
}) {
  return (
    <MarkdownTableVariantContext.Provider value={value}>
      {children}
    </MarkdownTableVariantContext.Provider>
  );
}
