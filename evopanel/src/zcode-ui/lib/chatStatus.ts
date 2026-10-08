import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView 之前用 displayedStatus 和最后一条消息角色去猜“是否正在思考”，
  // task 明明还处在 creating/restoring/streaming 时，只要消息列表暂时没跟上，shimmer 就会提前消失。
  // 这里直接对齐 task 运行态判断，和顶部 Task StatusBadge 保持同一组“运行中”状态。
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}
