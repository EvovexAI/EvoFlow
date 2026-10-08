import { cn } from "@/components/lib/utils.js";

interface AutomationSwitchToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  color?: "green" | "blue";
  size?: "default" | "sm";
}

// Scheduled 曾单独实现 switch，导致关闭态轨道与滑块定位偏离 Automations；两页统一从这里渲染。
// 首页模板进入创建页时 switch 只有点击和 focus 反馈，鼠标悬浮无法识别为可交互控件。
export function AutomationSwitchToggle({
  checked,
  onChange,
  ariaLabel,
  color = "green",
  size = "default",
}: AutomationSwitchToggleProps) {
  const activeColor = color === "blue" ? "bg-brand" : "bg-success";
  const isSmall = size === "sm";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid="automation-switch-toggle"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-[background-color,box-shadow] hover:ring-2 hover:ring-border-hover focus-visible:ring-2 focus-visible:ring-input-border-focused/30",
        checked ? activeColor : "bg-input",
        isSmall ? "h-4 w-8" : "h-5 w-9",
      )}
    >
      <span
        className={cn(
          "absolute inline-block size-3.5 rounded-full shadow transition-all duration-200",
          checked
            ? color === "blue"
              ? "bg-foreground-inverse"
              : "bg-success-foreground"
            : "bg-primary",
          checked ? (isSmall ? "left-[17px]" : "left-[18px]") : "left-px",
        )}
      />
    </button>
  );
}
