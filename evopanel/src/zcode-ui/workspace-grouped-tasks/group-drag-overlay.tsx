import type { CSSProperties } from "react";
import type { ZCodeGroupedTaskViewNode } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TaskGroupColorMark } from "@/workspace-grouped-tasks/colors.js";
import { getTaskGroupDisplayTitle } from "@/workspace-grouped-tasks/group-title.js";

type GroupNode = Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;

function GroupDragOverlay({
  node,
  className,
  style,
}: {
  node: GroupNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { intl } = useZCodeIntl();
  // cron 在存储层使用 `cron` 占位名；拖拽浮层曾绕过普通 header 的本地化逻辑，
  // 导致拖动时从“定时任务”闪回内部值。三种 header 统一走同一个标题格式化入口。
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });

  return (
    <div className={className} style={style}>
      <div className="pointer-events-none flex h-8 cursor-grabbing items-center gap-1 rounded-lg border border-border bg-background pl-1.5 pr-1 text-ui-base text-foreground shadow-lg">
        <TaskGroupColorMark color={node.group.color} />
        <span className="min-w-0 flex-1 truncate px-1">{displayTitle}</span>
        <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle">
          {node.tasks.length}
        </span>
      </div>
    </div>
  );
}

export { GroupDragOverlay };
