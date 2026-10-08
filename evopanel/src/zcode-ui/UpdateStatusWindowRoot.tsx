import type { IPlatformService, Locale, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";

export function UpdateStatusWindowRoot({
  platform,
  initialLocale,
  onRequestClose,
}: {
  platform: IPlatformService;
  initialLocale: Locale;
  onRequestClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        onRequestClose();
      }
    },
    [onRequestClose],
  );

  useEffect(() => {
    const disposers: Array<() => void> = [];
    const eventRevision = () => {
      revisionRef.current += 1;
      return revisionRef.current;
    };

    // 独立更新窗口没有主窗口的 app chrome state，必须自己做一次
    // getUpdateState 快照补偿；同时用 revision 避免旧快照覆盖更晚的实时事件。
    const snapshotRevision = revisionRef.current;
    void platform.getUpdateState?.().then((payload) => {
      if (revisionRef.current !== snapshotRevision) {
        return;
      }
      setUpdateState(payload);
    });

    disposers.push(
      platform.onUpdateStateChanged?.((payload) => {
        eventRevision();
        setUpdateState(payload);
      }) ?? (() => {}),
    );
    disposers.push(
      platform.onUpdateReady((version) => {
        setReadyVersion(version);
      }),
    );
    disposers.push(
      platform.onApplicationLocaleChanged?.((nextLocale) => {
        setLocale(nextLocale);
      }) ?? (() => {}),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [platform]);

  return (
    <div className="min-h-screen bg-transparent text-foreground">
      {/* 独立更新窗口不挂 workspace setting/broadcast service，不能只依赖启动时 locale。
          主窗口切语言后由 main 进程推送最新解析语言，这里重建 Provider 让弹窗文案实时跟随。 */}
      <ZCodeIntlProvider key={locale} initialLocale={locale}>
        <UpdateStatusDialogController
          platform={platform}
          version={readyVersion}
          updateState={updateState}
          open={open}
          onOpenChange={handleOpenChange}
          edgeToEdge
          showOverlay={false}
        />
        <ConfirmDialogHost />
      </ZCodeIntlProvider>
    </div>
  );
}
