/**
 * 快捷键内核的 React 桥接：生效表与展示 label 的唯一 hook 出口。
 *
 * 数据来源是 useSettings 的共享快照（setting.json），因此设置页写入 → update → refresh
 * 后所有消费方自动重算；不引入独立的 store/广播通道。
 */
import { useMemo } from "react";
import { type ShortcutCommandId } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveEffectiveShortcutBindings, type EffectiveShortcutBindings } from "./bindings.js";
import { formatShortcutBindingLabel } from "./label.js";

/** 当前生效的快捷键表（默认 + 用户覆盖合并后的只读视图）。 */
export function useEffectiveShortcutBindings(): EffectiveShortcutBindings {
  const { settings } = useSettings();
  const overrides = settings?.shortcutBindings;
  return useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
}

/**
 * 命令展示 label：生效表首个绑定格式化。
 * 未分配（覆盖为显式空数组）返回空串、不回退默认展示——tooltip 提示的键位必须与实际
 * 生效一致，否则清除后的命令仍提示默认键、按键却不响应（空数组语义的展示侧延伸）。
 * 生效表按命令表全集构建，只有非法 commandId 才会缺键，同样按无键处理。
 */
export function useShortcutCommandLabel(commandId: ShortcutCommandId): string {
  const effective = useEffectiveShortcutBindings();
  const first = effective[commandId]?.[0] ?? "";
  return first === "" ? "" : formatShortcutBindingLabel(first);
}
