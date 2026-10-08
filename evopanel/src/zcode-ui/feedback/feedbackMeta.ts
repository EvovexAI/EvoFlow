import type { FeedbackTicketStatus } from "@zcode/shared";

type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

interface StatusMeta {
  className: string;
  dot: string;
}

export const STATUS_META: Record<FeedbackTicketStatus, StatusMeta> = {
  已提交: {
    className: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  信息不足: {
    className: "text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  已采纳: {
    className: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  答复关闭: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  // 公开反馈接口会把历史「答复关闭」归一为「已归档」返回。
  // 客户端必须同时识别两种终态，否则我的反馈列表渲染状态标记时会拿不到 meta 而崩溃。
  已归档: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已拒绝: {
    className: "text-foreground-subtle",
    dot: "bg-foreground-subtlest",
  },
  开发中: {
    className: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  已解决: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已上线: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

const FEEDBACK_STATUS_MESSAGE_IDS: Record<FeedbackTicketStatus, string> = {
  已提交: "feedback.status.pendingReview",
  信息不足: "feedback.status.needInfo",
  已采纳: "feedback.status.accepted",
  答复关闭: "feedback.status.closedByReply",
  // 后端 closed 仍归一为「已归档」兼容值，但不能把接口内部命名直接暴露给用户。
  // 这里映射到 completed 展示文案，让“我的反馈”列表和详情统一显示为「已完成」。
  已归档: "feedback.status.completed",
  已拒绝: "feedback.status.rejected",
  开发中: "feedback.status.inDevelopment",
  已解决: "feedback.status.resolved",
  已上线: "feedback.status.released",
};

export function formatFeedbackStatusLabel(
  status: FeedbackTicketStatus,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_STATUS_MESSAGE_IDS[status] });
}
