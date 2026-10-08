import { memo } from "react";
import {
  TID_V4_PANE_WORKSPACE_BADGE,
  TID_V4_SESSION_TITLE,
  TID_V4_SPLIT_CLOSE,
} from "@zcode/shared";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

/** 跨 workspace pane 的归属徽标（未来跨 workspace session 的多路径徽标在此扩展）。 */
export interface PaneWorkspaceBadge {
  /** 展示名（workspacePath basename）。 */
  label: string;
  /** 完整路径（tooltip）。 */
  workspacePath: string;
  /** 远程 workspace（SSH/WSL/Docker）标识。 */
  remote: boolean;
}

interface ConversationHeaderProps {
  /** meta.title；仅作为测试/可观测投影，不渲染占位 header。 */
  title: string;
  /** 向右拆分新 draft 窗格（叶子数达上限时宿主不下发）。 */
  onSplitRight?: () => void;
  /** 向下拆分新 draft 窗格。 */
  onSplitDown?: () => void;
  /** 关闭本窗格（仅非 primary pane 下发；关 pane ≠ 停 session）。 */
  onClosePane?: () => void;
  /** 跨 workspace pane 的归属徽标（pane workspace ≠ shell 当前 workspace 时下发）。 */
  workspaceBadge?: PaneWorkspaceBadge;
}

/**
 * pane chrome：不占布局高度，只在右上角悬浮拆分/关闭入口。
 * 保留 title data 节点，供 E2E 读取投影但不恢复旧横条。
 */
function ConversationHeaderImpl({ title, onClosePane, workspaceBadge }: ConversationHeaderProps) {
  const { intl } = useZCodeIntl();
  const hasFloatingActions = Boolean(workspaceBadge) || Boolean(onClosePane);

  return (
    <>
      <span data-testid={TID_V4_SESSION_TITLE} data-title={title} className="sr-only" />
      {hasFloatingActions ? (
        <div
          data-v4-pane-actions="floating"
          className="pointer-events-none absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1"
        >
          {workspaceBadge ? (
            <span
              data-testid={TID_V4_PANE_WORKSPACE_BADGE}
              data-remote={workspaceBadge.remote ? "true" : "false"}
              title={workspaceBadge.workspacePath}
              className="pointer-events-auto flex h-7 max-w-[10rem] shrink items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-2 font-mono text-ui-base text-[var(--color-foreground-subtle)] shadow-md"
            >
              <span className="truncate">{workspaceBadge.label}</span>
              {workspaceBadge.remote ? (
                <span className="shrink-0">{intl.formatMessage({ id: "v4Pane.remote" })}</span>
              ) : null}
            </span>
          ) : null}
          {/* 产品侧暂时下线 pane chrome 拆分入口；保留回调接口与底层能力，便于后续恢复。*/}
          {/* {onSplitRight ? (
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              data-testid={TID_V4_SPLIT_OPEN}
              onClick={onSplitRight}
              title={intl.formatMessage({ id: "v4Pane.splitRightTitle" })}
              aria-label={intl.formatMessage({ id: "v4Pane.splitRight" })}
              className="pointer-events-auto bg-[var(--color-popover)] shadow-md"
            >
              <SquareSplitHorizontalIcon className="size-4" />
            </Button>
          ) : null} */}
          {/* {onSplitDown ? (
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              data-testid={TID_V4_SPLIT_DOWN}
              onClick={onSplitDown}
              title={intl.formatMessage({ id: "v4Pane.splitDownTitle" })}
              aria-label={intl.formatMessage({ id: "v4Pane.splitDown" })}
              className="pointer-events-auto bg-[var(--color-popover)] shadow-md"
            >
              <SquareSplitVerticalIcon className="size-4" />
            </Button>
          ) : null} */}
          {onClosePane ? (
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              data-testid={TID_V4_SPLIT_CLOSE}
              onClick={() =>
                runUserAction({
                  input: { featureId: "task.layout", action: "close_pane", trigger: "button" },
                  operation: onClosePane,
                  completed: { resultSource: "local_commit" },
                  failureStage: "pane_close",
                })
              }
              title={intl.formatMessage({ id: "v4Pane.closePaneTitle" })}
              aria-label={intl.formatMessage({ id: "v4Pane.closePane" })}
              className="pointer-events-auto bg-[var(--color-popover)] shadow-md"
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export const ConversationHeader = memo(ConversationHeaderImpl);
