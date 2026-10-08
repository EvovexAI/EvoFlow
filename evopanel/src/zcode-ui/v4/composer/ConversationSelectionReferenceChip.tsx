import { QuoteIcon, Trash2Icon } from "lucide-react";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isConversationSelectionReference,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

export function ConversationSelectionReferenceChip({
  references,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  references: readonly ConversationSelectionDisplayReference[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (references.length === 0) return null;
  const filePath = references.length === 1 ? references[0]?.path : undefined;
  // 文件引用沿用共用 pill，但不能再被「对话引用」计数隐藏来源。
  const label = filePath
    ? intl.formatMessage(
        { id: "chat.selections.file" },
        { name: filePath.split(/[\\/]/).pop() ?? filePath },
      )
    : intl.formatMessage(
        {
          id: references.some((reference) => reference.path)
            ? "chat.selections.mixedCount"
            : "chat.selections.count",
        },
        { count: String(references.length) },
      );
  const removeLabel = intl.formatMessage({ id: "chat.selections.remove" });
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<QuoteIcon className="size-4 shrink-0 text-foreground-subtle" />}
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
      triggerProps={{
        "data-conversation-selection-reference-count": references.length,
      }}
    >
      {references.map((reference, index) => (
        <div
          key={
            isConversationSelectionReference(reference)
              ? reference.id
              : `${index}:${reference.text}`
          }
          className="group/reference flex gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-menu-hover"
        >
          <QuoteIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-3 whitespace-pre-wrap break-words">{reference.text}</div>
            {reference.path || isConversationSelectionReference(reference) ? (
              <div className="mt-0.5 break-words text-ui-sm text-foreground-subtlest">
                {reference.path ? (
                  reference.path
                ) : isConversationSelectionReference(reference) &&
                  reference.contentType === "markdown" ? (
                  reference.sourceTitle
                ) : isConversationSelectionReference(reference) &&
                  reference.contentType !== "markdown" ? (
                  <>
                    {intl.formatMessage({ id: `chat.selections.type.${reference.contentType}` })} ·
                    #{reference.sourceRowId}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          {onRemove && isConversationSelectionReference(reference) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 text-foreground-subtle opacity-0 group-hover/reference:opacity-100"
              aria-label={removeLabel}
              onClick={() => onRemove(reference.id)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
