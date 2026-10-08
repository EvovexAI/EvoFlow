import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { XIcon } from "lucide-react";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { cn } from "@/components/lib/utils.js";
import {
  AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS,
  AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
} from "@/settings/automationConfirmDialogPresentation.js";

export function ConfirmDialogHost() {
  const { intl } = useZCodeIntl();
  const pendingRequest = useConfirmDialogStore((state) => state.pendingRequest);
  const settleConfirmation = useConfirmDialogStore((state) => state.settleConfirmation);

  const settleChoice = useConfirmDialogStore((state) => state.settleChoice);

  const displayedRequestRef = useRef(pendingRequest);
  if (pendingRequest) {
    // Promise 结算后 store 会立刻清空 pendingRequest，但 Radix 关闭动画还会保留一帧内容层。
    // 如果这里直接读取 pendingRequest，退场动画期间标题/描述会先变空，只剩“确认 / 取消”按钮闪一下。
    // 因此关闭完成前继续沿用最后一次可见内容，只让 open 状态控制弹窗退场。
    displayedRequestRef.current = pendingRequest;
  }
  const displayedRequest = pendingRequest ?? displayedRequestRef.current;
  const [checkboxSelection, setCheckboxSelection] = useState<{
    request: typeof displayedRequest;
    checked: boolean;
  }>({ request: undefined, checked: false });
  const open = Boolean(pendingRequest);
  const isAutomationConfirmation = displayedRequest?.presentation === "automation-confirmation";
  const confirmLabel =
    displayedRequest?.confirmLabel ?? intl.formatMessage({ id: "common.confirm" });
  const cancelLabel = displayedRequest?.cancelLabel ?? intl.formatMessage({ id: "common.cancel" });
  const compact = displayedRequest?.compact === true;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Radix 在点击遮罩或按 Esc 时只会回调 onOpenChange(false)。
      // 如果这里不主动把 Promise 结算为 false，调用侧会一直悬挂，后续删除操作也会被卡住。
      if (!nextOpen) {
        settleChoice("dismiss");
      }
    },
    [settleChoice],
  );

  const handleConfirm = useCallback(() => {
    settleConfirmation(true);
  }, [settleConfirmation]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") {
        return;
      }

      // 带复选框的选择对话框保留焦点按钮的键盘语义，避免“不了”按 Enter 变成切换。
      if (
        displayedRequest?.checkbox &&
        event.target instanceof HTMLElement &&
        event.target.closest("button,input")
      )
        return;
      // 二次确认场景下如果不接 Enter，键盘用户会只能切到按钮再触发，
      // 体验和桌面端的确认弹窗不一致。这里在弹窗打开时统一兜住 Enter，保持可预期的确认手势。
      event.preventDefault();
      event.stopPropagation();
      settleConfirmation(true);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, settleConfirmation, displayedRequest]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid={displayedRequest?.testId}
        showCloseButton={false}
        overlayClassName={
          compact ? "bg-black/20 supports-backdrop-filter:backdrop-blur-[2px]" : undefined
        }
        className={cn(
          "gap-5 rounded-2xl border-none bg-popover/98 p-5 ring-border shadow-2xl",
          // 仅依赖共享弹框的响应式 max-width 时，不同入口所在 viewport 会让
          // 同一删除确认框看起来尺寸不一致。定时任务删除按设计固定同一 presentation。
          isAutomationConfirmation ? AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS : "sm:max-w-md",
          displayedRequest?.compact && "top-[44%] min-h-[161px] gap-4 sm:max-w-[400px]",
        )}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {displayedRequest?.title}
          </DialogTitle>
          {displayedRequest?.description ? (
            <DialogDescription
              className={cn(
                "whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle",
                isAutomationConfirmation && AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
              )}
            >
              {displayedRequest.description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter
          className={cn(
            "gap-2 sm:justify-end",
            displayedRequest?.checkbox && "flex-row flex-wrap items-center",
            // Automation 弹窗的最小高度会拉伸 Grid footer 行，按钮停在行顶导致视觉底距超过 20px。
            isAutomationConfirmation && "mt-auto",
          )}
        >
          {displayedRequest?.checkbox ? (
            <label className="mr-auto flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
              <Checkbox
                checked={
                  checkboxSelection.request === displayedRequest && checkboxSelection.checked
                }
                onCheckedChange={(value) => {
                  setCheckboxSelection({ request: displayedRequest, checked: value === true });
                  displayedRequest.checkbox?.onCheckedChange(value === true);
                }}
              />
              {displayedRequest.checkbox.label}
            </label>
          ) : null}
          <div
            className={displayedRequest?.checkbox ? "ml-auto flex items-center gap-2" : "contents"}
          >
            <Button
              type="button"
              variant={compact ? "outline" : "secondary"}
              size={"lg"}
              onClick={() => settleConfirmation(false)}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-28",
              )}
            >
              <span>{cancelLabel}</span>
              {displayedRequest?.showKeyboardHints !== false ? (
                <span className="font-mono text-ui-base text-foreground-subtle">esc</span>
              ) : null}
            </Button>
            <Button
              type="button"
              autoFocus
              // 普通确认沿用主按钮；仅显式声明 destructive 的不可恢复动作使用危险色。
              variant={displayedRequest?.confirmVariant ?? "default"}
              size={"lg"}
              data-testid={TID_CONFIRM_DIALOG_CONFIRM}
              onClick={handleConfirm}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-32",
              )}
            >
              <span>{confirmLabel}</span>
              {displayedRequest?.showKeyboardHints !== false ? (
                <span
                  className={
                    displayedRequest?.confirmVariant === "destructive"
                      ? "text-ui-base text-destructive-foreground/60"
                      : "text-ui-base text-primary-foreground/60"
                  }
                >
                  ⏎
                </span>
              ) : null}
            </Button>
          </div>
        </DialogFooter>
        {displayedRequest?.showCloseButton ? (
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 z-20 text-foreground-subtle hover:bg-surface-hover hover:text-foreground [app-region:no-drag]"
            >
              <XIcon className="size-4" strokeWidth={4 / 3} />
            </Button>
          </DialogClose>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
