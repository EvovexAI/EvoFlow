import { CheckCircle2, Copy, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareDisplayWarnings } from "@/store/conversationShareSelectionStore.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

interface ConversationShareSuccessDockProps {
  title: string;
  warnings?: ConversationShareDisplayWarnings | null;
  onOpen: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}

function formatValue(value: number | undefined, code: string): string {
  if (value === undefined) return "—";
  if (code.includes("size") || code === "payload_size_limit") {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }
  return String(value);
}

export function ConversationShareSuccessDock({
  title,
  warnings = null,
  onOpen,
  onCopy,
  onDismiss,
}: ConversationShareSuccessDockProps) {
  const { intl, locale } = useZCodeIntl();

  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    <section
      data-conversation-share-keep-open="success-dock"
      data-testid="conversation-share-success-dock"
      className="w-full overflow-hidden rounded-2xl border border-input-border bg-input text-foreground"
    >
      <div className="flex items-start justify-between gap-3 p-3 pb-2">
        <div
          data-testid="conversation-share-success-status"
          role="status"
          aria-live="polite"
          className="flex min-w-0 items-start gap-2"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "conversationShare.result.title" })}
            </p>
            <p className="mt-1 text-ui-sm leading-4 text-foreground-subtle">
              {intl.formatMessage({ id: "conversationShare.result.description" })}
            </p>
          </div>
        </div>
        <button
          type="button"
          data-testid="conversation-share-success-dismiss"
          aria-label={intl.formatMessage({ id: "conversationShare.result.dismiss" })}
          onClick={onDismiss}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-1 px-4 pb-3">
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "conversationShare.shareTitle" })}
        </span>
        <p
          data-testid="conversation-share-result-title"
          className="min-w-0 truncate text-ui-base text-foreground"
          title={title}
        >
          {title}
        </p>
      </div>

      {warnings && warnings.issues.length > 0 ? (
        <details
          data-testid="conversation-share-success-warning"
          className="mx-4 mb-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-foreground"
        >
          <summary className="cursor-pointer text-ui-sm font-medium text-warning">
            {intl.formatMessage(
              { id: "conversationShare.warning.summary" },
              { count: warnings.issueCount },
            )}
          </summary>
          <ul className="mt-2 grid gap-1.5 text-ui-sm leading-4">
            {warnings.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}>
                {intl.formatMessage(
                  { id: resolveConversationShareWarningMessageId(issue) },
                  {
                    turnOrdinal: issue.turnOrdinal ?? "—",
                    artifactDisplayName: issue.artifactDisplayName ?? "—",
                    artifactType: formatConversationShareArtifactType(issue, locale),
                    extension: issue.extension ?? "—",
                    mimeType: issue.mimeType ?? "—",
                    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                    actual: formatValue(issue.actual, issue.code),
                    limit: formatValue(issue.limit, issue.code),
                    phase: issue.phase ?? "—",
                  },
                )}
              </li>
            ))}
          </ul>
          {warnings.omittedIssueCount ? (
            <p className="mt-2 text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "conversationShare.issue.more" },
                { count: warnings.omittedIssueCount },
              )}
            </p>
          ) : null}
        </details>
      ) : null}

      <div
        data-testid="conversation-share-success-actions"
        className="flex flex-wrap justify-end gap-2 border-t border-input-border px-4 pb-3 pt-2.5"
      >
        <Button
          type="button"
          size="lg"
          variant="outline"
          data-testid="conversation-share-open-browser"
          onClick={onOpen}
        >
          <ExternalLink aria-hidden="true" />
          {intl.formatMessage({ id: "conversationShare.result.openInBrowser" })}
        </Button>
        <Button type="button" size="lg" data-testid="conversation-share-copy-link" onClick={onCopy}>
          <Copy aria-hidden="true" />
          {intl.formatMessage({ id: "conversationShare.copyLink" })}
        </Button>
      </div>
    </section>
  );
}
