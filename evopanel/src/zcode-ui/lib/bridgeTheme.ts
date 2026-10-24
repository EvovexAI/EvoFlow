/**
 * 桥接宿主的暗色判定。
 *
 * zcode-ui 原本用 ``document.documentElement.classList.contains("dark")`` 判断明暗，
 * 但 EvoFlow 宿主自己用 ``data-theme`` 管主题、且不会再往 ``<html>`` 写 ``dark``
 * （写了会让 300+ 条 ``html.dark`` 规则激活，整站变黑）。
 *
 * 所以桥接场景改成「看最近的 .zcode-bridge-root 容器」：
 * - 有容器 → 读容器上的 dark / theme-zai-dark
 * - 独立 ZCode 页（无容器）→ 仍读文档根，行为不变
 */

const BRIDGE_ROOT_CLASS = "zcode-bridge-root";

function nearestBridgeRoot(el: Element | null | undefined): Element | null {
  if (!el || typeof el.closest !== "function") return null;
  return el.closest(`.${BRIDGE_ROOT_CLASS}`);
}

/** @param scope 可选：从该节点向上找容器 */
export function isBridgeDark(scope?: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const root = nearestBridgeRoot(scope) || document.querySelector(`.${BRIDGE_ROOT_CLASS}`);
  const target = root || document.documentElement;
  return (
    target.classList.contains("dark") || target.classList.contains("theme-zai-dark")
  );
}

/**
 * EvoFlow 宿主的实际明暗（``data-theme``）。桥接场景优先跟随宿主，
 * 否则 zcode 默认 ``zai-dark`` 会让右侧面板在浅色站里突兀发黑。
 */
export function hostResolvedTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "dark";
  return root.dataset.theme === "dark" ? "dark" : "light";
}
