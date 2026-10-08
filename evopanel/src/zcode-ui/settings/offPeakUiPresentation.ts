import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { OffPeakTakeNumberAvailabilityStatus } from "@/store/offPeakTaskStore.js";

export type OffPeakCreateBlockReason = "plan" | "quota" | "unavailable";

/** 闲时创建禁用原因属于长提示，不能沿用通用短 Tooltip 的单行布局。 */
export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME =
  "max-w-[220px] [&>span]:break-words [&>span]:whitespace-normal [&>span]:text-wrap-pretty";

/** 只有服务端成功确认可取号才放行创建，其余资格与依赖状态全部 fail-closed。 */
export function resolveOffPeakCreateBlockReason({
  availabilityStatus,
  canTakeNumber,
  grayEnabled,
  noPlan,
}: {
  availabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  canTakeNumber: boolean | undefined;
  grayEnabled: boolean;
  noPlan: boolean;
}): OffPeakCreateBlockReason | null {
  if (!grayEnabled) return null;
  if (availabilityStatus === "loading" || availabilityStatus === "error") {
    return "unavailable";
  }
  if (noPlan) return "plan";
  if (availabilityStatus !== "ready") return "unavailable";
  return canTakeNumber === true ? null : "quota";
}

/** 将服务端绝对恢复点转换成只包含小时/分钟的本地化剩余时长。 */
export function formatOffPeakRemainingWait(
  nextTakeAt: number,
  now: number,
  intl: IntlInstance,
): string {
  const remainingMs = nextTakeAt - now;
  if (remainingMs <= 0) {
    return intl.formatMessage({
      id: "offPeak.create.remaining.lessThanMinute",
    });
  }

  // 旧 Tooltip 直接展示年月日，文案过长且用户还要自行换算等待时间。
  // 向上取整分钟，避免在仍需等待几十秒时显示 0 分钟或低估服务端恢复点。
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hoursMinutes" }, { hours, minutes });
  }
  if (hours > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hours" }, { hours });
  }
  return intl.formatMessage({ id: "offPeak.create.remaining.minutes" }, { minutes });
}

export type OffPeakStatusIconKind =
  | "moon"
  | "pause"
  | "spinner"
  | "success"
  | "warning"
  | "stopped";

interface OffPeakStatusFooterPresentation {
  icon: OffPeakStatusIconKind;
  className: string;
  labelId: string;
  labelValues?: Record<string, string>;
}

/**
 * 只同步仍保持自动默认值的创建态标题。
 * locale 切换后不能覆盖用户输入、模板草稿或已保存任务标题。
 */
export function resolveLocalizedOffPeakCreateTitle({
  currentTitle,
  hasInitialTitle,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialTitle: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialTitle || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}

/** 闲时卡片状态图标与文案的唯一映射，避免带位次的 paused 被误画成 queued 月亮。 */
export function resolveOffPeakStatusFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation {
  switch (task.status) {
    case "queued":
      return task.queuePosition
        ? {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.badge.queuePosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.status.queued",
          };
    case "paused":
      return task.queuePosition
        ? {
            icon: "pause",
            // Paused 与 Queued 都是仍需关注的排队状态，设计稿使用同一品牌弱强调胶囊。
            className: "text-idle-task",
            labelId: "offPeak.badge.pausedPosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "pause",
            className: "text-idle-task",
            labelId: "offPeak.status.paused",
          };
    case "running":
      return {
        icon: "spinner",
        className: "text-success",
        labelId: "offPeak.status.running",
      };
    case "completed":
      return {
        icon: "success",
        // 完成是无需继续关注的静态终态，success 高亮会让它比活跃任务更抢眼。
        className: "text-foreground-subtle",
        labelId: "offPeak.status.completed",
      };
    case "failed":
      return {
        icon: "warning",
        className: "text-destructive",
        labelId: "offPeak.status.failed",
      };
    case "cancelled":
      return {
        icon: "stopped",
        className: "text-foreground-subtle",
        labelId: "offPeak.status.cancelled",
      };
  }
}

/** 终态任务不会再被调度，不能把历史选择失效显示成当前待修复错误。 */
export function shouldShowOffPeakModelSelectionIssue(
  status: Pick<ZCodeOffPeakTask, "status">["status"],
): boolean {
  return status === "queued" || status === "paused" || status === "running";
}

/**
 * 失败任务仍保留服务端返回的排队位次时，单独渲染弱化位次。
 * 主状态映射只能返回一个 footer；失败状态需额外保留队列上下文，避免被 Failure 覆盖。
 */
export function resolveFailedOffPeakQueueFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation | null {
  if (task.status !== "failed" || task.queuePosition === undefined) return null;
  return {
    icon: "moon",
    className: "text-idle-task",
    labelId: "offPeak.badge.queuePosition",
    labelValues: { position: String(task.queuePosition) },
  };
}
