import { MessageCirclePlus } from "lucide-react";
import { TID_TASK_NEW_BUTTON } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function NewTaskButtonGroup({
  onCreateTask,
  disabled = false,
}: {
  onCreateTask: () => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  return (
    <div
      role="group"
      aria-disabled={disabled}
      data-testid={TID_TASK_NEW_BUTTON}
      onClick={() => {
        if (!disabled) {
          runUserAction({
            input: { featureId: "task.lifecycle", action: "create", trigger: "button" },
            operation: onCreateTask,
            completed: { resultSource: "optimistic_projection" },
            failureStage: "task_create",
          });
        }
      }}
      className={cn(
        "group w-full h-8 rounded-lg inline-flex shrink-0 items-center justify-stretch gap-2 overflow-hidden pl-2.5 pr-2.5 hover:bg-surface-hover hover:text-foreground active:translate-y-0 cursor-pointer",
        disabled &&
          "cursor-not-allowed text-foreground-subtlest hover:bg-transparent hover:text-foreground-subtlest",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base">
        <MessageCirclePlus className="h-4 w-4 shrink-0" />
        <span className="truncate">{intl.formatMessage({ id: "taskList.newThread" })}</span>
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
          {newTaskShortcutLabel}
        </span>
      </div>
    </div>
  );
}
