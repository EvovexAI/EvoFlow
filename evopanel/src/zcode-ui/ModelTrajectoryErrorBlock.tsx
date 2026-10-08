import { CircleAlertIcon } from "lucide-react";

export function ModelTrajectoryErrorBlock({
  error,
}: {
  error: { name: string; message: string; stack?: string };
}) {
  return (
    <div
      data-trajectory-call-error=""
      className="col-span-full flex items-start gap-2 rounded-lg bg-destructive/10 px-2 py-1.5"
    >
      <CircleAlertIcon
        data-trajectory-call-error-icon=""
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      <div className="min-w-0 flex-1">
        <p className="text-ui-base font-medium text-destructive">
          {error.name}: {error.message}
        </p>
        {error.stack ? (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-destructive/80">
            {error.stack}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
