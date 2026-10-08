import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type InputEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";

const AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX = 116;
const AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX = 156;

interface AutomationInstructionsComposerProps {
  invalid?: boolean;
  children: ReactNode;
}

/**
 * Instructions 底部功能 trigger 的统一交互契约。
 * 定时与闲时表单曾分别用 hover、focus-within 和不同圆角维护展开态，
 * 导致同一功能在两类自动化中出现胶囊/方圆角和打开背景不一致。
 * 行高使用 rem 语义类，避免固定像素值在界面字号调整后压缩文字行盒。
 */
export const AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME =
  "h-7 rounded-full text-ui-base font-normal leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground";

/**
 * 定时与闲时设置页的输入内容统一使用 14px 正文字号。
 * 两页曾分别维护标题、调度和 Instructions 字号，部分小时调度分支会回退到 12px。
 */
export const AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME = "text-ui-base leading-5";

/**
 * Automations 共用的 Instructions 复合输入。
 * textarea 自身承担标准 Input 描边，父级只提供工具栏的 surface 层级。
 * 几何、表面层级及全局 Input 描边状态统一收口在这里，调用方只提供字段状态和工具条内容。
 */
export function AutomationInstructionsComposer({
  invalid = false,
  children,
}: AutomationInstructionsComposerProps) {
  return (
    <div
      data-invalid={invalid || undefined}
      className="flex min-h-39 flex-col overflow-hidden rounded-xl border-0 bg-surface @container/composer"
    >
      {children}
    </div>
  );
}

export function AutomationInstructionsTextarea({
  rows = 5,
  onInput,
  value,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "ref">) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutomaticHeightRef = useRef<number | null>(null);
  const resizeToContent = useCallback((textarea: HTMLTextAreaElement) => {
    const currentHeight = Number.parseFloat(textarea.style.height);
    const lastAutomaticHeight = lastAutomaticHeightRef.current;
    const hasManualHeight =
      lastAutomaticHeight !== null &&
      Number.isFinite(currentHeight) &&
      Math.abs(currentHeight - lastAutomaticHeight) > 1;
    const contentHeight = textarea.scrollHeight;

    // 自动增高曾在每次输入时无条件重写 height，桌面用户拖拽后的高度会立刻丢失。
    // 手动高度与上一次自动高度不一致时只维护内部滚动，不再覆盖用户选择的尺寸。
    if (hasManualHeight) {
      textarea.style.overflowY = contentHeight > currentHeight ? "auto" : "hidden";
      return;
    }

    // 未发生手动拖拽时保持自动增高：短内容回到 116px，约 7 行封顶于 156px，
    // 更长内容只在正文区域内部滚动。
    textarea.style.height = `${AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX}px`;
    const automaticHeight = Math.min(
      Math.max(contentHeight, AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX),
      AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX,
    );
    textarea.style.height = `${automaticHeight}px`;
    lastAutomaticHeightRef.current = automaticHeight;
    textarea.style.overflowY =
      contentHeight > AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    if (textareaRef.current) {
      resizeToContent(textareaRef.current);
    }
  }, [resizeToContent, value]);

  const handleInput = (event: InputEvent<HTMLTextAreaElement>) => {
    resizeToContent(event.currentTarget);
    onInput?.(event);
  };

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      rows={rows}
      onInput={handleInput}
      className={cn(
        "h-29 min-h-29 max-h-39 shrink-0 resize-none overflow-y-hidden rounded-xl border border-input-border bg-input p-3 text-foreground outline-none transition-colors placeholder:text-ui-base placeholder:text-foreground-subtlest hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused focus:outline-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
      )}
    />
  );
}

export function AutomationInstructionsToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-0 p-1.5 sm:h-10 sm:flex-nowrap">
      {children}
    </div>
  );
}
