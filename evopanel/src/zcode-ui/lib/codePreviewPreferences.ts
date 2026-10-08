import type { BundledTheme } from "shiki";
import type { CodePreviewSettings } from "@/store/index.js";

interface CodePreviewThemeOption {
  value: BundledTheme;
  label: string;
}

export const CODE_PREVIEW_THEME_OPTIONS: CodePreviewThemeOption[] = [
  { value: "github-light", label: "GitHub Light" },
  { value: "github-dark", label: "GitHub Dark" },
  { value: "vitesse-light", label: "Vitesse Light" },
  { value: "vitesse-dark", label: "Vitesse Dark" },
  { value: "min-light", label: "Minimal Light" },
  { value: "min-dark", label: "Minimal Dark" },
  { value: "github-light-high-contrast", label: "GitHub HC Light" },
  { value: "github-dark-high-contrast", label: "GitHub HC Dark" },
  { value: "catppuccin-latte", label: "Catppuccin Latte" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
];

const DARK_CODE_PREVIEW_THEMES: readonly BundledTheme[] = [
  "github-dark",
  "vitesse-dark",
  "min-dark",
  "github-dark-high-contrast",
  "catppuccin-mocha",
];

export function isDarkCodePreviewTheme(theme: BundledTheme): boolean {
  // 代码主题的明暗语义必须跟随设置页支持的显式选项，不能用主题名正则猜测。
  return DARK_CODE_PREVIEW_THEMES.includes(theme);
}

export const SETTINGS_PREVIEW_CODE = `const themePreview: ThemeConfig = {
  surface: "sidebar",
  accent: "#339CFF",
  contrast: 45,
};`;

export function getCodePreviewTheme(
  mode: "light" | "dark",
  settings: CodePreviewSettings,
): BundledTheme {
  return mode === "dark" ? settings.darkTheme : settings.lightTheme;
}
