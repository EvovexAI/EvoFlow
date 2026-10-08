import { useCallback, useEffect, useState } from "react";
import { recordShortcutBinding } from "@/shortcuts/bindings.js";

export interface ShortcutKeySearch {
  /** 武装态：等待用户按出组合键。 */
  armed: boolean;
  /** 已捕获的组合（null = 未启用按键过滤）。键盘独占抑制由设置页按 armed 聚合管理。 */
  binding: string | null;
  /** 切换武装态。激活前调用方需先取消行内录制（互斥，见 ShortcutSettingsSection）。 */
  toggle: () => void;
  /** 退出武装态（保留已捕获组合的过滤）。 */
  disarm: () => void;
  /** 清除已捕获组合（过滤回到纯文本）。 */
  clear: () => void;
}

/**
 * 设置页「按组合键搜索」状态机（VSCode 键盘快捷键同款）：
 * Escape 退出武装态；Backspace 清除已捕获组合；其余事件经内核录制器捕获
 * （含平台归一），成功即退出武装态、过滤保留直到手动清除。
 * 裸字母等命令表不可能出现的键（录制器 invalid）静默忽略，等待下一次有效组合。
 * 过滤命中的比较口径是 conflicts.isSamePhysicalBinding（物理等价，win 的
 * Ctrl+m ≡ CmdOrCtrl+m），与冲突检测看到的是同一张表。
 */
export function useShortcutKeySearch(): ShortcutKeySearch {
  const [armed, setArmed] = useState(false);
  const [binding, setBinding] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) {
      return;
    }
    function handleKeySearchKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setArmed(false);
        return;
      }
      if (event.key === "Backspace") {
        setBinding(null);
        return;
      }
      const result = recordShortcutBinding(event);
      if (result.kind !== "binding") {
        return;
      }
      setBinding(result.binding);
      setArmed(false);
    }

    window.addEventListener("keydown", handleKeySearchKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeySearchKeydown, true);
    };
  }, [armed]);

  const toggle = useCallback(() => setArmed((current) => !current), []);
  const disarm = useCallback(() => setArmed(false), []);
  const clear = useCallback(() => setBinding(null), []);

  return { armed, binding, toggle, disarm, clear };
}
