import type { FeedbackSubmissionProgressState } from "@/feedback/feedbackSubmissionJob.js";

export function SubmitProgressView({
  progress,
  processingLabel,
}: {
  progress: FeedbackSubmissionProgressState;
  processingLabel: string;
}) {
  const progressValue = Math.max(0, Math.min(progress.progress ?? 0, 100));
  return (
    <div className="w-full rounded-lg border border-border bg-card px-3 py-2" aria-live="polite">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs leading-4">
        <span className="font-medium text-foreground">{progress.label}</span>
        <span className="shrink-0 font-mono text-foreground-subtle">
          {progress.progress !== undefined ? `${progressValue}%` : processingLabel}
        </span>
        {progress.detail ? (
          <span className="min-w-[160px] flex-1 font-mono text-foreground-subtlest">
            {progress.detail}
          </span>
        ) : null}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-border">
        {progress.indeterminate ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${progressValue}%` }}
          />
        )}
      </div>
    </div>
  );
}
