import { useMemo } from "react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { getPlainTextPatchFallbackLines } from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/store/index.js";

interface PatchFallbackContentProps {
  patch: string;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: "light" | "dark";
  sourcePath?: string;
  sourceTitle?: string;
  /** 右侧窄面板默认应软换行；由 PreviewPane 传入。 */
  wrapLongLines?: boolean;
}

export function PatchFallbackContent({
  patch,
  codePreviewSettings,
  resolvedTheme,
  sourcePath,
  sourceTitle,
  wrapLongLines = true,
}: PatchFallbackContentProps) {
  const plainTextFallbackLines = useMemo(() => getPlainTextPatchFallbackLines(patch), [patch]);
  const highlightPath = sourcePath ?? sourceTitle;
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(highlightPath, patch),
    [highlightPath, patch],
  );
  const highlightTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;
  const previewSettings = useMemo(
    () => ({ ...codePreviewSettings, wrapLongLines }),
    [codePreviewSettings, wrapLongLines],
  );

  if (plainTextFallbackLines) {
    // @pierre/diffs 的 PatchDiff 只支持单文件 patch。日志里出现过多文件
    // patch 直接进入右侧预览，生产包渲染阶段会抛错并卡住侧栏，所以这里统一降级成轻量 diff。
    // edit 打开的右侧 Diff 对新增/删除文件也会走这条轻量 fallback；之前只渲染纯文本，
    // 导致 HTML/TS 等文件在右侧失去语法高亮。这里复用异步 Shiki 高亮，保留不卡顿的轻量渲染路径。
    return (
      <HighlightedLightweightDiffPreview
        className="h-full"
        codePreviewSettings={previewSettings}
        data-patch-plain-text-preview
        language={highlightLanguage}
        lines={plainTextFallbackLines}
        path={highlightPath}
        theme={highlightTheme}
      />
    );
  }

  return (
    <DiffViewer
      patch={patch}
      diffClassName="block"
      fontSizePx={codePreviewSettings.fontSizePx}
      lightTheme={codePreviewSettings.lightTheme}
      darkTheme={codePreviewSettings.darkTheme}
      themeType={resolvedTheme}
      wrapLongLines={wrapLongLines}
    />
  );
}
