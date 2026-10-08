/* 闲时任务 History tab：
   一行汇总一次完整执行（3h 续跑分段对用户透明）：Instructions / Triggered /
   Status / Duration + 行菜单 Go to session / Delete；无执行记录 → 「No history yet.」 */
import { isOffPeakTerminalStatus, type ZCodeOffPeakTask } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import {
  AutomationExternalLinkIcon,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

// 状态用「圆点 + 彩色文字」呈现（Scheduled 历史表密度规格）。
const STATUS_INDICATOR_CLASS = {
  succeeded: { dot: "bg-success", text: "text-success" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  skipped: { dot: "bg-foreground-subtlest", text: "text-foreground-subtle" },
  running: { dot: "bg-brand", text: "text-brand" },
} as const satisfies Record<string, { dot: string; text: string }>;

function resolveOffPeakHistoryStatus(
  task: Pick<ZCodeOffPeakTask, "status">,
): keyof typeof STATUS_INDICATOR_CLASS {
  if (task.status === "completed") return "succeeded";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "skipped";
  return "running";
}

export function OffPeakHistoryTab({
  task,
  onOpenSession,
  onDelete,
}: {
  task: ZCodeOffPeakTask | null;
  onOpenSession?: (task: ZCodeOffPeakTask) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
}) {
  const { intl } = useZCodeIntl();
  // 执行记录 = 首段派发起跑过（startedAt 存在）；纯排队/暂停中的任务无历史。
  if (!task?.startedAt || task.historyDeletedAt !== undefined) {
    return (
      <AutomationHistoryEmptyState>
        {intl.formatMessage({ id: "offPeak.history.empty" })}
      </AutomationHistoryEmptyState>
    );
  }
  const status = resolveOffPeakHistoryStatus(task);
  const endAt = isOffPeakTerminalStatus(task.status) ? (task.endedAt ?? Date.now()) : Date.now();
  const durationMin = Math.max(1, Math.round((endAt - task.startedAt) / 60_000));
  return (
    <div className="overflow-x-auto rounded-[8px]">
      {/* History 表格字号可缩放，使用相对行高避免大字号内容被固定 18px 行盒裁切。*/}
      <table className="w-full text-left text-ui-base font-normal leading-snug tracking-[-0.08px]">
        <thead className="bg-surface text-foreground-subtle">
          <tr className="h-[30px] border-b border-border">
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "offPeak.history.col.instructions" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.triggered" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.status" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.duration" })}
            </th>
            <th className="px-4 font-normal" />
          </tr>
        </thead>
        <tbody>
          <tr className="h-[46px] transition-colors hover:bg-surface-hover">
            <td className="max-w-64 truncate px-4 text-foreground-subtle" title={task.prompt}>
              {task.prompt}
            </td>
            <td className="whitespace-nowrap px-4 text-foreground-subtle">
              {formatDateTime(task.startedAt)}
            </td>
            <td className="px-4">
              <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "inline-block size-1.5 rounded-full",
                      STATUS_INDICATOR_CLASS[status].dot,
                    )}
                  />
                </span>
                <span className={STATUS_INDICATOR_CLASS[status].text}>
                  {intl.formatMessage({
                    id: `automations.runs.status.${status}`,
                  })}
                </span>
              </span>
            </td>
            <td className="whitespace-nowrap px-4 text-foreground-subtle">
              {intl.formatMessage(
                { id: "offPeak.history.durationMinutes" },
                { count: durationMin },
              )}
            </td>
            <td className="px-4">
              <div className="flex items-center justify-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                    >
                      <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  {/* 旧版按触发器右缘对齐且沿用紧凑菜单内距，导致浮层向表格内侧偏移并少 17.5px。 */}
                  <DropdownMenuContent
                    align="start"
                    alignOffset={-10}
                    sideOffset={4}
                    collisionPadding={8}
                    className="flex w-[160px] min-w-[160px] flex-col gap-0.5 border-0 px-1 py-1.5"
                  >
                    {task.sessionId && onOpenSession ? (
                      <DropdownMenuItem
                        className="min-h-9 gap-1 rounded-md p-2 text-ui-base leading-5 tracking-[-0.18px]"
                        onSelect={() => onOpenSession(task)}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationExternalLinkIcon className="size-4" aria-hidden="true" />
                        </span>
                        {intl.formatMessage({ id: "offPeak.goToSession" })}
                      </DropdownMenuItem>
                    ) : null}
                    {task.sessionId && onOpenSession && onDelete ? (
                      <DropdownMenuSeparator className="m-0 h-px w-full" />
                    ) : null}
                    {onDelete ? (
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-9 gap-1 p-2 text-ui-base leading-5 tracking-[-0.18px]"
                        onSelect={() => onDelete(task)}
                      >
                        <AutomationTrashIcon />
                        {intl.formatMessage({ id: "offPeak.history.delete" })}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
