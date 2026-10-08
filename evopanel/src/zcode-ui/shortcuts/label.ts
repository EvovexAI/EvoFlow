/**
 * 快捷键展示 label——绑定串 → 平台展示格式化。
 * 从 bindings.ts 拆出（展示层独立于匹配/录制/冲突，且 bindings.ts 有 max-lines 门禁）。
 */
import { parseShortcutBinding } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";

/**
 * 绑定串 → 逐键 token（设置页键帽渲染用）：macOS ["⇧","⌘","P"]、
 * Windows/Linux ["Ctrl","Shift","P"]。label 展示与键帽渲染共用同一 token 序列，
 * 顺序约定只有这一份；每个 token 独立渲染 Kbd 键帽，尺寸才不随内容漂移。
 */
export function formatShortcutBindingLabelParts(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string[] {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return [binding];
  }

  const displayKey =
    parsed.key === "=" ? "+" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  const isApple = isAppleKeyboardPlatform(platformInfo);

  if (isApple) {
    // Apple 惯例修饰键顺序：⌃ ⌥ ⇧ ⌘
    const parts: string[] = [];
    if (parsed.altGr) {
      parts.push("⌃", "⌥");
    } else {
      if (parsed.ctrl) {
        parts.push("⌃");
      }
      if (parsed.alt) {
        parts.push("⌥");
      }
    }
    if (parsed.shift) {
      parts.push("⇧");
    }
    if (parsed.cmdOrCtrl) {
      parts.push("⌘");
    }
    parts.push(displayKey);
    return parts;
  }

  const parts: string[] = [];
  if (parsed.cmdOrCtrl || parsed.ctrl) {
    parts.push("Ctrl");
  }
  if (parsed.altGr) {
    parts.push("Alt");
  } else if (parsed.alt) {
    parts.push("Alt");
  }
  if (parsed.shift) {
    parts.push("Shift");
  }
  parts.push(displayKey);
  return parts;
}

/**
 * 绑定串 → 平台展示 label。macOS 用符号风格（⌘ K、⌃ ⌥ ⇧ ⌘ P），Windows/Linux 用
 * Ctrl+Shift+P 风格；"=" 显示为 "+"（zoom 语义），命名键原样。
 */
export function formatShortcutBindingLabel(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  return formatShortcutBindingLabelParts(binding, platformInfo).join(
    isAppleKeyboardPlatform(platformInfo) ? " " : "+",
  );
}
