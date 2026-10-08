import { useEffect, useState } from "react";
import { canRetryDatabaseStartup, type DatabaseStartupState } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";

export function GlobalDatabaseStartupLoading({
  state,
  onRetry,
  onCopy,
  onExit,
}: {
  state: DatabaseStartupState | null;
  onRetry: () => void;
  onCopy: (details: string) => Promise<void>;
  onExit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(Date.now);
  const [copyStatus, setCopyStatus] = useState<"copied" | "copyFailed" | null>(null);
  const failed = state?.phase === "failed";
  const showProgress = state?.migration !== undefined && state.migration.kind !== "none";
  const visible = failed || showProgress;
  useEffect(() => {
    if (failed || !visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [failed, visible]);
  useEffect(() => setCopyStatus(null), [state?.attemptId]);
  const elapsed = Math.max(
    0,
    (failed ? state.updatedAt : Math.max(now, state?.updatedAt ?? now)) - (state?.startedAt ?? now),
  );
  const phase = state?.phase ?? "starting";
  const labelId = startupLabelId(state, visible);
  const label = intl.formatMessage({ id: labelId });
  const errorCode = state?.errorCode ?? "sql_failed";
  const canRetry = state ? canRetryDatabaseStartup(state) : false;
  const copy = async () => {
    try {
      await onCopy(JSON.stringify(state, null, 2));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("copyFailed");
    }
  };
  if (!visible)
    return (
      <RootStartupLoading label={label}>
        <span
          hidden
          data-testid="database-startup-silent"
          data-phase={phase}
          data-database-phase={state?.databasePhase}
        />
      </RootStartupLoading>
    );
  return (
    <RootStartupLoading label={label} busy={!failed}>
      <div
        className="flex w-full max-w-md flex-col items-center gap-3 px-6 text-center"
        data-testid="database-startup-status"
        data-phase={phase}
        data-database-phase={state?.databasePhase}
        data-error-code={state?.errorCode}
      >
        <h1 className="text-ui-lg font-medium" role={failed ? "alert" : undefined}>
          {label}
        </h1>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: failed
              ? state.failedPhase === "starting_services"
                ? "startup.global.servicesFailed"
                : `startup.global.error.${errorCode}`
              : "startup.global.help",
          })}
        </p>
        {!failed && labelId === "startup.global.waiting" ? (
          <p className="text-ui-base">
            {intl.formatMessage({ id: "startup.database.waiting_for_lock" })}
          </p>
        ) : null}
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage(
            { id: "startup.database.elapsed" },
            {
              minutes: Math.floor(elapsed / 60_000),
              seconds: Math.floor(elapsed / 1000) % 60,
            },
          )}
        </p>
        {!failed && elapsed >= 10 * 60_000 ? (
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "startup.database.longRunning" })}
          </p>
        ) : null}
        {failed ? (
          <p className="break-all text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "startup.global.diagnostic" })}: {state.attemptId}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          {canRetry ? (
            <Button data-testid="database-startup-retry" onClick={onRetry}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          ) : null}
          {failed ? (
            <Button variant="outline" onClick={() => void copy()}>
              {intl.formatMessage({ id: "startup.global.copy" })}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onExit}>
            {intl.formatMessage({ id: "startup.global.exit" })}
          </Button>
        </div>
        {copyStatus ? (
          <p role="status" className="text-ui-caption">
            {intl.formatMessage({ id: `startup.global.${copyStatus}` })}
          </p>
        ) : null}
      </div>
    </RootStartupLoading>
  );
}

/** 迁移提示覆盖本次准备；最后一个库之前不展示保存/收尾，避免跨库倒序。 */
function startupLabelId(state: DatabaseStartupState | null, visible: boolean): string {
  if (state?.phase === "failed") return "startup.global.failed";
  if (!visible) return "startup.global.silent";
  if (
    state?.phase === "starting_services" ||
    state?.phase === "ready" ||
    (state?.finalDatabase && state.databasePhase === "ready")
  )
    return "startup.global.finishing";
  const current = state?.currentMigration;
  if (state?.databasePhase === "waiting_for_lock" && current && current.kind !== "none")
    return "startup.global.waiting";
  if (
    state?.finalDatabase &&
    state.databasePhase === "committing" &&
    current &&
    current.executedCount > current.committedCount
  )
    return "startup.global.saving";
  return state?.migration?.kind === "initialize"
    ? "startup.global.initializing"
    : "startup.global.upgrading";
}
