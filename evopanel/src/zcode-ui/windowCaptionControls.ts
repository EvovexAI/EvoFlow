import type { CSSProperties } from "react";

const WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX = 136;
export const WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR =
  "var(--windows-caption-controls-right-inset)";

type WindowsCaptionControlsStyle = CSSProperties & {
  "--windows-caption-controls-right-inset": string;
  "--windows-caption-control-width": string;
};

export function createWindowsCaptionControlsStyle(
  _fallbackRightInsetPx = WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX,
): WindowsCaptionControlsStyle {
  return {
    // 自绘按钮随页面缩放；WCO 关闭后的几何仍可能返回整个窗口宽度，不能再用于计算安全区。
    "--windows-caption-controls-right-inset": `${WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX}px`,
    // 设置页旧 caption 菜单仍复用三等分宽度；紧凑窗控本身使用固定 28px。
    "--windows-caption-control-width": "calc(var(--windows-caption-controls-right-inset) / 3)",
  };
}

// 该样式只能由 Windows 标题栏路径显式启用，避免影响 Linux 自绘标题栏原有间距。
export const WINDOWS_CAPTION_CONTROL_CLASS =
  "h-full w-[var(--windows-caption-control-width,46px)] rounded-none";
