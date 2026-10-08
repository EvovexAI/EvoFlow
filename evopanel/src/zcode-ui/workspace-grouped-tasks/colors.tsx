import type { ZCodeTaskGroupColor } from "@zcode/services";
import { Hash } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { TASK_GROUP_COLOR_CLASS } from "@/workspace-grouped-tasks/types.js";

function TaskGroupColorMark({ color }: { color: ZCodeTaskGroupColor }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full",
        TASK_GROUP_COLOR_CLASS[color],
      )}
    >
      <Hash className="size-3" />
    </span>
  );
}

function TaskGroupColorDot({ color }: { color: ZCodeTaskGroupColor }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", TASK_GROUP_COLOR_CLASS[color])} />;
}

export { TaskGroupColorDot, TaskGroupColorMark };
