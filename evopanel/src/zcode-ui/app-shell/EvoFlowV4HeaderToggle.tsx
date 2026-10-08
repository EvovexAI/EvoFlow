/**
 * EvoFlow v3.5 — zcode 桌面壳顶栏切换条。
 *
 * 用途:给"新版" (v4 shell, zcode 桌面) 加一条浮在 zcode 顶栏上方的细条,
 * 提供"↩ 回到旧版"按钮。点击 = localStorage.removeItem('evoflowV4Shell')
 * + reload,落回 EvoFlow 旧 ChatApp。
 *
 * 之所以不把按钮塞进 zcode 的 `WorkspaceHeader`:
 *   - 不污染 zcode 源码树(后续 v4.5 升级不会被冲突)
 *   - zcode 顶栏在 WorkspaceShellLayout 内部,layout 自己管 drag 区域
 *     和 chrome;EvoFlow 加塞一个按钮会破坏 layout 计算
 *
 * 视觉:
 *   - 顶置 fixed 24px 高横条,半透明深色(zcode 头是深色,搭配不抢戏)
 *   - 左侧标识"🆕 新版 (zcode) — 测试版",右侧"↩ 回到旧版"按钮
 *   - 仅在 `localStorage.evoflowV4Shell === '1'` 时显示
 *
 * 默认展开原因:
 *   - 用户主动点了"体验新版"才进 v4 shell
 *   - 提醒他"这是新壳,有问题能立刻回旧版"是核心 UX
 *   - zcode 顶栏工作区路径里也已经显示"evoflow-default" provider,
 *     用户视觉有冗余,但不冲突
 */
import * as React from "react";

export interface EvoFlowV4HeaderToggleProps {
  onSwitchToOld: () => void;
}

export function EvoFlowV4HeaderToggle({ onSwitchToOld }: EvoFlowV4HeaderToggleProps) {
  const [visible, setVisible] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("evoflowV4Shell") === "1";
    } catch {
      return false;
    }
  });

  // 运行时如果用户在另一个 tab 切回旧版 (localStorage 变化),立即隐藏本条,
  // 避免出现"老 EvoFlow 顶部还浮着新版 toggle 条"的撕裂。
  React.useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== "evoflowV4Shell") return;
      setVisible(ev.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label="EvoFlow 新版切换条"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 32,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 12px",
        background: "linear-gradient(90deg, rgba(91, 95, 239, 0.92), rgba(139, 92, 246, 0.88))",
        color: "#fff",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12.5,
        fontWeight: 500,
        boxShadow: "0 1px 4px rgba(15, 23, 42, 0.18)",
        pointerEvents: "auto",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1px 6px",
            borderRadius: 4,
            background: "rgba(255, 255, 255, 0.18)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          BETA
        </span>
        <span>已切换到 EvoFlow 新版(zcode 桌面风格) — 这是测试版,功能未完整</span>
      </span>
      <button
        type="button"
        onClick={onSwitchToOld}
        title="回到 EvoFlow 旧版主界面"
        aria-label="回到旧版"
        style={{
          appearance: "none",
          border: "1px solid rgba(255, 255, 255, 0.36)",
          background: "rgba(255, 255, 255, 0.08)",
          color: "#fff",
          padding: "3px 12px",
          borderRadius: 6,
          font: "inherit",
          fontWeight: 600,
          cursor: "pointer",
          transition: "background 120ms ease",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255, 255, 255, 0.18)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255, 255, 255, 0.08)";
        }}
      >
        ↩ 回到旧版
      </button>
    </div>
  );
}
