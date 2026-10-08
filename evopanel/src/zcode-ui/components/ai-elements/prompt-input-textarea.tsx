/*
 * Derived from vercel/ai-elements (packages/elements/src/prompt-input.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: split components and adapt local imports and behavior.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { InputGroupTextarea } from "../ui/input-group.js";
import { cn } from "../lib/utils.js";
import type {
  ChangeEvent,
  ClipboardEventHandler,
  ComponentProps,
  KeyboardEventHandler,
} from "react";
import { useCallback, useState } from "react";
import { usePromptInputAttachments, useOptionalPromptInputController } from "./prompt-input.js";

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      // Call the external onKeyDown handler first
      onKeyDown?.(e);

      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        // Check if the submit button is disabled before submitting
        const { form } = e.currentTarget;
        const submitButton = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitButton?.disabled) {
          return;
        }

        form?.requestSubmit();
      }

      // Remove last attachment when Backspace is pressed and textarea is empty
      if (e.key === "Backspace" && e.currentTarget.value === "" && attachments.files.length > 0) {
        e.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) {
          attachments.remove(lastAttachment.id);
        }
      }
    },
    [onKeyDown, isComposing, attachments],
  );

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      const items = event.clipboardData?.items;

      if (!items) {
        return;
      }

      const files: File[] = [];

      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
      }
    },
    [attachments],
  );

  const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
  const handleCompositionStart = useCallback(() => setIsComposing(true), []);

  const controlledProps = controller
    ? {
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
        value: controller.textInput.value,
      }
    : {
        onChange,
      };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      {...controlledProps}
    />
  );
};
