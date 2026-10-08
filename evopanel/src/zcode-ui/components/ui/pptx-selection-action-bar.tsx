"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent } from "@/components/ui/popover.js";
import { Textarea } from "@/components/ui/textarea.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

interface PptxSelectionActionBarProps {
  children: ReactNode;
  open: boolean;
  boundary: HTMLElement | null;
  label: string;
  commentPlaceholder: string;
  cancelLabel: string;
  addToConversationLabel: string;
  editing: boolean;
  disabled: boolean;
  onAiEdit: () => void;
  onCancelAiEdit: () => void;
  onAddToConversation: (comment: string) => void;
  onExitSelection: () => void;
}

/**
 * PPTX 元素选择的应用层操作条。
 *
 * 锚点仍位于幻灯片 transform 容器内，内容通过 Popover Portal 渲染；这样既能读取
 * 缩放后的真实 DOMRect，又不会让按钮尺寸随幻灯片缩放或被页面 overflow 裁切。
 */
export function PptxSelectionActionBar({
  children,
  open,
  boundary,
  label,
  commentPlaceholder,
  cancelLabel,
  addToConversationLabel,
  editing,
  disabled,
  onAiEdit,
  onCancelAiEdit,
  onAddToConversation,
  onExitSelection,
}: PptxSelectionActionBarProps) {
  const [comment, setComment] = useState("");
  const compositionActiveRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setComment("");
      compositionActiveRef.current = false;
    }
  }, [editing]);

  return (
    <Popover open={open} modal={false}>
      {children}
      <PopoverContent
        role="toolbar"
        aria-label={label}
        side="top"
        align="center"
        sideOffset={8}
        collisionBoundary={boundary}
        collisionPadding={8}
        sticky="partial"
        hideWhenDetached
        updatePositionStrategy="always"
        className={
          editing
            ? "w-80 max-w-[calc(100vw-1rem)] gap-0 border-popover-border p-1"
            : "w-auto max-w-[calc(100vw-1rem)] gap-0 border-popover-border p-1"
        }
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (editing) {
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                isComposing: event.isComposing,
              })
            ) {
              // 中文/日文输入法下 Esc 是取消候选词，不是放弃评论。
              // 同时读取本地 composition 状态，避免平台事件时序让 isComposing 提前变 false。
              return;
            }
            // Esc 与“取消”同义：只丢弃本次评论草稿并回到 AI 编辑条，不连带退出元素选择。
            onCancelAiEdit();
            return;
          }
          onExitSelection();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {editing ? (
          <div className="flex flex-col gap-2 p-1">
            <Textarea
              autoFocus
              aria-label={commentPlaceholder}
              placeholder={commentPlaceholder}
              value={comment}
              disabled={disabled}
              rows={3}
              className="min-h-16 resize-none border-input-border bg-input text-mobile-input-safe placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
              onChange={(event) => setComment(event.target.value)}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
            />
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={onCancelAiEdit}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() => onAddToConversation(comment)}
              >
                {addToConversationLabel}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="lg"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            className="w-full justify-start rounded-lg px-2"
            onMouseDown={(event) => {
              // 原因：按钮获得鼠标焦点前浏览器可能清空 PPTX 文本 Selection；阻止默认 mousedown 仍保留 click/键盘激活。
              event.preventDefault();
            }}
            onClick={onAiEdit}
          >
            <SparklesIcon className="size-4" />
            {label}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
