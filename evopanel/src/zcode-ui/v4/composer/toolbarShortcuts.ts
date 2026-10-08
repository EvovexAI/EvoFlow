/**
 * V4 composer 工具条键盘热键（composer parity）。
 *
 * 判定为纯逻辑（无 store / 协议依赖，仅消费 config 目录选项与回调）。
 * 绑定处的回调只修改 Composer：
 * - Ctrl+M        → 打开模型菜单（openRequestKey 递增，ModelConfigSelect 消费）
 * - Ctrl+Shift+M  → 循环下一次 Submission 的模式
 * - Ctrl+T        → 循环下一次 Submission 的思考深度
 *
 * 三条热键已转正为命令表命令（openModelMenu / cycleSessionMode /
 * cycleThoughtLevel，window 通道全局作用域），键位匹配读生效表，可在设置页改绑；
 * 默认键位保持既有行为，零变化。
 */
import { useEffect, useRef } from "react";
import type { ShortcutCommandId, ZCodeConfigOption } from "@zcode/shared";
import {
  isShortcutRecordingActive,
  matchesShortcutBinding,
  type EffectiveShortcutBindings,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";

type ChatToolbarShortcutKey = "m" | "ctrlShiftM" | "t" | null;

/** 按 config category 解析工具条热键槽位。 */
function getChatToolbarShortcutKey(
  category: ZCodeConfigOption["category"],
): ChatToolbarShortcutKey {
  switch (category) {
    case "model":
      return "m";
    case "mode":
      return "ctrlShiftM";
    case "thought_level":
      return "t";
    default:
      return null;
  }
}

/** 计算 select 选项的下一次循环取值（模式循环用）。 */
export function getNextConfigSelectValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  const currentValue = String(option.currentValue);
  const currentIndex = option.options.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % option.options.length;

  return option.options[nextIndex]?.value ?? null;
}

interface ToolbarShortcutKeyboardEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  isComposing: boolean;
}

interface ToolbarShortcutState {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
}

type ToolbarShortcutAction = "openModelMenu" | "cycleSessionMode" | "cycleThoughtLevel";

/**
 * 按生效表解析工具条动作（工具条热键转正为可配置命令）。
 * 键位匹配走内核（命令表 + matcher，修饰精确匹配，与旧 matchesCtrlShortcut 系列
 * 对 "Ctrl+m" / "Ctrl+Shift+m" / "Ctrl+t" 的语义一致）；原 option 归属与 disabled
 * 门控保持不变。事件与生效表由调用方传入，纯函数可独立单测。
 */
function resolveToolbarShortcutAction(
  event: ToolbarShortcutKeyboardEvent,
  effective: EffectiveShortcutBindings,
  {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
  }: ToolbarShortcutState,
): ToolbarShortcutAction | null {
  if (
    !hasAnyOption ||
    toolbarDisabled ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing
  ) {
    return null;
  }

  const candidates: ReadonlyArray<{
    action: ToolbarShortcutAction;
    commandId: ShortcutCommandId;
    expectedKey: ChatToolbarShortcutKey;
    option?: ZCodeConfigOption;
    disabled?: boolean;
  }> = [
    {
      action: "openModelMenu",
      commandId: "openModelMenu",
      expectedKey: "m",
      option: modelOption,
      disabled: modelMenuDisabled,
    },
    {
      action: "cycleSessionMode",
      commandId: "cycleSessionMode",
      expectedKey: "ctrlShiftM",
      option: modeOption,
    },
    {
      action: "cycleThoughtLevel",
      commandId: "cycleThoughtLevel",
      expectedKey: "t",
      option: thoughtOption,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.disabled) {
      continue;
    }
    if (
      !candidate.option ||
      getChatToolbarShortcutKey(candidate.option.category) !== candidate.expectedKey
    ) {
      continue;
    }
    for (const binding of effective[candidate.commandId] ?? []) {
      if (matchesShortcutBinding(event, binding)) {
        return candidate.action;
      }
    }
  }

  return null;
}

export function useToolbarShortcutBindings(params: {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
  onOpenModelMenu: () => void;
  /** Ctrl+Shift+M：参考 thought level，按选项顺序快速切换会话模式，不打开菜单。 */
  onCycleSessionMode: () => void;
  /** Ctrl+T：保留 thought level 快速切换，不受默认 select 菜单交互影响。 */
  onCycleThoughtLevel: () => void;
}) {
  const {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
  } = params;
  // 工具条热键已转正为命令表命令，键位匹配读生效表——设置页改绑后即时生效
  const effectiveBindings = useEffectiveShortcutBindings();
  const effectiveRef = useRef(effectiveBindings);
  effectiveRef.current = effectiveBindings;

  useEffect(() => {
    if (!hasAnyOption) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占。本监听先于录制监听注册（同 capture 阶段），
      // 不短路的话录制期按键预览会真的触发工具条动作。
      if (isShortcutRecordingActive()) {
        return;
      }
      // Windows/Linux 上 Cmd/Ctrl+P 已由 useAppKeyboard 用于「搜索
      // 文件」，与工具栏旧版 ⌃P 同类按键冲突。模式切换改为 Ctrl+Shift+M，仍尊重
      // defaultPrevented，避免与其它捕获阶段快捷键重复处理。
      const state = {
        hasAnyOption,
        toolbarDisabled,
        modelMenuDisabled,
        modelOption,
        modeOption,
        thoughtOption,
      };
      const action = resolveToolbarShortcutAction(event, effectiveRef.current, state);
      if (!action) {
        // 诊断日志与生效表解耦——只在按下的键确实绑定了 openModelMenu 时才打
        // 「未打开模型菜单」（改绑后按旧键不应误打，改绑后的新键失败不再无日志）。
        const openModelMenuBound = (effectiveRef.current.openModelMenu ?? []).some((binding) =>
          matchesShortcutBinding(event, binding),
        );
        if (openModelMenuBound) {
          logger.debug("[V4ComposerToolbar] 模型菜单热键未打开模型菜单", {
            hasModelOption: Boolean(modelOption),
            shortcutKey: getChatToolbarShortcutKey(modelOption?.category),
            modelMenuDisabled,
          });
        }
        return;
      }

      event.preventDefault();
      if (action === "openModelMenu") {
        logger.debug("[V4ComposerToolbar] Ctrl+M 打开模型菜单");
        onOpenModelMenu();
        return;
      }

      if (action === "cycleSessionMode") {
        onCycleSessionMode();
        return;
      }

      if (action === "cycleThoughtLevel") {
        onCycleThoughtLevel();
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modeOption,
    modelOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
    thoughtOption,
  ]);
}
