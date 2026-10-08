import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 问题原因：Markdown 曾复制一份固定宽度的竖排菜单，与对话流逐渐分叉。
// 两处只传选区位置与动作，共用展示和尺寸测量，避免再次出现样式差异。
export function SelectionActionMenu({
  center,
  top,
  bottom,
  singleLimit,
  sideActionDisabled,
  sideDisabledTitle,
  onAddToCurrentTask,
  onAskInSideChat,
}: {
  center: number;
  top: number;
  bottom: number;
  singleLimit?: boolean;
  sideActionDisabled?: boolean;
  sideDisabledTitle?: string;
  onAddToCurrentTask: () => void;
  onAskInSideChat: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const position = () => {
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(window.innerWidth - rect.width - 12, center - rect.width / 2))}px`;
      const preferredTop = top - rect.height - 8 >= 12 ? top - rect.height - 8 : bottom + 8;
      menu.style.top = `${Math.max(12, Math.min(window.innerHeight - rect.height - 12, preferredTop))}px`;
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [center, top, bottom, singleLimit, locale]);
  return createPortal(
    <div
      ref={ref}
      data-conversation-selection-tooltip="true"
      style={{
        width: "max-content",
        maxWidth: Math.min(576, window.innerWidth - 24),
        left: 12,
        top: 12,
      }}
      className="fixed z-50 flex overflow-hidden rounded-lg border border-popover-border bg-menu text-ui-sm text-foreground shadow-md"
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {singleLimit ? (
        <div className="px-2.5 py-1.5 text-[var(--color-warning)]">
          {intl.formatMessage({ id: "chat.selections.limit.single" })}
        </div>
      ) : (
        <>
          <button
            type="button"
            data-conversation-selection-action="add-to-task"
            className="min-w-0 px-2.5 py-1.5 hover:bg-menu-hover"
            onClick={onAddToCurrentTask}
          >
            {intl.formatMessage({ id: "chat.selections.addToTask" })}
          </button>
          <div className="w-px shrink-0 bg-border" />
          <button
            type="button"
            data-conversation-selection-action="ask-in-side-chat"
            disabled={sideActionDisabled}
            title={sideActionDisabled ? sideDisabledTitle : undefined}
            className={cn(
              "min-w-0 px-2.5 py-1.5 hover:bg-menu-hover",
              sideActionDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
            onClick={() => {
              if (!sideActionDisabled) onAskInSideChat();
            }}
          >
            {intl.formatMessage({ id: "chat.selections.askInSideChat" })}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
