import { ClockIcon } from "lucide-react";
import { TID_CRON_CREATE_CARD, TID_CRON_CREATE_OPEN } from "@zcode/shared";
import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export interface CronCreateAutomationSummary {
  automationId?: string;
  title?: string;
  cronExpr?: string;
  /** 权威重复规则；卡片优先用它展示 cron 无法表达的真实间隔（如每50小时、每40天）。 */
  scheduleRule?: ZCodeAutomationScheduleRule;
  recurring?: boolean;
  maxRuns?: number;
}

const SCHEDULE_RULE_UNITS = new Set(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]);

function isScheduleRule(value: unknown): value is ZCodeAutomationScheduleRule {
  // 宽松结构校验：输出可能来自协议或历史工具结果，字段宽松地放行后由 describe 层兜底。
  if (!isPlainRecord(value)) return false;
  if (typeof value.unit !== "string" || !SCHEDULE_RULE_UNITS.has(value.unit)) return false;
  if (typeof value.interval !== "number" || !Number.isFinite(value.interval)) return false;
  if (typeof value.hour !== "number" || typeof value.minute !== "number") return false;
  if (typeof value.anchorAt !== "number") return false;
  return true;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCronAutomationCardToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some((value) => {
    const normalized = normalizeToolName(value);
    return normalized === "croncreate" || normalized === "cronupdate";
  });
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeOutputCandidate(value: unknown): unknown {
  return typeof value === "string" ? parseJsonString(value) : value;
}

function readCronCreateAutomationOutputSummary(value: unknown): CronCreateAutomationSummary | null {
  const normalizedValue = normalizeOutputCandidate(value);
  if (!isPlainRecord(normalizedValue)) {
    return null;
  }

  const automation = isPlainRecord(normalizedValue.automation)
    ? normalizedValue.automation
    : normalizedValue;
  const automationId =
    typeof automation.automationId === "string" && automation.automationId.trim()
      ? automation.automationId.trim()
      : typeof automation.automation_id === "string" && automation.automation_id.trim()
        ? automation.automation_id.trim()
        : undefined;
  const title =
    typeof automation.title === "string" && automation.title.trim()
      ? automation.title.trim()
      : undefined;
  const cronExpr =
    typeof automation.cronExpr === "string" && automation.cronExpr.trim()
      ? automation.cronExpr.trim()
      : typeof automation.cron_expr === "string" && automation.cron_expr.trim()
        ? automation.cron_expr.trim()
        : undefined;
  if (!title && !cronExpr) {
    return null;
  }

  // 读取权威 scheduleRule 与循环/次数信息，供卡片展示 cron 无法表达的真实间隔。
  const scheduleRule = isScheduleRule(automation.scheduleRule)
    ? (automation.scheduleRule as ZCodeAutomationScheduleRule)
    : undefined;
  const recurring = typeof automation.recurring === "boolean" ? automation.recurring : undefined;
  const maxRuns =
    typeof automation.maxRuns === "number" && Number.isFinite(automation.maxRuns)
      ? automation.maxRuns
      : undefined;

  return {
    ...(automationId ? { automationId } : {}),
    ...(title ? { title } : {}),
    ...(cronExpr ? { cronExpr } : {}),
    ...(scheduleRule ? { scheduleRule } : {}),
    ...(recurring !== undefined ? { recurring } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
  };
}

export function readCronCreateAutomationSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): CronCreateAutomationSummary | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawResult = isPlainRecord(raw?.result) ? raw.result : null;
  const candidates = [
    toolCall.output,
    raw?.rawOutput,
    raw?.output,
    rawResult?.content,
    rawResult?.display,
    raw?.result,
    toolCall.content,
  ];

  for (const candidate of candidates) {
    const summary = readCronCreateAutomationOutputSummary(candidate);
    if (summary) {
      return summary;
    }
  }

  return null;
}

export function CronCreateAutomationCard({
  automation,
  onOpenAutomationsMain,
}: {
  automation: CronCreateAutomationSummary;
  onOpenAutomationsMain?: (automationId?: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const title =
    automation.title ?? intl.formatMessage({ id: "automations.chatCreated.defaultTitle" });
  const schedule = automation.cronExpr
    ? describeAutomationCardSchedule(
        {
          cronExpr: automation.cronExpr,
          // 透传权威 scheduleRule/循环态，否则「每50小时」「每40天」会回退成「每小时的第00分」。
          ...(automation.scheduleRule ? { scheduleRule: automation.scheduleRule } : {}),
          ...(automation.recurring !== undefined ? { recurring: automation.recurring } : {}),
          ...(automation.maxRuns !== undefined ? { maxRuns: automation.maxRuns } : {}),
        },
        intl,
      )
    : intl.formatMessage({ id: "automations.chatCreated.scheduleFallback" });
  const canOpenAutomations = Boolean(onOpenAutomationsMain);

  return (
    <div
      data-testid={TID_CRON_CREATE_CARD}
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <ClockIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">{schedule}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_CRON_CREATE_OPEN}
          className={cn(
            // 次级文字色加尾箭头会让明确的导航操作显得像辅助说明。
            // 固定 h-7 会压缩文字热区，导致视觉内边距无法达到上下 6px。
            "h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground",
            !canOpenAutomations && "opacity-50",
          )}
          disabled={!canOpenAutomations}
          onClick={() => onOpenAutomationsMain?.(automation.automationId)}
        >
          <span>{intl.formatMessage({ id: "automations.chatCreated.open" })}</span>
        </Button>
      </div>
    </div>
  );
}
