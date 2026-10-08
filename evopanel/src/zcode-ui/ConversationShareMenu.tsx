import { ShareIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConversationShareSelectionStore } from "@/store/conversationShareSelectionStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

export function ConversationShareMenu({
  taskId,
  useWindowsCaptionSpacing = false,
}: {
  taskId: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const setScope = useConversationShareSelectionStore((state) => state.setScope);
  const finishSelection = useConversationShareSelectionStore((state) => state.finishSelection);
  const publishing = useConversationShareSelectionStore(
    (state) => state.dockStates[taskId]?.publishing ?? false,
  );
  const showTimeline = useConversationShareSelectionStore((state) => state.showTimeline);
  const active = useConversationShareSelectionStore(
    (state) => state.drafts[taskId]?.scope === "partial",
  );

  const handleClick = () => {
    const currentState = useConversationShareSelectionStore.getState();
    const currentlyActive = currentState.drafts[taskId]?.scope === "partial";
    if (currentState.dockStates[taskId]?.publishing) return;
    logger.debug("[conversation-share] 顶栏入口切换分享", {
      taskId,
      alreadyActive: currentlyActive,
    });
    if (currentlyActive) {
      // 再次点击不能只切换面板：无法退出分享；复用取消操作清理当前会话的草稿和 dock。
      finishSelection(taskId);
    } else {
      // 首次进入默认全选；面板收起到 timeline，用户可通过左侧 reopen 入口调整范围。
      setScope(taskId, "partial");
      showTimeline(taskId);
    }
  };

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      // 分享曾使用更大的热区和独立 mask 缩放；复用相邻工具栏按钮的尺寸与图标规范。
      size="icon-md"
      className={cn(
        "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
        useWindowsCaptionSpacing ? "ml-3" : "ml-2.5",
        useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        active && "bg-selected",
      )}
      aria-label={intl.formatMessage({ id: "conversationShare.trigger" })}
      data-testid="conversation-share-trigger"
      aria-pressed={active}
      disabled={publishing}
      onClick={handleClick}
    >
      <ShareIcon className="size-4" />
    </Button>
  );

  return active ? (
    trigger
  ) : (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "conversationShare.trigger" })}
      side="bottom"
    >
      {trigger}
    </ControlHintTooltip>
  );
}
