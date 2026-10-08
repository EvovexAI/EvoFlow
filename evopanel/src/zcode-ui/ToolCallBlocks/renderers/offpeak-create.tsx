import { MoonIcon } from "lucide-react";
import { TID_OFFPEAK_CREATE_CARD, TID_OFFPEAK_CREATE_OPEN } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// OffPeakCreate 的静态轮尾卡（cron-create 兄弟实现，样式契约一致）。
// 位次是创建时快照（取自取号返回），不订阅后续状态——历史回看不产生过期活数据。

export interface OffPeakCreateTaskSummary {
  offPeakTaskId?: string;
  title?: string;
  status?: string;
  queuePosition?: number;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOffPeakCreateToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some(
    (value) => normalizeToolName(value) === "offpeakcreate",
  );
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

function readOffPeakCreateTaskOutputSummary(value: unknown): OffPeakCreateTaskSummary | null {
  const normalizedValue = normalizeOutputCandidate(value);
  if (!isPlainRecord(normalizedValue)) {
    return null;
  }

  const task = isPlainRecord(normalizedValue.task) ? normalizedValue.task : normalizedValue;
  const offPeakTaskId =
    typeof task.offPeakTaskId === "string" && task.offPeakTaskId.trim()
      ? task.offPeakTaskId.trim()
      : undefined;
  const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : undefined;
  // 卡片必须能定位任务；缺 id 视为无效输出，回退普通工具行。
  if (!offPeakTaskId) {
    return null;
  }
  const status = typeof task.status === "string" && task.status.trim() ? task.status : undefined;
  const queuePosition =
    typeof task.queuePosition === "number" &&
    Number.isFinite(task.queuePosition) &&
    task.queuePosition > 0
      ? task.queuePosition
      : undefined;

  return {
    offPeakTaskId,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(queuePosition !== undefined ? { queuePosition } : {}),
  };
}

export function readOffPeakCreateTaskSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): OffPeakCreateTaskSummary | null {
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
    const summary = readOffPeakCreateTaskOutputSummary(candidate);
    if (summary) {
      return summary;
    }
  }

  return null;
}

/** 卡片第二行：创建时位次快照优先，缺位次回退「已加入闲时队列」文案。 */
function describeOffPeakCardStatus(task: OffPeakCreateTaskSummary, intl: IntlInstance): string {
  if (typeof task.queuePosition === "number" && task.queuePosition > 0) {
    return intl.formatMessage(
      { id: "offPeak.chatCreated.queuedAt" },
      { position: task.queuePosition },
    );
  }
  return intl.formatMessage({ id: "offPeak.chatCreated.queued" });
}

export function OffPeakCreateTaskCard({
  task,
  onOpenAutomationsMain,
}: {
  task: OffPeakCreateTaskSummary;
  onOpenAutomationsMain?: (automationId?: string, automationTab?: "scheduled" | "idle") => void;
}) {
  const { intl } = useZCodeIntl();
  const title = task.title ?? intl.formatMessage({ id: "offPeak.chatCreated.defaultTitle" });
  // 会话内创建的任务绑定并运行在当前会话；位次快照后追加一句提示。
  const statusLine = `${describeOffPeakCardStatus(task, intl)} · ${intl.formatMessage({
    id: "offPeak.chatCreated.boundHint",
  })}`;
  const canOpenAutomations = Boolean(onOpenAutomationsMain);

  return (
    <div
      data-testid={TID_OFFPEAK_CREATE_CARD}
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <MoonIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">{statusLine}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_OFFPEAK_CREATE_OPEN}
          className={cn(
            "h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground",
            !canOpenAutomations && "opacity-50",
          )}
          disabled={!canOpenAutomations}
          onClick={() => onOpenAutomationsMain?.(task.offPeakTaskId, "idle")}
        >
          <span>{intl.formatMessage({ id: "offPeak.chatCreated.open" })}</span>
        </Button>
      </div>
    </div>
  );
}
