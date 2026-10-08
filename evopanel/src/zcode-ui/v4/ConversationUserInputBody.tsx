import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX = 120;
const USER_INPUT_CONTENT_OVERFLOW_TOLERANCE_PX = 1;

function isUserInputContentOverflowing(scrollHeight: number): boolean {
  return (
    scrollHeight >
    COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX + USER_INPUT_CONTENT_OVERFLOW_TOLERANCE_PX
  );
}

function resolveUserInputContentMaxHeight(expanded: boolean, contentScrollHeight: number): string {
  const height = expanded
    ? Math.max(contentScrollHeight, COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX)
    : COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX;
  return `${height}px`;
}

export function ConversationUserInputBody({
  children,
  contentText,
  rowId,
}: {
  children: ReactNode;
  contentText: string;
  rowId: number;
}) {
  const { intl } = useZCodeIntl();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [contentScrollHeight, setContentScrollHeight] = useState(
    COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX,
  );
  const [expandable, setExpandable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toggleLabel = intl.formatMessage({
    id: expanded ? "chat.message.collapse" : "chat.message.expand",
  });

  useEffect(() => {
    setExpanded(false);
  }, [contentText, rowId]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      setExpandable(false);
      return;
    }

    const updateOverflow = () => {
      const nextScrollHeight = content.scrollHeight;
      setContentScrollHeight((current) =>
        current === nextScrollHeight ? current : nextScrollHeight,
      );
      if (!expanded) {
        const nextExpandable = isUserInputContentOverflowing(nextScrollHeight);
        setExpandable((current) => (current === nextExpandable ? current : nextExpandable));
      }
    };
    const scheduleOverflowUpdate = () => {
      if (animationFrameRef.current !== null) return;

      // 长会话会同时 mount 多条 userInput；逐条同步读取 scrollHeight 会把布局测量
      // 堆进同一提交。用 RAF 合并同一条消息的 ResizeObserver 通知，并兼容测试里的同步 RAF。
      animationFrameRef.current = -1;
      const frameId = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        updateOverflow();
      });
      if (animationFrameRef.current !== null) {
        animationFrameRef.current = frameId;
      }
    };

    scheduleOverflowUpdate();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleOverflowUpdate);
      observer.observe(content);
    } else {
      window.addEventListener("resize", scheduleOverflowUpdate);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleOverflowUpdate);
      if (animationFrameRef.current !== null && animationFrameRef.current >= 0) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
    };
  }, [contentText, expanded, rowId]);

  const resolvedMaxHeight = resolveUserInputContentMaxHeight(expanded, contentScrollHeight);

  return (
    <div data-conversation-selectable="true" className="relative min-w-0 flex-1">
      <div
        ref={contentRef}
        data-v4-user-input-collapsible-content="true"
        style={{ maxHeight: resolvedMaxHeight }}
        className={cn(
          "min-w-0 overflow-hidden whitespace-pre-wrap break-words transition-[max-height] duration-300 ease-out motion-reduce:transition-none",
          !expanded && expandable
            ? "[mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)]"
            : "",
        )}
      >
        {children}
      </div>
      {expandable ? (
        <div
          className={cn(
            "flex items-center justify-center",
            expanded ? "w-full pt-2" : "absolute inset-x-0 bottom-0 mx-auto",
          )}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={toggleLabel}
            aria-expanded={expanded}
            title={toggleLabel}
            onClick={() => setExpanded((current) => !current)}
            className="rounded-full bg-background shadow-sm backdrop-blur-sm transition-colors"
          >
            {expanded ? (
              <ChevronUpIcon aria-hidden="true" className="size-4" />
            ) : (
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
