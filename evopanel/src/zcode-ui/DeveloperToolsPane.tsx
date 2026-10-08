/* oxlint-disable eslint(max-lines) -- 开发者工具面板集中展示 token 表和网络 headers，后续继续扩展时再按区块拆分。 */
import { ActivityIcon, BugIcon, NetworkIcon } from "lucide-react";
import type { SessionDebugNetworkEntry } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";

interface DeveloperToolsPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  enabled?: boolean;
}

function formatNumber(locale: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat(locale).format(value);
}

function formatPercent(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, value));
}

function formatMilliseconds(locale: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} ms`;
}

function formatTimestamp(locale: string, value: string | undefined, fallback: number): string {
  const parsedTimestamp = value ? Date.parse(value) : Number.NaN;
  const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallback;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function networkStatusLabelId(statusType: SessionDebugNetworkEntry["statusType"]): string {
  switch (statusType) {
    case "model_request_started":
      return "developerTools.network.status.started";
    case "model_request_completed":
      return "developerTools.network.status.completed";
    case "model_request_failed":
      return "developerTools.network.status.failed";
    case "model_retry_scheduled":
      return "developerTools.network.status.retry";
    case "model_stream_stalled":
      return "developerTools.network.status.stalled";
  }
}

function HeaderDetails({
  title,
  headers,
  emptyLabel,
}: {
  title: string;
  headers: Record<string, string>;
  emptyLabel: string;
}) {
  const entries = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right));
  return (
    <details className="border-t border-border px-3 py-2">
      <summary className="cursor-default select-none text-ui-xs font-medium text-foreground-subtle">
        {title}
      </summary>
      {entries.length === 0 ? (
        <div className="pt-2 text-ui-xs text-foreground-subtle">{emptyLabel}</div>
      ) : (
        <dl className="grid grid-cols-[minmax(7rem,0.35fr)_minmax(0,1fr)] gap-x-3 gap-y-1 pt-2 text-ui-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="min-w-0 break-all font-mono text-foreground-subtle">{key}</dt>
              <dd className="min-w-0 break-all font-mono text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

export function DeveloperToolsPane({
  workspacePath,
  workspaceIdentity,
  taskId,
  enabled = true,
}: DeveloperToolsPaneProps) {
  const { intl, locale } = useZCodeIntl();
  const debugState = useSessionDebug({ workspacePath, workspaceIdentity, taskId, enabled });
  const networkEntries = [...debugState.networkEntries].reverse();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="developer-tools-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <BugIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "developerTools.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">
        {debugState.error ? (
          <div role="alert" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "developerTools.loadError" })}
          </div>
        ) : null}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "developerTools.tokenSection" })}
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "tokenDebug.summary.requests" })}</span>
            <span className="font-mono text-foreground">
              {formatNumber(locale, debugState.cache?.hitRateRequestCount)}
            </span>
            <span>{intl.formatMessage({ id: "tokenDebug.summary.average" })}</span>
            <span className="font-mono text-foreground">
              {formatPercent(locale, debugState.cache?.hitRate)}
            </span>
            <span>{intl.formatMessage({ id: "tokenDebug.summary.input" })}</span>
            <span className="font-mono text-foreground">
              {formatNumber(locale, debugState.cache?.totalInputTokens)}
            </span>
            <span>{intl.formatMessage({ id: "tokenDebug.summary.cacheRead" })}</span>
            <span className="font-mono text-foreground">
              {formatNumber(locale, debugState.cache?.totalCacheReadTokens)}
            </span>
          </div>
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[38rem] border-collapse text-ui-xs">
              <thead className="sticky top-0 bg-background text-foreground-subtle">
                <tr className="border-b border-border">
                  <th className="px-2 py-1.5 text-left font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.round" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.input" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.output" })}
                  </th>
                  <th
                    className="px-2 py-1.5 text-right font-medium"
                    title={intl.formatMessage({ id: "tokenDebug.tpsDescription" })}
                  >
                    {intl.formatMessage({ id: "tokenDebug.column.tps" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.total" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.reasoning" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.cacheRead" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.cacheWrite" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.hitRate" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {debugState.rounds.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-center text-foreground-subtle" colSpan={9}>
                      {intl.formatMessage({ id: "tokenDebug.empty" })}
                    </td>
                  </tr>
                ) : (
                  debugState.rounds.map((round) => (
                    <tr key={round.eventKey} className="border-b border-border last:border-b-0">
                      <td className="px-2 py-1.5 font-mono text-foreground">
                        {formatNumber(locale, round.requestIndex)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.inputTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.outputTokens)}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right font-mono text-foreground"
                        data-testid="token-debug-tps"
                      >
                        {round.tokensPerSecond === null
                          ? "—"
                          : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                              round.tokensPerSecond,
                            )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.totalTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.reasoningTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.cachedInputTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.cachedWriteInputTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatPercent(locale, round.hitRate)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <NetworkIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "developerTools.networkSection" })}
            </h3>
          </div>
          {networkEntries.length === 0 ? (
            <div className="rounded-md border border-border px-3 py-4 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "developerTools.network.empty" })}
            </div>
          ) : (
            <div className="space-y-2">
              {networkEntries.map((entry) => (
                <div
                  key={entry.eventKey}
                  className="overflow-hidden rounded-md border border-border"
                >
                  <div className="space-y-2 px-3 py-2">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-ui-base font-semibold text-foreground">
                          {intl.formatMessage({ id: networkStatusLabelId(entry.statusType) })}
                        </div>
                        <div className="truncate font-mono text-ui-xs text-foreground-subtle">
                          {entry.requestId ?? entry.eventKey}
                        </div>
                      </div>
                      <div className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                        {formatTimestamp(locale, entry.timestamp, entry.recordedAt)}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
                      <span>{intl.formatMessage({ id: "developerTools.network.model" })}</span>
                      <span className="min-w-0 truncate font-mono text-foreground">
                        {entry.modelId ?? "-"}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.provider" })}</span>
                      <span className="min-w-0 truncate font-mono text-foreground">
                        {entry.providerId ?? entry.providerKind ?? "-"}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.attempt" })}</span>
                      <span className="font-mono text-foreground">
                        {entry.attempt !== undefined && entry.maxAttempts !== undefined
                          ? `${entry.attempt}/${entry.maxAttempts === 0 ? "∞" : entry.maxAttempts}`
                          : "-"}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.http" })}</span>
                      <span className="font-mono text-foreground">
                        {formatNumber(locale, entry.statusCode)}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.duration" })}</span>
                      <span className="font-mono text-foreground">
                        {formatMilliseconds(locale, entry.durationMs ?? entry.idleMs)}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.retryDelay" })}</span>
                      <span className="font-mono text-foreground">
                        {formatMilliseconds(locale, entry.delayMs)}
                      </span>
                    </div>
                    {entry.baseURL ? (
                      <div className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle">
                        {entry.baseURL}
                      </div>
                    ) : null}
                    {entry.message ? (
                      <div className="break-words rounded-md bg-surface px-2 py-1.5 text-ui-xs text-foreground">
                        {entry.message}
                      </div>
                    ) : null}
                  </div>
                  <HeaderDetails
                    title={intl.formatMessage(
                      { id: "developerTools.network.requestHeaders" },
                      { count: formatNumber(locale, entry.requestHeaderCount) },
                    )}
                    headers={entry.requestHeaders}
                    emptyLabel={intl.formatMessage({ id: "developerTools.network.noHeaders" })}
                  />
                  <HeaderDetails
                    title={intl.formatMessage(
                      { id: "developerTools.network.responseHeaders" },
                      { count: formatNumber(locale, entry.responseHeaderCount) },
                    )}
                    headers={entry.responseHeaders}
                    emptyLabel={intl.formatMessage({ id: "developerTools.network.noHeaders" })}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
