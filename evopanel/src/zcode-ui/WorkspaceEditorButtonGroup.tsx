import { createOpenInEditorRemoteTarget, type EditorInfo, type RemoteTarget } from "@zcode/shared";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId, readLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  resolveWorkspaceEditorSelection,
  shouldPersistWorkspaceEditorSelection,
} from "@/lib/workspaceEditorSelection.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { isFileManagerOpenTarget } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

export function WorkspaceEditorButtonGroup({
  disabledReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  onSelectedEditorChange,
}: {
  disabledReason?: string;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  onSelectedEditorChange?: (editor: EditorInfo | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();

  const [installedEditors, setInstalledEditors] = useState<EditorInfo[]>([]);
  const [selectedEditorId, setSelectedEditorId] = useState<string | null>(() =>
    readLastSelectedEditorId(),
  );

  useEffect(() => {
    let disposed = false;

    platform
      .getInstalledEditors()
      .then((editors) => {
        if (disposed) {
          return;
        }

        setInstalledEditors(editors);
      })
      .catch((error) => {
        logger.warn("[WorkspaceEditorButtonGroup] 获取已安装 IDE 列表失败:", error);
      });

    return () => {
      disposed = true;
    };
  }, [platform]);

  const { availableEditors, selectedEditor } = useMemo(
    () =>
      resolveWorkspaceEditorSelection({
        installedEditors: isOfficeMode
          ? installedEditors.filter(isFileManagerOpenTarget)
          : installedEditors,
        selectedEditorId,
        remoteTarget,
      }),
    [installedEditors, isOfficeMode, remoteTarget, selectedEditorId],
  );

  useEffect(() => {
    onSelectedEditorChange?.(selectedEditor);
  }, [onSelectedEditorChange, selectedEditor]);
  const editorIconClassName = useMemo(() => {
    // Windows 上编辑器图标的视觉占比普遍更大，继续用 size-6 会让按钮显得偏挤。
    // 这里只在当前按钮做平台级微调，不影响菜单里的通用图标尺寸。
    if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) {
      return "size-4 shrink-0";
    }

    return "size-5 shrink-0";
  }, []);
  const editorMenuIconClassName = useMemo(() => {
    if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) {
      return "size-4 shrink-0";
    }

    return "size-5 shrink-0";
  }, []);

  const handleOpenEditor = (editor: EditorInfo) => {
    if (disabledReason) {
      return;
    }
    setSelectedEditorId(editor.id);
    if (shouldPersistWorkspaceEditorSelection("explicit")) {
      persistLastSelectedEditorId(editor.id);
    }
    const openOptions =
      remoteTarget || workspaceIdentity
        ? {
            remoteTarget: remoteTarget ? createOpenInEditorRemoteTarget(remoteTarget) : undefined,
            workspaceIdentity,
          }
        : undefined;

    void platform.openInEditor(editor.id, workspaceAbsPath, openOptions).then((result) => {
      if (result.success) {
        return;
      }
      logger.warn("[WorkspaceEditorButtonGroup] 打开编辑器失败", {
        editorId: editor.id,
        workspaceAbsPath,
        workspaceIdentity,
        error: result.error ?? "unknown-error",
      });
    });
  };

  if (!selectedEditor) {
    return null;
  }

  return (
    <div className="flex items-center h-7 rounded-lg border border-border bg-input overflow-hidden p-0 hover:border-border-hover">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className="size-7 rounded-none border-0"
        disabled={Boolean(disabledReason)}
        onClick={() => handleOpenEditor(selectedEditor)}
        aria-label={intl.formatMessage(
          { id: "appHeader.openInEditor" },
          { editor: selectedEditor.name },
        )}
        title={
          disabledReason ??
          intl.formatMessage({ id: "appHeader.openInEditor" }, { editor: selectedEditor.name })
        }
      >
        <img
          src={selectedEditor.iconDataUrl}
          alt={selectedEditor.name}
          className={editorIconClassName}
        />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="rounded-none border-0 text-foreground-subtlest !w-5"
            disabled={Boolean(disabledReason)}
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            title={disabledReason ?? intl.formatMessage({ id: "appHeader.selectOpenApp" })}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuRadioGroup
            value={selectedEditor.id}
            onValueChange={(editorId) => {
              const editor = availableEditors.find((candidate) => candidate.id === editorId);
              if (!editor) {
                return;
              }

              handleOpenEditor(editor);
            }}
          >
            {availableEditors.map((editor) => (
              <DropdownMenuRadioItem key={editor.id} value={editor.id}>
                <img
                  src={editor.iconDataUrl}
                  alt={editor.name}
                  className={editorMenuIconClassName}
                />
                {editor.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
