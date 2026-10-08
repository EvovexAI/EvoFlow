import { GiftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  CodingPlanQuotaResetDialog,
  formatCodingPlanQuotaResetCountdown,
  type CodingPlanQuotaResetDialogConfig,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type { CodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";

function getRemainingSeconds(expiresAt: number | null): number {
  if (expiresAt == null) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
}

export function CodingPlanQuotaResetOpportunity({
  count,
  dialog,
  dialogOpen,
  expiresAt,
  onDialogOpenChange,
  placement = "tooltip",
  visible,
}: {
  count: number;
  dialog?: CodingPlanQuotaResetDialogConfig;
  dialogOpen?: boolean;
  expiresAt: number | null;
  onDialogOpenChange?: (open: boolean) => void;
  placement?: "inline" | "tooltip";
  visible: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [remainingSeconds, setRemainingSeconds] = useState(() => getRemainingSeconds(expiresAt));
  const [uncontrolledDialogOpen, setUncontrolledDialogOpen] = useState(false);
  const resolvedDialogOpen = dialogOpen ?? uncontrolledDialogOpen;
  const setDialogOpen = onDialogOpenChange ?? setUncontrolledDialogOpen;
  // 弹框在 dialog 分支内常驻挂载，机会数从多降到单/零都不会提前卸载成功动画中的 Dialog；
  // 这里只决定文案与倒计时形态：多机会显示「获得 N 次」，单机会保留原文案 + 倒计时。
  const hasMultipleOpportunities = count > 1;

  useEffect(() => {
    setRemainingSeconds(getRemainingSeconds(expiresAt));
    if (!visible || hasMultipleOpportunities) {
      return;
    }
    const timer = window.setInterval(() => {
      setRemainingSeconds(getRemainingSeconds(expiresAt));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt, hasMultipleOpportunities, visible]);

  const opportunityLabel = intl.formatMessage(
    { id: "codingPlan.quotaReset.opportunity" },
    { count },
  );
  const countdownLabel = intl.formatMessage(
    { id: "codingPlan.quotaReset.expiresIn" },
    { time: formatCodingPlanQuotaResetCountdown(remainingSeconds, intl.formatMessage) },
  );
  // 多机会入口复用了不带参数的固定文案，用户无法直接确认当前可用次数。
  // 这里让可见文案与 aria-label 共用同一个动态结果，避免视觉和无障碍名称再次不一致。
  const openDialogLabel = intl.formatMessage({ id: "codingPlan.quotaReset.openDialog" }, { count });
  const label = hasMultipleOpportunities ? openDialogLabel : opportunityLabel;
  // 弹框存活期间徽标不收起：单机会在弹框打开后过期时，入口不能从按钮位置塌缩。
  const effectiveVisible =
    visible && (hasMultipleOpportunities || resolvedDialogOpen || remainingSeconds > 0);
  const commonClassName = [
    "inline-flex h-5 shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm font-medium text-interaction-confirmation-foreground",
    "transition-[max-width,opacity,padding,background-color] duration-200 motion-reduce:transition-none",
    effectiveVisible ? "max-w-64 opacity-100" : "pointer-events-none max-w-0 px-0 opacity-0",
  ].join(" ");
  const badgeBody = (
    <>
      <span className="inline-flex min-w-0 items-center gap-1">
        <GiftIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      {placement === "inline" && !hasMultipleOpportunities ? (
        <span className="ml-2 shrink-0 font-normal text-interaction-confirmation-foreground/80 tabular-nums">
          {countdownLabel}
        </span>
      ) : null}
    </>
  );

  if (dialog) {
    // 单机会同样可以点开重置弹框；文案与倒计时保持单机会形态，仅交互升级为按钮。
    const button = (
      <button
        type="button"
        aria-label={label}
        aria-hidden={!effectiveVisible}
        className={`${commonClassName} hover:bg-interaction-confirmation-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
        data-reset-opportunity="true"
        tabIndex={effectiveVisible ? 0 : -1}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (effectiveVisible) setDialogOpen(true);
        }}
      >
        {badgeBody}
      </button>
    );
    return (
      <>
        {placement === "tooltip" && !hasMultipleOpportunities ? (
          <ControlHintTooltip title={countdownLabel}>{button}</ControlHintTooltip>
        ) : (
          button
        )}
        <CodingPlanQuotaResetDialog
          config={dialog}
          open={resolvedDialogOpen}
          onOpenChange={setDialogOpen}
        />
      </>
    );
  }

  const content = (
    <span aria-hidden={!effectiveVisible} data-reset-opportunity="true" className={commonClassName}>
      {badgeBody}
    </span>
  );

  if (placement === "inline") {
    return content;
  }

  return <ControlHintTooltip title={countdownLabel}>{content}</ControlHintTooltip>;
}
