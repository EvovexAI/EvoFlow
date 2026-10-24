import { useEffect, useState, useCallback } from "react";

export type Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "zcode-theme";
const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-zcode-browser-theme-surface";

/**
 * EvoFlow 桥接宿主标记。
 *
 * zcode-ui 在 EvoFlow 里只作为组件库（V4 时间线 / 右侧预览面板 / 代码查看器），
 * 从不独立挂载整个 App。但 ``store/index.ts`` 在模块加载时就会执行 ``applyTheme()``，
 * 把 ``dark`` / ``theme-zai-*`` 写到 ``<html>`` 上。
 *
 * EvoFlow 自身用 ``data-theme`` 管理明暗，同时又有 300+ 条 ``html.dark`` 规则，
 * 于是只要第一次渲染 zcode-ui 组件（例如点开代码查看器），整站就被切成暗色 ——
 * 表现为「打开文件后右侧面板发黑，连知识库都变黑」。
 *
 * 桥接场景下把主题写在容器根 ``.zcode-bridge-root`` 上，不动文档根。
 */
const BRIDGE_ROOT_CLASS = "zcode-bridge-root";

/** EvoFlow 宿主实际明暗（data-theme），桥接场景据此决定 zcode token 明暗。 */
function hostResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "dark";
  return root.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * 是否运行在 EvoFlow 宿主页（而非独立 ZCode 页面）。
 *
 * 注意时序：``store/index.ts`` 在模块加载时就 applyTheme，此时桥接容器可能尚未挂载，
 * 所以不能只靠 querySelector 判空 —— 那样会退回改 ``<html>``，整站变暗。
 * EvoFlow 壳层固定渲染 ``.chat-react-full`` / ``.shell-react-root`` 等宿主类，
 * 任一命中即视为桥接宿主。
 */
const HOST_MARKERS = [
  BRIDGE_ROOT_CLASS,
  "chat-react-full",
  "shell-react-root",
  "react-chat-shell",
];

function isBridgeHost(): boolean {
  if (typeof document === "undefined") return false;
  return HOST_MARKERS.some((cls) => !!document.querySelector(`.${cls}`));
}

/** 取主题类要挂载的目标：桥接 → 各 bridge 容器；独立页 → 文档根。 */
function themeTargets(): Element[] {
  if (typeof document === "undefined") return [];
  if (!isBridgeHost()) return [document.documentElement];
  const roots = Array.from(document.querySelectorAll(`.${BRIDGE_ROOT_CLASS}`));
  // 容器还没挂载（store 先于 React 挂载加载）：什么都不做，等容器出现后由
  // 组件侧调用 applyTheme 补齐；绝不能退回改文档根。
  return roots;
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * 解析主题偏好为实际明暗。
 *
 * 桥接宿主（EvoFlow）里必须跟随宿主 ``data-theme``，不能信 store 里的
 * ``zcode-theme``：那份值是 zcode 独立应用自己的偏好（默认 ``zai-dark``），
 * 与 EvoFlow 当前明暗无关。以前只看 store 值，导致右侧预览件在浅色站里
 * 用暗色代码主题 —— 代码块底色和面板配色对不上，表现为「看得见但看不清」。
 */
export function resolveTheme(theme: Theme, hostResolved?: ResolvedTheme): ResolvedTheme {
  // hostResolved 由 useHostResolvedTheme() 提供：桥接场景下它已经订阅了宿主主题变化，
  // 这里直接用即可，省掉每帧 querySelector 判定。
  if (hostResolved) return hostResolved;
  if (isBridgeHost()) {
    return hostResolvedTheme();
  }
  if (theme === "system") {
    return getSystemTheme();
  }

  return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

/** 最近一次成功应用的主题；桥接容器晚于 store 挂载时用于重放。 */
let lastAppliedTheme: Theme | null = null;

/**
 * 桥接容器挂载后调用：把此前被跳过的主题补写到新容器上。
 * 独立 ZCode 页（写文档根）无需重放，直接返回。
 */
export function replayThemeIntoBridgeRoots(theme: Theme = "zai-dark"): void {
  if (typeof document === "undefined") return;
  if (!isBridgeHost()) return;
  applyTheme(lastAppliedTheme ?? theme);
}

export function applyTheme(theme: Theme) {
  const bridge = isBridgeHost();
  // 桥接宿主跟随 EvoFlow 自己的 data-theme：zcode 默认 zai-dark 会让右侧
  // 代码面板 / 预览件在浅色站里突兀发黑。
  const resolved: ResolvedTheme = bridge ? hostResolvedTheme() : resolveTheme(theme);
  const appliedTheme: Theme = bridge
    ? resolved === "dark"
      ? "zai-dark"
      : "zai-light"
    : theme === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : normalizeThemePreference(theme);
  const targets = themeTargets();
  lastAppliedTheme = theme;
  for (const el of targets) {
    el.classList.toggle("dark", resolved === "dark");
    el.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
    el.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
  }
  // 容器尚未挂载时不缓存 lastAppliedTheme 的成功状态，便于挂载后重放。
  if (targets.length === 0) lastAppliedTheme = null;
  // 浏览器原生主题面（工具栏 / overscroll）只属于独立页，桥接宿主由 EvoFlow 自己管。
  if (targets[0] === document.documentElement) syncBrowserThemeSurface(resolved);
  return targets.length > 0;
}

function isTheme(value: string | null): value is Theme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "system"
  );
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    // 默认主题统一收敛到 Zai dark，避免旧 hook 兜底值和 Zustand store 默认值分叉。
    return isTheme(saved) ? normalizeThemePreference(saved) : "zai-dark";
  });

  const setTheme = useCallback((t: Theme) => {
    const normalizedTheme = normalizeThemePreference(t);
    localStorage.setItem(STORAGE_KEY, normalizedTheme);
    setThemeState(normalizedTheme);
    applyTheme(normalizedTheme);
  }, []);

  // 初始化 + system 模式下监听系统偏好变化
  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return { theme, setTheme } as const;
}

/**
 * 跟随宿主 ``data-theme`` 的明暗值（桥接场景）。
 *
 * 独立的 zcode store 只在自己 setTheme 时重渲染；EvoFlow 切主题是改
 * ``document.documentElement.dataset.theme``，zcode 组件收不到通知，
 * 已挂载的代码块会停在旧配色。这里用 MutationObserver 监听宿主属性，
 * 把变化转成一个可订阅的 hook，避免每个消费点各自观察。
 */
export function useHostResolvedTheme(): ResolvedTheme {
  const [resolved, setResolved] = useState<ResolvedTheme>(() => hostResolvedTheme());

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => setResolved(hostResolvedTheme());
    sync();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(sync);
    // 只关心明暗相关属性：class（兼容 html.dark）与 data-theme（EvoFlow 主用）。
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  return resolved;
}
