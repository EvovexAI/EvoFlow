import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileDiffIcon,
  MessageCircleIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  getConversationFindState,
  resolveConversationFindNavigationSelection,
  resolveConversationFindNavigationDirection,
} from "@/quickpick/conversationFindSearch.js";

type TaskFindScope = "conversation" | "changes";

export type TaskFindDialogProps = {
  open: boolean;
  focusRequestId: number;
  placement?: "window" | "chat";
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  conversationMatchCount: number;
  conversationMatchIndex: number;
  fileChangeMatchCount: number;
  fileChangeMatchIndex: number;
  onOpenChange: (open: boolean) => void;
  onConversationFindChange: (query: string, activeIndex: number) => void;
  onConversationFindNavigate: (query: string, activeIndex: number) => void;
  onFileChangeFindChange: (query: string, activeIndex: number) => void;
  onFileChangeFindNavigate: (query: string, activeIndex: number) => void;
  onOpenFileChanges: () => void;
};

export function TaskFindDialog({
  open,
  focusRequestId,
  placement = "window",
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  conversationMatchCount,
  conversationMatchIndex,
  fileChangeMatchCount,
  fileChangeMatchIndex,
  onOpenChange,
  onConversationFindChange,
  onConversationFindNavigate,
  onFileChangeFindChange,
  onFileChangeFindNavigate,
  onOpenFileChanges,
}: TaskFindDialogProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const titleId = useId();
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TaskFindScope>("conversation");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const conversationState = useMemo(
    () =>
      getConversationFindState(query.trim() ? conversationMatchCount : 0, conversationMatchIndex),
    [conversationMatchCount, conversationMatchIndex, query],
  );
  const fileChangeState = useMemo(
    () => getConversationFindState(query.trim() ? fileChangeMatchCount : 0, fileChangeMatchIndex),
    [fileChangeMatchCount, fileChangeMatchIndex, query],
  );
  const activeFindState = scope === "conversation" ? conversationState : fileChangeState;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope("conversation");
      onConversationFindChange("", -1);
      onFileChangeFindChange("", -1);
      return;
    }

    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [onConversationFindChange, onFileChangeFindChange, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Cmd/Ctrl+F 在查找框已打开时不会改变 open 状态，常规聚焦 effect 不会重跑。
    // 这里监听显式 focus 请求，让重复触发快捷键时总能把焦点带回搜索输入框。
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [focusRequestId, open]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    onOpenFileChanges();
  }, [onOpenFileChanges, open, scope]);

  useEffect(() => {
    if (!open || placement !== "chat") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      // 查找框下沉到聊天区域后不再由 Radix Dialog 负责 Esc。
      // window 冒泡监听只处理尚未被活动浮层消费的 Esc，避免抢占嵌套菜单/弹层的关闭语义。
      event.preventDefault();
      onOpenChange(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open, placement]);

  useEffect(() => {
    if (!open || scope !== "conversation") {
      return;
    }

    onFileChangeFindChange("", -1);
    onConversationFindChange(query, conversationState.currentIndex);
  }, [
    conversationState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    // 切到“文件变更”范围后，旧的对话搜索高亮不应该继续留在聊天区。
    // 两个范围使用独立高亮 root，这里显式清空另一边，避免用户误以为两个范围同时生效。
    onConversationFindChange("", -1);
    onFileChangeFindChange(query, fileChangeState.currentIndex);
  }, [
    fileChangeState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  const moveSelection = useCallback(
    (direction: "previous" | "next") => {
      if (activeFindState.total === 0) {
        // 零命中时按钮已禁用，但键盘仍会进入同一处理函数。
        // 这里统一拒绝空导航，避免无效 request id 递增和按钮/键盘语义分叉。
        return;
      }

      const selection = resolveConversationFindNavigationSelection(
        query,
        activeFindState,
        direction,
      );
      if (scope === "conversation") {
        onConversationFindNavigate(selection.query, selection.activeIndex);
        return;
      }

      onFileChangeFindNavigate(selection.query, selection.activeIndex);
    },
    [activeFindState, onConversationFindNavigate, onFileChangeFindNavigate, query, scope],
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      const nextIndex = nextQuery.trim() ? 0 : -1;
      if (scope === "conversation") {
        // 输入新的查找词时应从第一个命中开始滚动。
        // 如果沿用旧 activeIndex，新关键词也可能直接跳到第 N 个结果，和系统查找行为不一致。
        onConversationFindChange(nextQuery, nextIndex);
        return;
      }

      onFileChangeFindChange(nextQuery, nextIndex);
    },
    [onConversationFindChange, onFileChangeFindChange, scope],
  );

  const handleScopeChange = useCallback(
    (nextScope: TaskFindScope) => {
      setScope(nextScope);
      if (nextScope === "changes") {
        onOpenFileChanges();
        onConversationFindChange("", -1);
        onFileChangeFindChange(query, query.trim() ? 0 : -1);
        return;
      }

      onFileChangeFindChange("", -1);
      onConversationFindChange(query, query.trim() ? 0 : -1);
    },
    [onConversationFindChange, onFileChangeFindChange, onOpenFileChanges, query],
  );

  const handleToggleScope = useCallback(() => {
    handleScopeChange(scope === "conversation" ? "changes" : "conversation");
  }, [handleScopeChange, scope]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const direction = resolveConversationFindNavigationDirection(event.key, event.shiftKey);
      if (direction) {
        event.preventDefault();
        moveSelection(direction);
      }
    },
    [moveSelection],
  );

  const placeholderId = `quickPick.find.placeholder.${scope}`;
  const ScopeIcon = scope === "conversation" ? MessageCircleIcon : FileDiffIcon;
  const nextScopeLabelId =
    scope === "conversation" ? "quickPick.find.scope.changes" : "quickPick.find.scope.conversation";
  const previousLabel = intl.formatMessage({ id: "quickPick.find.previous" });
  const nextLabel = intl.formatMessage({ id: "quickPick.find.next" });
  const nextScopeLabel = intl.formatMessage({ id: nextScopeLabelId });
  const scopeTooltipLabel = intl.formatMessage({
    id: "quickPick.find.scope.tooltip",
  });
  const closeLabel = intl.formatMessage({ id: "common.close" });
  const renderFindIconButton = ({
    label,
    tooltipLabel = label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    tooltipLabel?: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <ControlHintTooltip title={tooltipLabel} side="bottom">
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </span>
    </ControlHintTooltip>
  );
  const findContent = (
    <div className="flex h-9 items-center gap-1.5 py-0 pr-2 pl-2">
      <SearchIcon className="size-3.5 shrink-0 text-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={intl.formatMessage({ id: placeholderId })}
        className="min-w-0 flex-1 bg-transparent text-ui-base font-medium text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <div className="w-8 shrink-0 text-center text-ui-xs font-medium text-foreground-subtle tabular-nums">
        {activeFindState.total > 0
          ? `${activeFindState.currentIndex + 1}/${activeFindState.total}`
          : "0/0"}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: previousLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("previous"),
          children: <ArrowUpIcon className="size-3.5" />,
        })}
        {renderFindIconButton({
          label: nextLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("next"),
          children: <ArrowDownIcon className="size-3.5" />,
        })}
        {(!isOfficeMode || scope === "changes") &&
          renderFindIconButton({
            label: nextScopeLabel,
            tooltipLabel: scopeTooltipLabel,
            onClick: handleToggleScope,
            children: <ScopeIcon className="size-3.5" />,
          })}
      </div>
      <div className="ml-0.5 flex shrink-0 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: closeLabel,
          onClick: () => onOpenChange(false),
          children: <XIcon className="size-3.5" />,
        })}
      </div>
    </div>
  );
  const contentPositionClassName = cn(
    // 原查找框宽高偏大，在小窗口和密集操作里会遮挡更多正文区域。
    // 这里收紧到更小的宽度与内边距，减少侵入性并保持操作可读性。
    "left-auto !w-[min(360px,calc(100vw-0.75rem))] !max-w-[calc(100vw-0.75rem)] translate-x-0 translate-y-0",
    // Linux 的窗口控制和标题栏都是 renderer 自绘；查找浮层如果继续贴在 top-3，
    // 会覆盖标题栏点击区，导致打开浮层后无法通过标题栏切换/拖动窗口。Linux desktop
    // 预留 48px 标题栏和 120px 右侧窗口按钮安全区，其余平台用各自分支的偏移。
    isWindowsDesktop
      ? "top-12 right-36"
      : isMacDesktop
        ? "top-14 right-3"
        : isLinuxDesktop
          ? "top-12 right-[120px]"
          : "top-3 right-3",
  );

  if (placement === "chat") {
    if (!open) {
      return null;
    }

    return (
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="absolute top-3 left-1/2 z-30 w-[min(360px,calc(100%-1rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-popover-border bg-popover p-0 text-ui-base/relaxed text-foreground shadow-md outline-none [app-region:no-drag] max-md:top-2"
      >
        <div className="sr-only">
          <h2 id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</h2>
          <p id={descriptionId}>{intl.formatMessage({ id: "quickPick.find.description" })}</p>
        </div>
        {findContent}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogHeader className="sr-only">
        <DialogTitle id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</DialogTitle>
        <DialogDescription id={descriptionId}>
          {intl.formatMessage({ id: "quickPick.find.description" })}
        </DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        onInteractOutside={(event) => {
          // 查找框改成无蒙层后，用户会点击聊天区查看命中的上下文。
          // Radix Dialog 默认把外部点击当成关闭信号，这会让查找状态丢失；这里保留浮层，仍可用 Esc 或关闭按钮退出。
          event.preventDefault();
        }}
        className={cn(
          // Cmd/Ctrl+F 浮层不能固定在右上角：Desktop 端会和标题区控件重叠。
          // 这里按平台预留安全区：统一下移到标题区下方，并在 Windows 额外右移，避开右上角原生窗口按钮。
          contentPositionClassName,
          "overflow-hidden border-popover-border bg-popover p-0 shadow-md",
        )}
      >
        {findContent}
      </DialogContent>
    </Dialog>
  );
}
