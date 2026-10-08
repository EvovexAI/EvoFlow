import type { ITheme } from "@xterm/xterm";

function readTerminalColor(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback;
}

/**
 * xterm 的 `css.toColor` 不认 `color-mix()`、`var()`、现代 `rgb(r g b / a)` 新语法。
 * 这里先用隐藏元素让浏览器解析掉 `var()/color-mix()`，再通过 canvas 将结果规范化为
 * xterm 能解析的老式 `rgba(r, g, b, a)` 字符串。
 */
const colorResolverEl: HTMLSpanElement | null =
  typeof document === "undefined" ? null : document.createElement("span");
const colorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) ctx.globalCompositeOperation = "copy";
  return ctx;
})();

function normalizeCssColor(raw: string, fallback: string): string {
  if (!raw || !colorResolverEl || !colorNormalizeCtx || !document.body) {
    return raw || fallback;
  }
  try {
    document.body.appendChild(colorResolverEl);
    colorResolverEl.style.color = "";
    colorResolverEl.style.color = raw;
    const resolved = getComputedStyle(colorResolverEl).color;
    colorNormalizeCtx.fillStyle = "#000";
    colorNormalizeCtx.fillStyle = resolved;
    colorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = colorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  } finally {
    colorResolverEl.remove();
  }
}

const TERMINAL_THEME_TOKENS = {
  background: ["--color-terminal-bg", "#171717"],
  foreground: ["--color-terminal-fg", "#e5e5e5"],
  cursor: ["--color-terminal-cursor", "#e5e5e5"],
  cursorAccent: ["--color-terminal-cursor-accent", "#171717"],
  selectionBackground: ["--color-terminal-selection", "rgba(125, 125, 125, 0.3)"],
  selectionInactiveBackground: ["--color-terminal-selection-inactive", "rgba(125, 125, 125, 0.2)"],
  black: ["--color-terminal-black", "#1f2937"],
  red: ["--color-terminal-red", "#ef4444"],
  green: ["--color-terminal-green", "#22c55e"],
  yellow: ["--color-terminal-yellow", "#eab308"],
  blue: ["--color-terminal-blue", "#3b82f6"],
  magenta: ["--color-terminal-magenta", "#a855f7"],
  cyan: ["--color-terminal-cyan", "#06b6d4"],
  white: ["--color-terminal-white", "#e5e7eb"],
  brightBlack: ["--color-terminal-bright-black", "#6b7280"],
  brightRed: ["--color-terminal-bright-red", "#f87171"],
  brightGreen: ["--color-terminal-bright-green", "#4ade80"],
  brightYellow: ["--color-terminal-bright-yellow", "#facc15"],
  brightBlue: ["--color-terminal-bright-blue", "#60a5fa"],
  brightMagenta: ["--color-terminal-bright-magenta", "#c084fc"],
  brightCyan: ["--color-terminal-bright-cyan", "#22d3ee"],
  brightWhite: ["--color-terminal-bright-white", "#f9fafb"],
} satisfies Partial<Record<keyof ITheme, readonly [string, string]>>;

/** 从 CSS 变量读取 terminal 主题色，跟随 dark/light 切换 */
function getTerminalTheme() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(TERMINAL_THEME_TOKENS).map(([key, [tokenName, fallback]]) => [
      key,
      normalizeCssColor(readTerminalColor(style, tokenName, fallback), fallback),
    ]),
  ) as ITheme;
}

function restrictInheritedTerminalTheme(profileTheme: ITheme | undefined): ITheme | undefined {
  if (!profileTheme) {
    return undefined;
  }

  const inheritedTheme = { ...profileTheme };
  // macOS iTerm2 / Terminal profile 会带回 background / foreground / cursor，
  // 直接覆盖 ZCode 主题 token 会让浅色 app 里出现深色终端块，或光标和当前背景撞色后不可见。
  // 这些基础可读性颜色必须跟随 app 主题；系统 profile 只继承 ANSI、选区等终端细节色。
  delete inheritedTheme.background;
  delete inheritedTheme.foreground;
  delete inheritedTheme.cursor;
  delete inheritedTheme.cursorAccent;

  return Object.keys(inheritedTheme).length > 0 ? inheritedTheme : undefined;
}

export function mergeTerminalTheme(profileTheme: ITheme | undefined): ITheme {
  const appTheme = getTerminalTheme();
  const inheritedTheme = restrictInheritedTerminalTheme(profileTheme);
  return inheritedTheme ? { ...appTheme, ...inheritedTheme } : appTheme;
}
