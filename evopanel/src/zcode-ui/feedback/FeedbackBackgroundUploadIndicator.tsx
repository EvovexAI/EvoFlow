import { useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  PauseCircle,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  dismissFeedbackSubmissionJob,
  getFeedbackSubmissionJobsSnapshot,
  subscribeFeedbackSubmissionJobs,
  type FeedbackSubmissionJobSnapshot,
  type FeedbackSubmissionJobStatus,
  type FeedbackSubmissionProgressState,
} from "@/feedback/feedbackSubmissionJob.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

const SUCCESS_DISMISS_DELAY_MS = 5_000;

interface FeedbackBackgroundUploadIndicatorProps {
  feedbackDialogOpen: boolean;
}

interface FeedbackBackgroundUploadIndicatorViewProps {
  status: FeedbackSubmissionJobStatus;
  progress: FeedbackSubmissionProgressState;
  ticketId?: string;
  error?: string;
  onOpen: () => void;
  onContinueUpload: () => void;
  onDismiss: () => void;
  defaultExpanded?: boolean;
}

function shouldOpenExistingFeedbackTicket(
  status: FeedbackSubmissionJobStatus,
  ticketId: string | undefined,
): ticketId is string {
  return Boolean(ticketId) && (status === "success" || status === "error");
}

type FeedbackBackgroundOpenTarget =
  | { kind: "submission"; jobId: string }
  | { kind: "ticket"; ticketId: string };

function getFeedbackBackgroundOpenTarget(
  job: Pick<FeedbackSubmissionJobSnapshot, "id" | "status" | "ticketId">,
): FeedbackBackgroundOpenTarget {
  if (shouldOpenExistingFeedbackTicket(job.status, job.ticketId)) {
    return { kind: "ticket", ticketId: job.ticketId };
  }
  return { kind: "submission", jobId: job.id };
}

export function FeedbackBackgroundUploadIndicator({
  feedbackDialogOpen,
}: FeedbackBackgroundUploadIndicatorProps) {
  const [jobs, setJobs] = useState<FeedbackSubmissionJobSnapshot[]>(() =>
    getFeedbackSubmissionJobsSnapshot(),
  );
  const openSubmissionJob = useFeedbackStore((state) => state.openSubmissionJob);
  const openTickets = useFeedbackStore((state) => state.openTickets);

  useEffect(() => {
    const subscription = subscribeFeedbackSubmissionJobs(setJobs);
    return () => subscription.dispose();
  }, []);

  if (jobs.length === 0) {
    return null;
  }

  if (feedbackDialogOpen) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-[9998] flex max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2 overflow-y-auto sm:right-4 sm:bottom-4">
      {jobs.map((job) => (
        <FeedbackBackgroundUploadJobCard
          key={job.id}
          job={job}
          onOpenSubmissionJob={openSubmissionJob}
          onOpenTicket={openTickets}
        />
      ))}
    </div>
  );
}

