import type { ZCodeGroupedTaskViewNode, ZCodeTaskGroupColor } from "@zcode/services";
import { ChevronDownIcon, ChevronRightIcon, MessageCirclePlus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getTaskGroupDisplayTitle } from "@/workspace-grouped-tasks/group-title.js";
import {
  TASK_GROUP_COLORS,
  TaskGroupColorDot,
  TaskGroupColorMark,
} from "@/workspace-grouped-tasks/shared.js";

type StickyGroupNode = Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;

export function StickyGroupHeader({
  node,
  collapsed,
  tooltipsDisabled,
  onCreateTask,
  onToggleCollapsed,
  onUpdateGroupColor,
  onUngroupGroup,
}: {
  node: StickyGroupNode;
  collapsed: boolean;
  tooltipsDisabled?: boolean;
  onCreateTask: () => void;
  onToggleCollapsed: (groupId: string) => void;
  onUpdateGroupColor: (groupId: string, color: ZCodeTaskGroupColor) => void;
  onUngroupGroup: (groupId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const taskCount = node.tasks.length;
  // 系统分组（cron / 闲时）标题按语言环境本地化展示，与 GroupItem 保持一致。
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });
  // sticky header 的右键菜单要和 GroupItem 一样裁剪系统分组的“解散”项，
  // 否则 cron/闲时组滚动吸顶时可被误解散。系统分组一律不提供解散入口。
  const isSystemGroup =
    node.group.id === CRON_DEFAULT_GROUP_ID || node.group.id === OFF_PEAK_DEFAULT_GROUP_ID;
  const handleToggle = () => onToggleCollapsed(node.group.id);
  const handleGroupColorChange = (color: string) => {
    onUpdateGroupColor(node.group.id, color as ZCodeTaskGroupColor);
  };
  const newTaskButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-6 shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground"
      aria-label={intl.formatMessage({ id: "taskGroup.newTask" })}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5" />
    </Button>
  );
  const newTaskAction = tooltipsDisabled ? (
    newTaskButton
  ) : (
    <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newTask" })}>
      {newTaskButton}
    </ControlHintTooltip>
  );

  return (
    <div className="px-2 pb-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={!collapsed}
            className={cn(
              "flex h-8 items-center gap-1 rounded-lg border border-border bg-background pl-1.5 pr-1 text-ui-base text-foreground shadow-sm",
              "cursor-pointer transition-[border-color,box-shadow] hover:border-border-hover",
            )}
            onClick={handleToggle}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              handleToggle();
            }}
          >
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
                  aria-label={intl.formatMessage({ id: "taskGroup.color" })}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                >
                  <TaskGroupColorMark color={node.group.color} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-40 min-w-40"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuLabel>
                  {intl.formatMessage({ id: "taskGroup.color" })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={node.group.color}
                  onValueChange={handleGroupColorChange}
                >
                  {TASK_GROUP_COLORS.map((color) => (
                    <DropdownMenuRadioItem key={color} value={color}>
                      <TaskGroupColorDot color={color} />
                      <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <span
                className="min-w-0 max-w-full truncate rounded-sm px-1 text-left text-foreground"
                title={displayTitle}
              >
                {displayTitle}
              </span>
              {collapsed ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              ) : (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              )}
            </div>
            <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle">
              {taskCount}
            </span>
            {newTaskAction}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={onCreateTask}>
            {intl.formatMessage({ id: "taskGroup.newTask" })}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              {intl.formatMessage({ id: "taskGroup.changeColor" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent
              className="w-40"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {TASK_GROUP_COLORS.map((color) => (
                <ContextMenuItem key={color} onSelect={() => handleGroupColorChange(color)}>
                  <TaskGroupColorDot color={color} />
                  <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {isSystemGroup ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onUngroupGroup(node.group.id)}>
                {intl.formatMessage({ id: "taskGroup.ungroup" })}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
