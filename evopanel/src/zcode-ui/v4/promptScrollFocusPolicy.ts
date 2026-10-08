import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationComposerSendOptions } from "@/v4/ConversationComposer.js";

interface PromptScrollFocusPolicyInput {
  draftMode: boolean;
  inputRoutingMode: InputRouting["mode"] | null;
  heldQueueDisposition?: ConversationComposerSendOptions["heldQueueDisposition"];
}

/**
 * 新 prompt 只有真正走立即发送路径时才聚焦时间线底部。
 * 原因：enqueue 表达未来意图，用户此刻可能正在阅读上文，入队不能抢走阅读位置；
 * held choice 的两个显式 disposition 都会立即 startNow，因此与普通直发相同。
 */
export function shouldFocusTimelineAfterComposerSend(input: PromptScrollFocusPolicyInput): boolean {
  if (input.draftMode) return true;
  if (input.heldQueueDisposition) return true;
  return input.inputRoutingMode === "startNow";
}
