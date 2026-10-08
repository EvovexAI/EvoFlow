import { Loader2Icon, Undo2Icon } from "lucide-react";
import {
  TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY,
  TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
} from "@zcode/shared";
import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type FileRewindPreviewFile =
  | V4ConversationFileRewindPreviewResult["safeFiles"][number]
  | V4ConversationFileRewindPreviewResult["unsafeFiles"][number]
  | V4ConversationFileRewindPreviewResult["ignoredFiles"][number];

interface ConversationFileRewindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: V4ConversationFileRewindPreviewResult | null;
  previewLoading: boolean;
  applying: boolean;
  error: string | null;
  onApply: () => void;
  variant?: "fileRewind" | "editConflict";
  onConversationOnly?: () => void;
}

function formatReason(reason: string, intl: ReturnType<typeof useZCodeIntl>["intl"]) {
  const fallbackReasonKey = "chat.changeSummary.rewindDialog.reason.unsupportedCheckpoint";
  const keyByReason: Record<string, string> = {
    bash_ignored: "chat.changeSummary.rewindDialog.reason.bashIgnored",
    checkpoint_missing: "chat.changeSummary.rewindDialog.reason.checkpointMissing",
    checkpoint_unreadable: "chat.changeSummary.rewindDialog.reason.checkpointUnreadable",
    external_modified: "chat.changeSummary.rewindDialog.reason.externalModified",
    file_read_failed: "chat.changeSummary.rewindDialog.reason.fileReadFailed",
    unsupported_checkpoint: fallbackReasonKey,
  };
  return intl.formatMessage({ id: keyByReason[reason] ?? fallbackReasonKey });
}

function PreviewFileList({
  files,
  type,
}: {
  files: readonly FileRewindPreviewFile[];
  type: "safe" | "unsafe" | "ignored";
}) {
  const { intl } = useZCodeIntl();
  if (files.length === 0) return null;
  return (
    <div className="grid gap-1">
      {files.map((file) => (
        <div
          key={`${type}:${file.path}`}
          className="flex items-center justify-between gap-3 rounded-md border border-border bg-input/30 px-2 py-1.5"
        >
          <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">{file.path}</span>
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {"reason" in file
              ? formatReason(file.reason, intl)
              : intl.formatMessage(
                  { id: "chat.changeSummary.rewindDialog.operationCount" },
                  { count: String(file.operationCount) },
                )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ConversationFileRewindDialog({
  open,
  onOpenChange,
  preview,
  previewLoading,
  applying,
  error,
  onApply,
  variant = "fileRewind",
  onConversationOnly,
}: ConversationFileRewindDialogProps) {
  const { intl } = useZCodeIntl();
  const safeCount = preview?.safeFiles.length ?? 0;
  const unsafeCount = preview?.unsafeFiles.length ?? 0;
  const ignoredCount = preview?.ignoredFiles.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid={variant === "editConflict" ? TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG : undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id:
                variant === "editConflict"
                  ? "chat.edit.workspaceConflict.title"
                  : "chat.changeSummary.rewindDialog.title",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({
              id:
                variant === "editConflict"
                  ? "chat.edit.workspaceConflict.description"
                  : "chat.changeSummary.rewindDialog.description",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
          {previewLoading ? (
            <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-3.5 animate-spin" />
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.loading" })}
            </div>
          ) : preview ? (
            <>
              {variant === "fileRewind" ? (
                <section className="grid gap-1">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.safeTitle" },
                      { count: String(safeCount) },
                    )}
                  </h3>
                  <PreviewFileList files={preview.safeFiles} type="safe" />
                </section>
              ) : null}
              <section className="grid gap-1">
                <h3 className="text-ui-base font-medium">
                  {intl.formatMessage(
                    { id: "chat.changeSummary.rewindDialog.unsafeTitle" },
                    { count: String(unsafeCount) },
                  )}
                </h3>
                <PreviewFileList files={preview.unsafeFiles} type="unsafe" />
              </section>
              {ignoredCount > 0 ? (
                <section className="grid gap-1">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.ignoredTitle" },
                      { count: String(ignoredCount) },
                    )}
                  </h3>
                  <PreviewFileList files={preview.ignoredFiles} type="ignored" />
                </section>
              ) : null}
            </>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.noPreview" })}
            </p>
          )}
          {error ? <p className="text-ui-base text-danger">{error}</p> : null}
          {variant === "fileRewind" && preview && !preview.canApply ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.cannotApply" })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {variant === "editConflict" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={applying}
                onClick={() => onOpenChange(false)}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                disabled={applying || previewLoading}
                data-testid={TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY}
                onClick={onConversationOnly}
              >
                {applying ? <Loader2Icon className="animate-spin" /> : null}
                {intl.formatMessage({ id: "chat.edit.workspaceConflict.conversationOnly" })}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={!preview?.canApply || applying || previewLoading}
              onClick={onApply}
            >
              {applying ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.confirm" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
