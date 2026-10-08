/* 闲时任务编辑页顶栏动作菜单：Save 右侧「⋯」→ 按状态给 暂停/继续 + 删除。
   与列表卡片菜单同义，供编辑页内直接操作；queued→暂停、paused→继续，终态只留删除。
   样式与定时任务编辑页顶栏菜单同源。 */
import { TID_OFFPEAK_CARD_MENU, type ZCodeOffPeakTask } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  AutomationContinueIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function OffPeakEditActionsMenu({
  task,
  onPause,
  onContinue,
  onDelete,
}: {
  task: ZCodeOffPeakTask;
  onPause?: (task: ZCodeOffPeakTask) => void;
  onContinue?: (task: ZCodeOffPeakTask) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={TID_OFFPEAK_CARD_MENU}
          aria-label={intl.formatMessage({ id: "automations.moreActions" })}
          className="flex size-8 items-center justify-center rounded-lg border-0 bg-white/[0.06] text-foreground-subtle shadow-none outline-none transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground focus-visible:ring-0"
        >
          <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="w-[190px] min-w-[190px] border-0 px-1 py-1.5"
      >
        {task.status === "queued" && onPause ? (
          <DropdownMenuItem
            className="min-h-9 gap-1 rounded-md leading-5"
            onSelect={() => onPause(task)}
          >
            <span className="flex size-5 items-center justify-center">
              <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "offPeak.action.pause" })}
          </DropdownMenuItem>
        ) : null}
        {task.status === "paused" && onContinue ? (
          <DropdownMenuItem
            className="min-h-9 gap-1 rounded-md leading-5"
            onSelect={() => onContinue(task)}
          >
            <span className="flex size-5 items-center justify-center">
              <AutomationContinueIcon className="size-4" aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "offPeak.action.continue" })}
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <>
            <DropdownMenuSeparator className="mx-0 my-0.5" />
            <DropdownMenuItem
              className="min-h-9 gap-1 rounded-md leading-5 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
              onSelect={() => onDelete(task)}
            >
              <AutomationTrashIcon />
              {intl.formatMessage({ id: "common.delete" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
