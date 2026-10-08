import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { UpdateReleaseNotesTooltip } from "@/UpdateReleaseNotesTooltip.js";
import { ArrowDownToLine, LoaderCircle } from "lucide-react";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import { resolveUpdateButtonResponsiveClasses } from "@/updateStatusButtonLayout.js";
import { deriveUpdateStatusViewModel } from "@/updateStatusModel.js";

export function UpdateStatusButton({
  platform,
  version,
  updateState,
  isMacDesktop = false,
  isWindowsDesktop = false,
  className,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [dialogOpen, setDialogOpen] = useState(false);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const { expandWidthClass, hideIconClass, revealTextClass } = resolveUpdateButtonResponsiveClasses(
    { isMacDesktop, isWindowsDesktop },
  );
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    releaseNotesPayload: updateReleaseNotesPayload,
  } = updateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;
  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // 下载完成事件在部分平台只稳定带 version。入口 hover 继续缓存
    // 刚发现更新时的说明，确保弹窗外移后主入口行为仍和原来一致。
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);
  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  // 用户开始下载后，弹窗主任务已经从“了解版本内容”切换到“观察下载进度”。
  // 继续展示更新日志会挤占进度区域，也会让主按钮 hover 和弹窗在下载中重复露出日志。
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleUpdateEntryClick = useCallback(() => {
    if (platform.openUpdateStatusWindow) {
      void platform.openUpdateStatusWindow();
      return;
    }

    setDialogOpen(true);
  }, [platform]);

  if (!displayVersion) return null;

  // 更新弹窗和按钮 hover 共用同一个更新日志标题，避免 feed 自带 releaseName 与正文标题重复。
  const releaseNotesTitle = intl.formatMessage(
    { id: "updateReady.releaseNotesTitle" },
    { version: displayVersion },
  );
  const tooltipTitle =
    dialogPhase === "downloading"
      ? progressLabel
        ? intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateProgress" },
            { progress: progressLabel },
          )
        : intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateVersion" },
            { version: displayVersion },
          )
      : dialogPhase === "downloaded"
        ? intl.formatMessage({ id: "updateReady.tooltip" }, { version: displayVersion })
        : intl.formatMessage({ id: "updateAvailable.tooltip" }, { version: displayVersion });

  const readyButton = (
    <Button
      size={"xs"}
      variant={"secondary"}
      aria-label={tooltipTitle}
      onClick={handleUpdateEntryClick}
      className={cn(
        // 只把更新弹窗改成中性视觉，主页面更新入口要保留 success 色块，避免顶部状态提示变弱。
        // 自动下载不会主动打开更新窗口；下载态入口必须保持可点，用户才能进入窗口取消下载。
        // xs button 的固定 h-5 和展开态固定宽度只适配默认字号，UI 字号调大后会裁切文案。
        // 改用最小高度配合内容宽度，默认仍保持紧凑，较大字号则由文字自然撑开按钮。
        "h-auto min-h-5 gap-1 rounded-full py-0.5 font-medium leading-none text-ui-xs w-6 border-transparent bg-success text-success-foreground hover:bg-success/80 transition-all",
        dialogPhase !== "downloading" && expandWidthClass,
        className,
      )}
    >
      {dialogPhase === "downloading" ? (
        <LoaderCircle
          // 下载态本身要靠 spinner 表达 loading，不能复用普通更新图标的展开隐藏规则。
          className="size-3 shrink-0 animate-spin"
        />
      ) : (
        <ArrowDownToLine className={cn("size-3 shrink-0 inline", hideIconClass)} />
      )}
      {dialogPhase !== "downloading" ? (
        <span
          className={cn(
            "w-0 overflow-hidden absolute opacity-0 transition-all",
            ...revealTextClass,
          )}
        >
          {intl.formatMessage({ id: "updateReady.shortTitle" })}
        </span>
      ) : null}
    </Button>
  );

  const updateButton = visibleUpdateReleaseNotes ? (
    <UpdateReleaseNotesTooltip
      locale={locale}
      onOpenExternalUrl={handleOpenReleaseNotesExternalUrl}
      releaseDateLabel={restoredReleaseDate}
      releaseNotesMarkdown={visibleUpdateReleaseNotes.markdown}
      releaseNotesTitle={releaseNotesTitle}
    >
      {readyButton}
    </UpdateReleaseNotesTooltip>
  ) : (
    <ControlHintTooltip title={tooltipTitle} side="bottom">
      {readyButton}
    </ControlHintTooltip>
  );

  return (
    <>
      {updateButton}
      <UpdateStatusDialogController
        platform={platform}
        version={version}
        updateState={updateState}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
