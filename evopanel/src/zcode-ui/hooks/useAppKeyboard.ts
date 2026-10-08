import { useEffect, useRef } from "react";
import { SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";

/** window 通道快捷键的处理器表：命令 ID → 回调；null/缺失表示该命令当前不可用。 */
type AppKeyboardHandlers = Partial<Record<ShortcutCommandId, (() => void) | null>>;

/**
 * 全局键盘分发薄壳：window keydown capture → 内核通用匹配 → 命令 handler。
 *
 * - 键位知识全部在 shortcuts 内核（生效表 + 匹配器），本 hook 不认识任何具体按键；
 * - handler 为 null/缺失时不 preventDefault（功能不可用时放行浏览器默认行为，如历史导航）；
 * - 交互说明：capture 阶段拦截，保证焦点落在普通页面区域时不会被浏览器或桌面壳默认行为抢走；
 * - 监听只挂一次，handlers/生效表经 ref 透传 —— 设置页改键后下一次按键即按新键位分发。
 */
export function useAppKeyboard(handlers: AppKeyboardHandlers) {
  const effective = useEffectiveShortcutBindings();
  const stateRef = useRef({ handlers, effective });
  stateRef.current = { handlers, effective };

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) {
        return;
      }
      // 录制态短路：录制监听注册晚于本监听（同阶段先注册先执行），不短路的话
      // 录制按下的组合会先触发原命令，改键永远不成功（见 setShortcutRecordingActive 注释）。
      if (isShortcutRecordingActive()) {
        return;
      }

      const { handlers: currentHandlers, effective: currentEffective } = stateRef.current;
      // 纯 Shift+可打印键绑定（如 Shift+f）与「输入大写字母」是同一物理事件，
      // 焦点在可编辑元素（聊天输入框/搜索框/终端）时跳过这类绑定，否则用户打不出对应大写字母。
      const editableTarget = isEditableShortcutEventTarget(event.target);
      for (const entry of SHORTCUT_COMMANDS) {
        if (entry.channel !== "window") {
          continue;
        }
        // composer 作用域命令由输入框的 Lexical 插件消费，全局分发零感知
        if (entry.scope === "composer") {
          continue;
        }
        const handler = currentHandlers[entry.id];
        if (!handler) {
          continue;
        }
        const bindings = currentEffective[entry.id];
        if (!bindings || bindings.length === 0) {
          continue;
        }
        for (const binding of bindings) {
          if (editableTarget && isShiftOnlyPrintableBinding(binding)) {
            continue;
          }
          if (matchesShortcutBinding(event, binding)) {
            event.preventDefault();
            handler();
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, []);
}
