import { AlarmClock, GiftIcon, XIcon } from "lucide-react";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCodingPlanQuotaResetCountdown } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { Button } from "@/components/ui/button.js";

export const CONTEXT_QUOTA_RESET_URGENT_SECONDS = 180;

type ContextQuotaResetOpportunityReminderPhase = "initial" | "urgent";

interface ContextQuotaResetOpportunityDismissal {
  opportunityKey: string | null;
  initial: boolean;
  urgent: boolean;
}

interface ContextQuotaResetOpportunity {
  count: number;
  expiresAt: number | null;
  sourceKey: string | null;
  visible: boolean;
}

interface ContextQuotaResetOpportunityReminder {
  count: number;
  opportunityKey: string;
  phase: ContextQuotaResetOpportunityReminderPhase;
  remainingSeconds: number;
}

function createContextQuotaResetOpportunityDismissalStore() {
  let snapshot: ContextQuotaResetOpportunityDismissal = {
    opportunityKey: null,
    initial: false,
    urgent: false,
  };
  const listeners = new Set<() => void>();

  return {
    dismiss(reminder: ContextQuotaResetOpportunityReminder) {
      const sameOpportunity = snapshot.opportunityKey === reminder.opportunityKey;
      snapshot = {
        initial: sameOpportunity
          ? snapshot.initial || reminder.phase === "initial"
          : reminder.phase === "initial",
        opportunityKey: reminder.opportunityKey,
        urgent: sameOpportunity
          ? snapshot.urgent || reminder.phase === "urgent"
          : reminder.phase === "urgent",
      };
      listeners.forEach((listener) => listener());
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// 会话切换会重新挂载 composer；已读状态必须归当前 renderer 窗口所有，
// 否则同一个重置机会会在每次切换会话后重新弹出。模块实例天然按窗口隔离且不落盘。
export const contextQuotaResetOpportunityDismissalStore =
  createContextQuotaResetOpportunityDismissalStore();

type ContextQuotaResetOpportunityTriggerTone = "available" | "urgent";

export function resolveContextQuotaResetOpportunityTriggerTone({
  now,
  opportunity,
}: {
  now: number;
  opportunity: ContextQuotaResetOpportunity;
}): ContextQuotaResetOpportunityTriggerTone | null {
  const { count, expiresAt, sourceKey, visible } = opportunity;
  if (!visible || count <= 0 || expiresAt === null || !sourceKey || expiresAt <= now) {
    return null;
  }
  return expiresAt - now <= CONTEXT_QUOTA_RESET_URGENT_SECONDS * 1_000 ? "urgent" : "available";
}

export function resolveContextQuotaResetOpportunityReminder({
  dismissal,
  now,
  opportunity,
}: {
  dismissal: ContextQuotaResetOpportunityDismissal;
  now: number;
  opportunity: ContextQuotaResetOpportunity;
}): ContextQuotaResetOpportunityReminder | null {
  const { count, expiresAt, sourceKey, visible } = opportunity;
  if (!visible || count <= 0 || expiresAt === null || !sourceKey || expiresAt <= now) {
    return null;
  }

  const opportunityKey = `${sourceKey}:${expiresAt}`;
  const sameOpportunity = dismissal.opportunityKey === opportunityKey;
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const phase: ContextQuotaResetOpportunityReminderPhase =
    remainingSeconds <= CONTEXT_QUOTA_RESET_URGENT_SECONDS ? "urgent" : "initial";
  if (sameOpportunity && dismissal[phase]) {
    return null;
  }

  return { count, opportunityKey, phase, remainingSeconds };
}

export function resolveContextTriggerTooltipKind(
  resetStatus: "processing" | "completed" | null,
  opportunityPhase: ContextQuotaResetOpportunityReminderPhase | null,
): "reset-status" | ContextQuotaResetOpportunityReminderPhase | null {
  return resetStatus ? "reset-status" : opportunityPhase;
}

export function shouldDismissContextQuotaResetOpportunityReminder(
  target: EventTarget | null,
  trigger: HTMLElement | null,
): boolean {
  if (!(target instanceof Node) || trigger?.contains(target)) {
    return false;
  }
  const targetElement = target instanceof Element ? target : target.parentElement;
  return !targetElement?.closest("[data-context-reset-reminder]");
}

export function ContextQuotaResetOpportunityReminderContent({
  count,
  intl,
  onDismiss,
  phase,
  remainingSeconds,
}: {
  count: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onDismiss: () => void;
  phase: ContextQuotaResetOpportunityReminderPhase;
  remainingSeconds: number;
}) {
  if (phase === "initial") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-ui-sm"
        data-context-reset-reminder="initial"
      >
        <GiftIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        <span>
          {intl.formatMessage({ id: "codingPlan.quotaReset.contextReminder.available" }, { count })}
        </span>
        <ContextQuotaResetOpportunityDismissButton intl={intl} onDismiss={onDismiss} />
      </span>
    );
  }

  const countdown = formatCodingPlanQuotaResetCountdown(remainingSeconds, intl.formatMessage);
  return (
    <span
      role="status"
      className="inline-flex items-center gap-0 text-ui-sm"
      data-context-reset-reminder="urgent"
    >
      <span className="inline-flex items-center gap-1.5" data-context-reset-reminder-copy>
        <span
          className="inline-flex shrink-0 origin-bottom animate-zcode-alarm-ring text-warning motion-reduce:animate-none"
          aria-hidden="true"
        >
          <AlarmClock className="size-3.5" />
        </span>
        <span>
          {intl.formatMessage({ id: "codingPlan.quotaReset.contextReminder.expiresIn" })}{" "}
          <span className="inline-flex h-3.5 items-center rounded-full bg-warning/10 px-1.5 text-ui-xs leading-none font-medium tabular-nums text-warning">
            {countdown}
          </span>
        </span>
      </span>
      <ContextQuotaResetOpportunityDismissButton intl={intl} onDismiss={onDismiss} />
    </span>
  );
}

function ContextQuotaResetOpportunityDismissButton({
  intl,
  onDismiss,
}: {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onDismiss: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="rounded-full text-foreground-subtle"
      aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.contextReminder.dismiss" })}
      data-context-reset-reminder-dismiss
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onDismiss();
      }}
    >
      <XIcon aria-hidden="true" />
    </Button>
  );
}
