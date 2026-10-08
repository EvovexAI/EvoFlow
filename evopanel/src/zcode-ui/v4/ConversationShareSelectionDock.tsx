import { memo } from "react";
import { AlertCircle, AlertTriangle, Info, LoaderCircle } from "lucide-react";
import type {
  ConversationShareFailureIssue,
  ConversationSharePreflightResult,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

export type ConversationShareSelectionPreflightState =
  | { status: "idle" | "checking" }
  | ({ status: "ready" | "stale" } & ConversationSharePreflightResult);

// memo 组件的默认对象每次创建会破坏引用稳定性；idle 默认值仅供读取。
const DEFAULT_PREFLIGHT: ConversationShareSelectionPreflightState = { status: "idle" };

interface ConversationShareSelectionDockProps {
  selectedCount: number;
  totalCount: number;
  onCancel: () => void;
  onNext: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  /**
   * 整轮取消选择。只接受 productTurnId：turnOrdinal 是 service 按全部 turnHeader
   * 编号的展示序号，用它反查 UI 的 per-query 列表会取消到别的轮次。
   */
  onDeselectTurn?: (productTurnId: string) => void;
  /** 传输类阻断（网络/RPC 抖动）没有可操作对象，只能整体重新预检。 */
  onRetryPreflight?: () => void;
  preflight?: ConversationShareSelectionPreflightState;
  pending?: boolean;
}

function ConversationShareSelectionDockImpl({
  selectedCount,
  totalCount,
  onCancel,
  onNext,
  onSelectAll,
  onDeselectAll,
  onDeselectTurn,
  onRetryPreflight,
  preflight = DEFAULT_PREFLIGHT,
  pending = false,
}: ConversationShareSelectionDockProps) {
  const { intl, locale } = useZCodeIntl();
  const selectAllState =
    selectedCount === 0 ? false : selectedCount === totalCount ? true : ("indeterminate" as const);
  const bulkActionMessageId =
    totalCount > 0 && selectedCount === totalCount
      ? "conversationShare.partial.deselectAll"
      : "conversationShare.partial.selectAll";
  const blockingIssues = "blockingIssues" in preflight ? preflight.blockingIssues : [];
  const skippableWarnings = "skippableWarnings" in preflight ? preflight.skippableWarnings : [];
  const deferredIssues = "deferredIssues" in preflight ? preflight.deferredIssues : [];
  const checking =
    preflight.status === "checking" ||
    preflight.status === "stale" ||
    (preflight.status === "idle" && selectedCount > 0);
  const statusCount = blockingIssues.length || skippableWarnings.length || deferredIssues.length;
  const statusLabel = checking
    ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
    : blockingIssues.length > 0
      ? intl.formatMessage({ id: "conversationShare.partial.preflightBlocked" })
      : skippableWarnings.length > 0
        ? intl.formatMessage(
            { id: "conversationShare.partial.preflightSkipped" },
            { count: skippableWarnings.length },
          )
        : deferredIssues.length > 0
          ? intl.formatMessage({ id: "conversationShare.partial.preflightDeferred" })
          : "";
  const formatValue = (value: number | undefined, code: string): string => {
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };
  const formatIssueValues = (issue: ConversationShareFailureIssue) => ({
    turnOrdinal: issue.turnOrdinal ?? "—",
    artifactDisplayName: issue.artifactDisplayName ?? "—",
    artifactType: formatConversationShareArtifactType(issue, locale),
    extension: issue.extension ?? "—",
    mimeType: issue.mimeType ?? "—",
    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
    actual: formatValue(issue.actual, issue.code),
    limit: formatValue(issue.limit, issue.code),
    phase: issue.phase ?? "—",
  });

  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    <section
      data-conversation-share-keep-open="selection-dock"
      data-testid="conversation-share-selection-dock"
      className="w-full overflow-hidden rounded-2xl border border-input-border bg-input text-foreground"
    >
      <p
        data-testid="conversation-share-selection-stage-hint"
        className="p-3.5 text-ui-base font-medium leading-5"
      >
        {intl.formatMessage({ id: "conversationShare.partial.selectionStageHint" })}
      </p>
      <div
        data-testid="conversation-share-selection-actions"
        className="flex flex-wrap content-center items-center justify-between gap-3 px-3 pb-3"
      >
        <div
          data-testid="conversation-share-bulk-actions"
          className="flex h-8 shrink-0 items-center gap-3"
        >
          <div data-testid="conversation-share-bulk-toggle" className="flex items-center gap-1">
            <div
              data-testid="conversation-share-bulk-checkbox-slot"
              className="flex size-5 shrink-0 items-center justify-center"
            >
              <Checkbox
                aria-label={intl.formatMessage({ id: bulkActionMessageId })}
                checked={selectAllState}
                disabled={pending || checking || totalCount === 0}
                checkIconStrokeWidth={1.33}
                onCheckedChange={(checked) => {
                  if (checked === true) onSelectAll();
                  else if (checked === false) onDeselectAll();
                }}
                className="size-3.5 rounded-sm [&_[data-slot=checkbox-checked-icon]]:size-2.5 [&_[data-slot=checkbox-indeterminate-icon]]:size-2.5"
              />
            </div>
            {/* 固定宽度会拆开英文标签；按内容宽度保持单行，让操作组整体换行。 */}
            <span
              data-testid="conversation-share-bulk-label"
              className="shrink-0 whitespace-nowrap text-ui-sm leading-4"
            >
              {intl.formatMessage({ id: bulkActionMessageId })}
            </span>
          </div>
          <p role="status" className="shrink-0 text-ui-sm leading-4 tabular-nums">
            {intl.formatMessage(
              { id: "conversationShare.partial.selectionCount" },
              { selected: selectedCount, total: totalCount },
            )}
          </p>
          <span className="flex size-5 shrink-0 items-center justify-center">
            {statusCount > 0 || checking ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="conversation-share-selection-preflight-status"
                    aria-label={statusLabel}
                    title={statusLabel}
                    aria-busy={checking}
                    className="flex size-5 items-center justify-center rounded-md text-foreground-subtle outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                  >
                    {checking ? (
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    ) : blockingIssues.length > 0 ? (
                      <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
                    ) : skippableWarnings.length > 0 ? (
                      <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
                    ) : (
                      <Info className="size-4" aria-hidden="true" />
                    )}
                    <span className="sr-only">{statusLabel}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  collisionPadding={12}
                  data-testid="conversation-share-selection-preflight-popover"
                  className="w-96 max-w-[calc(100vw-1.5rem)] gap-2 p-3"
                >
                  <PopoverTitle className="text-ui-sm font-medium">{statusLabel}</PopoverTitle>
                  {!checking ? (
                    <ul className="grid max-h-56 gap-2 overflow-y-auto text-ui-sm">
                      {[...blockingIssues, ...skippableWarnings, ...deferredIssues]
                        .slice(0, 5)
                        .map((issue, index) => (
                          <li
                            key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                            className="grid gap-1"
                          >
                            <span>
                              {intl.formatMessage(
                                {
                                  id: blockingIssues.includes(issue)
                                    ? resolveConversationShareIssueMessageId(issue)
                                    : resolveConversationShareWarningMessageId(issue),
                                },
                                formatIssueValues(issue),
                              )}
                            </span>
                            {blockingIssues.includes(issue) &&
                            issue.productTurnId !== undefined &&
                            onDeselectTurn ? (
                              <button
                                type="button"
                                className="w-fit text-ui-xs font-medium text-foreground underline underline-offset-2"
                                onClick={() => onDeselectTurn(issue.productTurnId!)}
                              >
                                {intl.formatMessage({ id: "conversationShare.issue.deselectTurn" })}
                              </button>
                            ) : null}
                            {blockingIssues.includes(issue) &&
                            issue.scope === "transport" &&
                            onRetryPreflight ? (
                              <button
                                type="button"
                                data-testid="conversation-share-preflight-retry"
                                className="w-fit text-ui-xs font-medium text-foreground underline underline-offset-2"
                                onClick={onRetryPreflight}
                              >
                                {intl.formatMessage({
                                  id: "conversationShare.issue.retryPreflight",
                                })}
                              </button>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : null}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={onCancel}
            className="px-3"
          >
            {intl.formatMessage({ id: "conversationShare.partial.cancel" })}
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={pending || checking || blockingIssues.length > 0 || selectedCount === 0}
            onClick={onNext}
            data-testid="conversation-share-next"
            className="px-3"
          >
            {/* 预检进度已由状态入口展示，按钮只通过禁用状态阻止提前进入下一步。 */}
            {intl.formatMessage({ id: "conversationShare.partial.next" })}
          </Button>
        </div>
      </div>
    </section>
  );
}

export const ConversationShareSelectionDock = memo(ConversationShareSelectionDockImpl);
