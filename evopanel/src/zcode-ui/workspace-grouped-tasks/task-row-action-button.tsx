import type { MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

function TaskRowActionButton({
  label,
  children,
  className,
  onClick,
  showTooltip = false,
  disabledReason,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  showTooltip?: boolean;
  disabledReason?: string;
  testId?: string;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      disabled={Boolean(disabledReason)}
      data-testid={testId}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (!disabledReason) {
          onClick(event);
        }
      }}
      aria-label={label}
    >
      {children}
    </Button>
  );
  if (!showTooltip) {
    return button;
  }
  return (
    <ControlHintTooltip title={disabledReason ?? label} side="top" sideOffset={2}>
      {/* 本地 absolute tooltip 会被分组折叠容器的 overflow-hidden 裁剪；
          使用可接收指针的真实 trigger 包裹 disabled button，再由共享 Portal 渲染提示。 */}
      <span className="inline-flex shrink-0">{button}</span>
    </ControlHintTooltip>
  );
}

export { TaskRowActionButton };
