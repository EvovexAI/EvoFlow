import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/** 新工具结果直接设置标记；仅去重已处理结果，不保护期间的手动改选。 */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
  return {
    ...draft,
    lastPlanTransitionId: transition.toolCallId,
    planEnabled: transition.planEnabled,
  };
}
