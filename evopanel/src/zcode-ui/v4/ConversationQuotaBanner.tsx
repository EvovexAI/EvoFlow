import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { useEffect, useRef } from "react";
import { InfoIcon, RocketIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  SessionQuotaBannerKind,
  SessionQuotaBannerState,
} from "@/v4/sessionQuotaBannerState.js";

const MESSAGE_IDS: Record<SessionQuotaBannerKind, string> = {
  "model-very-low": "chat.quota.startPlan.modelVeryLow",
  "model-exhausted": "chat.quota.startPlan.modelExhausted",
  "daily-exhausted": "chat.quota.startPlan.dailyExhausted",
  "concurrent-limit": "chat.quota.startPlan.concurrentLimit",
  "provider-limited": "chat.quota.providerLimited",
  "mcp-quota-exhausted": "chat.quota.mcp.quotaExhausted",
  "mcp-plan-required": "chat.quota.mcp.codingPlanRequired",
};

function resolveMessageId(state: SessionQuotaBannerState): string {
  if (state.kind === "model-very-low") {
    return state.quotaPeriod === "daily"
      ? "chat.quota.startPlan.bucketDailyLow"
      : state.quotaPeriod === "one_time"
        ? "chat.quota.startPlan.bucketActivityLow"
        : "chat.quota.startPlan.modelVeryLow";
  }
  if (state.kind === "concurrent-limit") {
    return state.concurrentLimitReason === "retry-exhausted-busy"
      ? "chat.quota.startPlan.concurrentLimit.retryExhausted"
      : "chat.quota.startPlan.concurrentLimit";
  }
  return state.kind ? MESSAGE_IDS[state.kind] : "";
}

function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(value)));
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

export function ConversationQuotaBanner({
  state,
  upgradeActionLabelId = "chat.quota.action.upgrade",
  onUpgrade,
  onDismiss,
  onShown,
}: {
  state: SessionQuotaBannerState;
  upgradeActionLabelId?: string;
  onUpgrade?: () => void;
  onDismiss: () => void;
  onShown?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const bannerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onShown || !state.visible || !bannerRef.current) return;
    // 后台任务也会计算额度状态，只有实际可见时才能消耗该桶周期的一次提醒。
    let intersecting = false;
    const report = () => {
      if (intersecting && document.visibilityState === "visible") onShown();
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      report();
    });
    observer.observe(bannerRef.current);
    document.addEventListener("visibilitychange", report);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", report);
    };
  }, [onShown, state.visible]);
  if (!state.visible || !state.kind) return null;

  const message =
    state.kind === "provider-limited" && state.providerLimitedMessage
      ? state.providerLimitedMessage
      : intl.formatMessage(
          { id: resolveMessageId(state) },
          {
            model: state.modelName ?? "",
            // MCP 提示点名具体 server；服务端那句是英文的，界面文案一律走 i18n。
            server: state.mcpServerName ?? "",
            remaining:
              state.remainingTokens === null
                ? formatTokenCount(null)
                : new Intl.NumberFormat(locale, {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(state.remainingTokens),
            percent: formatPercent(state.remainingPercent),
          },
        );

  return (
    <div
      ref={bannerRef}
      className="mb-3 w-full px-4 max-md:px-2"
      data-testid="v4-session-quota-banner"
    >
      <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground">
          <InfoIcon className="size-4 shrink-0" />
          <div className="min-w-0 break-words">{message}</div>
        </div>
        {onUpgrade ? (
          <CodingPlanEntryButton
            type="button"
            size="sm"
            className="h-auto shrink-0 gap-1.5 rounded-full"
            onClick={onUpgrade}
          >
            <RocketIcon className="size-3.5" />
            {intl.formatMessage({ id: upgradeActionLabelId })}
          </CodingPlanEntryButton>
        ) : null}
        {state.dismissible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label={intl.formatMessage({ id: "common.close" })}
            className="shrink-0 rounded-full text-foreground-subtle hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
