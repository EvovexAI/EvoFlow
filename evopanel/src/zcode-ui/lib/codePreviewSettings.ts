/**
 * 代码预览设置的类型与默认值。
 *
 * 独立的中立模块：若定义在 zustand store（@/store/index.ts）里，
 * 纯展示组件（ai-elements / ToolCallBlocks）为了拿类型和默认值就要依赖 store。
 * store 只做 re-export，展示组件改为 props 传入 + 本模块默认值兜底。
 */
import type { BundledTheme } from "shiki";

export interface CodePreviewSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}

export const DEFAULT_CODE_PREVIEW_SETTINGS: CodePreviewSettings = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
  fontSizePx: 12,
};
