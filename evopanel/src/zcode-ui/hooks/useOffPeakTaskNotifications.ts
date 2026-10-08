import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { ZCodeOffPeakTaskStatus } from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";

// 闲时任务系统通知（通知；权威路径应用内、通知点击跳 session；样式待设计补）。
// 全局挂载（App 根，每窗口一份）：main 进程 dispatchTaskNotification 按 (status:taskId) 3s 去重，
// 多窗口重复触发只显示一条，故无需选主。轮询独立于 host sync（renderer 无 sqlite 访问）。

const OFF_PEAK_NOTIFICATION_POLL_MS = 30_000;

/** Off-Peak 聚合只通知终态；permission/elicitation 由普通 session 通知链路负责，避免重复通知。 */
function notifiableStatus(status: ZCodeOffPeakTaskStatus): "completed" | "failed" | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return null;
}

export function useOffPeakTaskNotifications(params: {
  offPeakTaskService: IOffPeakTaskService;
  platform: Pick<IPlatformService, "showTaskNotification"> | null | undefined;
  enabled: boolean;
  formatMessage: IntlInstance["formatMessage"];
}): void {
  const { offPeakTaskService, platform, enabled, formatMessage } = params;
  // offPeakTaskId → 上次见到的状态；只在"新→需通知状态"的边沿触发，避免每轮重发。
  const seenStatusRef = useRef(new Map<string, ZCodeOffPeakTaskStatus>());

  useEffect(() => {
    if (!enabled || !platform) return;
    let disposed = false;

    const tick = async () => {
      try {
        const tasks = await offPeakTaskService.list();
        if (disposed) return;
        const seen = seenStatusRef.current;
        const alive = new Set<string>();
        for (const task of tasks) {
          alive.add(task.offPeakTaskId);
          const previous = seen.get(task.offPeakTaskId);
          seen.set(task.offPeakTaskId, task.status);
          if (previous === task.status) continue;
          const kind = notifiableStatus(task.status);
          if (!kind) continue;
          // 首次见到即终态（如刚打开 app 时的存量）不补发历史通知，只在真实转换时通知。
          if (previous === undefined) continue;
          const titleKey =
            kind === "completed" ? "offPeak.notify.completed.title" : "offPeak.notify.failed.title";
          const bodyKey =
            kind === "completed" ? "offPeak.notify.completed.body" : "offPeak.notify.failed.body";
          try {
            platform.showTaskNotification({
              // 点击跳转用 run session 的 taskId（无 session 的终态跳不了，taskId 兜底用 offPeakTaskId）。
              taskId: task.sessionId ?? task.conversationId ?? task.offPeakTaskId,
              status: kind === "completed" ? "completed" : "failed",
              title: formatMessage({ id: titleKey }),
              body: formatMessage({ id: bodyKey }, { title: task.title || task.prompt }),
            });
          } catch (error) {
            logger.warn("[off-peak] notification dispatch failed", error);
          }
        }
        // 清理已消失（删除）的任务，防 Map 无限增长。
        for (const id of seen.keys()) {
          if (!alive.has(id)) seen.delete(id);
        }
      } catch (error) {
        logger.warn("[off-peak] notification poll failed", error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), OFF_PEAK_NOTIFICATION_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled, platform, offPeakTaskService, formatMessage]);
}
