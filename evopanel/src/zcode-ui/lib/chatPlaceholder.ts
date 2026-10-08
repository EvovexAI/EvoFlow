type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
}): ChatPlaceholderMessageKey {
  const { compactNewTask = false, hasHistoryMessages, isTaskProcessing } = options;

  // 按语义分流：
  // 1) 无历史 -> newTask
  // 2) 有历史且空闲 -> followUpAsk
  // 3) 有历史且处理中 -> followUpQueue
  if (!hasHistoryMessages) {
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return isTaskProcessing ? "chat.placeholder.followUpQueue" : "chat.placeholder.followUpAsk";
}
