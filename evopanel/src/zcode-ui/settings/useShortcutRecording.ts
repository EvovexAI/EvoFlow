import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { recordShortcutBinding, type EffectiveShortcutBindings } from "@/shortcuts/bindings.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

interface UseShortcutRecordingOptions {
  recording: RecordingState | null;
  setRecording: Dispatch<SetStateAction<RecordingState | null>>;
  /** 生效绑定表（Section 已按 overrides resolve）。 */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** 录制态 Backspace：恢复默认（Section 的预检逻辑）。 */
  clearBinding: (commandId: ShortcutCommandId) => void;
  appendBinding: (commandId: ShortcutCommandId, binding: string) => void;
  replaceBindingAt: (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => void;
}

/**
 * 录制态键盘捕获：window keydown capture。Escape 取消；Backspace 恢复默认；
 * 其余交给内核录制器。落盘按 RecordingState.mode 分派：add → 追加一条；replace → 替换
 * bindingIndex 指向的条（null = 未分配占位行录第一条，等价追加）。
 * 同命令物理等价重复在录制入口标红拒绝（add 比全部条目，replace 跳过目标条）。
 */
export function useShortcutRecording({
  recording,
  setRecording,
  effective,
  overrides,
  isDesktop,
  clearBinding,
  appendBinding,
  replaceBindingAt,
}: UseShortcutRecordingOptions): void {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!recording) {
      return;
    }
    function handleRecordingKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      setRecording((current) => {
        if (!current) {
          return current;
        }
        if (event.key === "Escape") {
          return null;
        }
        if (event.key === "Backspace") {
          clearBinding(current.commandId);
          return null;
        }

        const result = recordShortcutBinding(event);
        if (result.kind === "pending") {
          // 残留的冲突/无效提示会让人以为录制器没在听新按键 —— 修饰键按下即刻清空，
          // 保证「冲突后直接重按第二组组合」在视觉上是活的（实际本来就一直监听着）。
          if (
            current.preview === null &&
            current.error === null &&
            current.conflictBinding === null
          ) {
            return current;
          }
          return { ...current, preview: null, error: null, conflictBinding: null };
        }
        if (result.kind === "invalid") {
          return {
            ...current,
            preview: null,
            conflictBinding: null,
            error: intl.formatMessage({
              id:
                result.reason === "no-modifier"
                  ? "settings.shortcuts.invalidNoModifier"
                  : "settings.shortcuts.invalidKey",
            }),
          };
        }

        // 同命令物理等价重复：add 与全部生效条目比；replace 跳过正在替换的
        // 目标条。一个命令挂同一组键没有意义，直接标红拒绝。
        const sameCommandBindings = effective[current.commandId] ?? [];
        const duplicate = sameCommandBindings.some((binding, index) =>
          current.mode === "replace" && index === current.bindingIndex
            ? false
            : isSamePhysicalBinding(binding, result.binding),
        );
        if (duplicate) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            conflictBinding: null,
            error: intl.formatMessage({ id: "settings.shortcuts.duplicateBinding" }),
          };
        }

        // Web 端 menu 通道命令不可配置但默认键仍被根级回退监听消费，按保留键拒绝抢绑
        const conflict = checkShortcutBindingConflict(
          current.commandId,
          result.binding,
          overrides,
          {
            menuChannelReserved: !isDesktop,
          },
        );
        if (conflict) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            // 系统保留键直接拒绝（无确认入口）；app 内命令占用提示占用者并支持二次确认抢绑
            conflictBinding: conflict.kind === "occupied" ? result.binding : null,
            error:
              conflict.kind === "reserved"
                ? intl.formatMessage({ id: "settings.shortcuts.conflictReserved" })
                : intl.formatMessage(
                    { id: "settings.shortcuts.conflictOccupied" },
                    {
                      command:
                        conflict.ownerCommandId !== undefined
                          ? intl.formatMessage({
                              id: `settings.shortcuts.command.${conflict.ownerCommandId}`,
                            })
                          : "",
                    },
                  ),
          };
        }

        if (current.mode === "add" || current.bindingIndex === null) {
          appendBinding(current.commandId, result.binding);
        } else {
          replaceBindingAt(current.commandId, current.bindingIndex, result.binding);
        }
        return null;
      });
    }

    window.addEventListener("keydown", handleRecordingKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordingKeydown, true);
    };
  }, [
    appendBinding,
    clearBinding,
    effective,
    intl,
    isDesktop,
    overrides,
    recording,
    replaceBindingAt,
    setRecording,
  ]);
}
