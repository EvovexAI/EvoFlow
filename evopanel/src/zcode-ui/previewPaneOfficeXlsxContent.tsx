import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  XlsxViewer,
  initWasm,
  setWasmSource,
  type XlsxViewerController,
} from "@extend-ai/react-xlsx";
import xlsxWasmUrl from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { installDocumentLinkSafety } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

/** public/office 下的稳定路径（Vite/Tauri 都能直接取到，不依赖 /node_modules/...）。 */
const PUBLIC_XLSX_WASM_URL = `${String(import.meta.env.BASE_URL || "/").replace(/\/?$/u, "/")}office/duke_sheets_wasm_bg.wasm`;

let xlsxWasmReady: Promise<void> | null = null;

/**
 * 把 WASM 拉成 ArrayBuffer 再 init：避免 fetch(URL) 拿到 SPA HTML、
 * 或 Tauri 下 /node_modules 路径 404。
 */
function ensureXlsxWasm(): Promise<void> {
  if (!xlsxWasmReady) {
    xlsxWasmReady = (async () => {
      const candidates = [PUBLIC_XLSX_WASM_URL, xlsxWasmUrl];
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate);
          if (!response.ok) {
            throw new Error(`wasm HTTP ${response.status} (${candidate})`);
          }
          const bytes = await response.arrayBuffer();
          // SPA fallback 常返回几 KB HTML；真 WASM 约 4MB。
          if (bytes.byteLength < 50_000) {
            throw new Error(
              `wasm too small (${bytes.byteLength}B) — likely HTML fallback (${candidate})`,
            );
          }
          setWasmSource(bytes);
          await initWasm();
          logger.debug("[PreviewPane] Excel WASM 已就绪", {
            source: candidate,
            bytes: bytes.byteLength,
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Excel WASM 加载失败: ${String(lastError)}`);
    })().catch((error) => {
      xlsxWasmReady = null;
      throw error;
    });
  }
  return xlsxWasmReady;
}

function getNextSheetTabIndex({
  currentIndex,
  key,
  tabCount,
}: {
  currentIndex: number;
  key: string;
  tabCount: number;
}): number | null {
  if (tabCount < 1) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return tabCount - 1;
  }
  if (key === "ArrowLeft") {
    return (currentIndex - 1 + tabCount) % tabCount;
  }
  if (key === "ArrowRight") {
    return (currentIndex + 1) % tabCount;
  }
  return null;
}

function XlsxSheetTabs({ controller, label }: { controller: XlsxViewerController; label: string }) {
  const { activeTabIndex, setActiveTabIndex, tabs } = controller;

  if (tabs.length <= 1) {
    return null;
  }

  const selectTab = (tabIndex: number) => {
    setActiveTabIndex(tabIndex);
    logger.debug("[PreviewPane] Excel 工作表已切换", {
      sheetIndex: tabIndex,
      sheetName: tabs[tabIndex]?.name,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
    const nextTabIndex = getNextSheetTabIndex({
      currentIndex: tabIndex,
      key: event.key,
      tabCount: tabs.length,
    });
    if (nextTabIndex === null) {
      return;
    }

    event.preventDefault();
    selectTab(nextTabIndex);
    const tabButtons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabButtons?.item(nextTabIndex).focus();
  };

  return (
    <div
      aria-label={label}
      className="flex min-h-0 shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1"
      role="tablist"
    >
      {tabs.map((tab, tabIndex) => {
        const isActive = tabIndex === activeTabIndex;
        return (
          <button
            aria-selected={isActive}
            className={cn(
              "h-7 max-w-48 shrink-0 truncate rounded-md px-2 text-ui-sm transition-colors",
              isActive
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            key={tab.id}
            onClick={() => selectTab(tabIndex)}
            onKeyDown={(event) => handleKeyDown(event, tabIndex)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            title={tab.name}
            type="button"
          >
            {tab.name}
          </button>
        );
      })}
    </div>
  );
}

function XlsxPreviewError({
  error,
  message,
  sourcePath,
}: {
  error: Error;
  message: string;
  sourcePath: string;
}) {
  useEffect(() => {
    logger.error("[PreviewPane] Excel 文件解析失败", {
      path: sourcePath,
      error: error.message,
    });
  }, [error, sourcePath]);

  return (
    <div className="p-3 text-sm text-destructive" role="alert">
      <div>{message}</div>
      {error.message ? (
        <div className="mt-1 text-ui-sm text-foreground-subtle break-all">{error.message}</div>
      ) : null}
    </div>
  );
}

function excelDisplayFileName(sourcePath: string): string {
  const normalized = String(sourcePath || "").replace(/\\/g, "/");
  const base = normalized.split("/").filter(Boolean).pop();
  return base || "workbook.xlsx";
}

export function PreviewPaneOfficeXlsxContent({
  buffer,
  errorMessage,
  isDark,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  isDark: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const { intl } = useZCodeIntl();
  const sheetTabsLabel = intl.formatMessage({ id: "codeViewer.excel.sheetTabs" });
  const [wasmState, setWasmState] = useState<"loading" | "ready" | "error">("loading");
  const [wasmError, setWasmError] = useState<Error | null>(null);
  // react-xlsx 的默认工具栏同时承载编辑动作和 sheet tabs。
  // 预览关闭默认工具栏后会丢失多表导航，因此只通过 toolbar render prop 补回只读 sheet tabs。
  const renderSheetTabs = useCallback(
    (controller: XlsxViewerController) => (
      <XlsxSheetTabs controller={controller} label={sheetTabsLabel} />
    ),
    [sheetTabsLabel],
  );

  useEffect(() => {
    let cancelled = false;
    setWasmState("loading");
    setWasmError(null);
    void ensureXlsxWasm()
      .then(() => {
        if (!cancelled) setWasmState("ready");
      })
      .catch((error: unknown) => {
        const next = error instanceof Error ? error : new Error(String(error));
        logger.error("[PreviewPane] Excel WASM 加载失败", { error: next.message });
        if (!cancelled) {
          setWasmError(next);
          setWasmState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = viewerRef.current;
    return root ? installDocumentLinkSafety(root, onOpenBrowserUrl) : undefined;
  }, [onOpenBrowserUrl, wasmState]);

  if (wasmState === "loading") {
    return (
      <div
        aria-busy="true"
        className="h-full min-h-0 w-full bg-background"
        data-office-preview-pending
      />
    );
  }

  if (wasmState === "error" && wasmError) {
    return <XlsxPreviewError error={wasmError} message={errorMessage} sourcePath={sourcePath} />;
  }

  return (
    <div
      ref={viewerRef}
      className="h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      data-office-preview-kind="excel"
    >
      <XlsxViewer
        file={buffer}
        fileName={excelDisplayFileName(sourcePath)}
        height="100%"
        isDark={isDark}
        // readOnly 默认走 Worker；Vite/Tauri 下 worker URL 易挂且库几乎不回退主线程。
        useWorker={false}
        // WebView2/部分环境 WebGL 不稳定；DOM 表渲染对预览足够。
        experimentalCanvas={false}
        readOnly
        rounded={false}
        showDefaultToolbar={false}
        toolbar={renderSheetTabs}
        loadingState={
          <div
            aria-busy="true"
            className="h-full min-h-0 w-full bg-background"
            data-office-preview-pending
          />
        }
        errorState={(error) => (
          <XlsxPreviewError error={error} message={errorMessage} sourcePath={sourcePath} />
        )}
        fileTooLargeState={() => (
          <div className="p-3 text-sm text-destructive" role="alert">
            {errorMessage}
          </div>
        )}
      />
    </div>
  );
}
