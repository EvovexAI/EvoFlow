import { useRef } from "react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";

export function TaskRenameDialog({
  open,
  value,
  inputRef,
  intl,
  onOpenChange,
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const compositionActiveRef = useRef(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden rounded-2xl p-0">
        <div className="flex min-w-0 flex-col gap-6 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>{intl.formatMessage({ id: "taskList.rename" })}</DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col space-y-4">
            <Input
              ref={inputRef}
              value={value}
              size="lg"
              placeholder={intl.formatMessage({ id: "taskList.renamePlaceholder" })}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (
                    isImeComposingKeyEvent({
                      compositionActive: compositionActiveRef.current,
                      nativeEvent: event.nativeEvent,
                    })
                  ) {
                    // task 重命名里中文输入法 Enter 是候选确认，不是确认按钮。
                    // 同时读取本地 composition 状态，避免平台事件时序让 isComposing 提前变 false。
                    logger.debug("[TaskRenameDialog] ignore rename enter during IME", {
                      valueLength: value.length,
                    });
                    return;
                  }
                  event.preventDefault();
                  logger.info("[TaskRenameDialog] rename confirm via enter", {
                    valueLength: value.length,
                    trimmedLength: value.trim().length,
                  });
                  onConfirm();
                }
              }}
            />
          </div>
          <DialogFooter className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={onCancel}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={() => {
                logger.info("[TaskRenameDialog] rename confirm via button", {
                  valueLength: value.length,
                  trimmedLength: value.trim().length,
                });
                onConfirm();
              }}
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
