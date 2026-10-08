// 工具条只展示 Composer 的下一次提交选择；Session 不是存活编辑器的补值来源。
import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
/** 只将结构化选择投影给现有展示控件；不能借旧 Snapshot 或平铺别名填满空选择。 */
export function resolveDraftDisplayedConfig(
  composer: Partial<SessionConfigState>,
): SessionConfigState | null {
  const selection = composer.modelSelection;
  if (!selection) return null;
  return {
    modelSelection: selection,
    provider: selection.providerId,
    model: selection.modelId,
    thought: selection.options?.reasoningLevel ?? "",
    thoughtLevels: [],
    followupMode: composer.followupMode ?? "queue",
    mode: composer.mode ?? "build",
  };
}

export function resolveDraftModelThoughtOption(
  providerId: string,
  modelId: string,
  modelSelectionView: ModelSelectionView | null,
): ZCodeConfigOption | null {
  if (!modelSelectionView) return null;
  return resolveModelThoughtOption({
    modelSelectionView,
    providerId,
    modelId,
  });
}

export function resolveDraftThoughtCurrentValue(params: {
  thought: string | null | undefined;
  thoughtLevels: readonly string[];
}): string {
  const explicitThought = params.thought?.trim() ?? "";
  if (explicitThought && params.thoughtLevels.includes(explicitThought)) {
    return explicitThought;
  }

  // 展示层曾借目录默认值/首项填补空值，让未绑定的旧会话看起来已选好档位。
  // 当前值只认选择结果；新建/主动选模的补全由 Selection 入口负责，恢复空值必须保留。
  return "";
}