function FeedbackBackgroundUploadJobCard({
  job,
  onOpenSubmissionJob,
  onOpenTicket,
}: {
  job: FeedbackSubmissionJobSnapshot;
  onOpenSubmissionJob: (jobId: string) => void;
  onOpenTicket: (ticketId?: string) => void;
}) {
  useEffect(() => {
    if (job.status !== "success") return;
    const timer = window.setTimeout(() => {
      dismissFeedbackSubmissionJob(job.id);
    }, SUCCESS_DISMISS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [job.id, job.status]);

  const handleOpen = () => {
    const target = getFeedbackBackgroundOpenTarget(job);
    logger.debug("[FeedbackBackgroundUploadIndicator] 打开后台反馈卡片", {
      jobId: job.id,
      status: job.status,
      target: target.kind,
    });
    if (target.kind === "ticket") {
      onOpenTicket(target.ticketId);
      dismissFeedbackSubmissionJob(job.id);
      return;
    }
    // 多个上传任务必须按被点击卡片的 jobId 打开，不能再回退到最后一个活动任务。
    onOpenSubmissionJob(target.jobId);
  };

  return (
    <FeedbackBackgroundUploadIndicatorView
      status={job.status}
      progress={job.progress}
      ticketId={job.ticketId}
      error={job.error}
      onOpen={handleOpen}
      onContinueUpload={job.job.continueLogUpload}
      onDismiss={() => dismissFeedbackSubmissionJob(job.id)}
    />
  );
}

function FeedbackBackgroundUploadIndicatorView({
  status,
  progress,
  ticketId,
  error,
  onOpen,
  onContinueUpload,
  onDismiss,
  defaultExpanded = false,
}: FeedbackBackgroundUploadIndicatorViewProps) {
  const { intl } = useZCodeIntl();
  const progressValue = Math.max(0, Math.min(progress.progress ?? 0, 100));
  const isPaused = status === "paused-log";
  const isSuccess = status === "success";
  const isError = status === "error";
  const shouldDefaultExpanded = isPaused || isError;
  const [expanded, setExpanded] = useState(() => shouldDefaultExpanded || defaultExpanded);
  const Icon = isPaused ? PauseCircle : isSuccess ? CheckCircle2 : isError ? AlertCircle : Upload;
  const statusTone = isError
    ? "text-destructive"
    : isSuccess
      ? "text-success"
      : isPaused
        ? "text-warning"
        : "text-primary";

  return (
    <div
      className={cn(
        "pointer-events-auto overflow-hidden rounded-xl border border-popover-border bg-popover text-foreground shadow-lg transition-[width] duration-200",
        expanded ? "w-[min(380px,calc(100vw-1.5rem))]" : "w-[min(320px,calc(100vw-1.5rem))]",
      )}
    >
      <div
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5",
          expanded ? "px-3 py-2.5" : "px-3 py-2",
        )}
      >
        <Icon
          // 后台提示是 toast 语义，状态图标不应再包一层边框底座，
          // 否则会被误读成独立按钮，也会和外层浮层圆角形成重复层级。
          className={cn("mt-0.5 shrink-0", expanded ? "size-4" : "size-3.5", statusTone)}
        />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label={intl.formatMessage({ id: "feedback.background.open" })}
        >
          <div className="min-w-0 truncate text-ui-base font-medium leading-5 text-foreground">
            {intl.formatMessage({ id: "feedback.background.title" })}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-ui-base leading-5 text-foreground-subtle">
              {progress.label}
            </span>
            {progress.progress !== undefined ? (
              <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                {progressValue}%
              </span>
            ) : null}
          </div>
          {expanded ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtlest">
              <span className="min-w-0 truncate">
                {error ||
                  progress.detail ||
                  ticketId ||
                  intl.formatMessage({ id: "feedback.background.defaultDetail" })}
              </span>
              <span className="shrink-0 text-foreground-subtle">
                {intl.formatMessage({ id: "feedback.background.openDetail" })}
              </span>
            </div>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              // 收起态再点“展开”只露出一小截状态条，用户还要二次操作；这里直接打开完整反馈页。
              if (!expanded) {
                onOpen();
                return;
              }
              setExpanded(false);
            }}
            className="shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground"
            aria-label={intl.formatMessage({
              id: expanded ? "feedback.background.collapse" : "feedback.background.open",
            })}
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          </Button>
          {/* paused-log 只能继续上传；如果允许隐藏，会把等待用户动作的后台 job 变成不可恢复的悬挂状态。*/}
          {!isPaused ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onDismiss}
              className="shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground"
              aria-label={intl.formatMessage({ id: "feedback.background.dismiss" })}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className={cn("bg-border", expanded ? "h-1" : "h-0.5")}>
        {progress.indeterminate ? (
          <div className="h-full w-1/3 animate-pulse rounded-r-full bg-primary" />
        ) : (
          <div
            className={cn(
              "h-full rounded-r-full transition-[width] duration-200",
              isError
                ? "bg-destructive"
                : isSuccess
                  ? "bg-success"
                  : isPaused
                    ? "bg-warning"
                    : "bg-primary",
            )}
            style={{ width: `${progressValue}%` }}
          />
        )}
      </div>
      {expanded && isPaused ? (
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface px-3 py-2">
          <Button type="button" size="sm" onClick={onContinueUpload}>
            {intl.formatMessage({ id: "feedback.submit.continueUpload" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
