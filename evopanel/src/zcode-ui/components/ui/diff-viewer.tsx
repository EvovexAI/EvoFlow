"use client";

import type { CSSProperties, HTMLAttributes } from "react";
import { memo, useMemo } from "react";
import type { BundledTheme } from "shiki";
import type { FileContents, FileDiffOptions } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";

import { cn } from "@/components/lib/utils.js";
import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";

type DiffViewerStyle = CSSProperties & {
  "--diffs-bg"?: string;
  "--diffs-light-bg"?: string;
  "--diffs-dark-bg"?: string;
  "--diffs-font-family"?: string;
  "--diffs-font-size"?: string;
};

const DIFF_VIEWER_UNSAFE_CSS = ``;

type DiffViewerPatchInput = {
  patch: string;
  oldFile?: never;
  newFile?: never;
};

type DiffViewerMultiFileInput = {
  patch?: never;
  oldFile: FileContents;
  newFile: FileContents;
};

export type DiffViewerProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> &
  (DiffViewerPatchInput | DiffViewerMultiFileInput) & {
    options?: FileDiffOptions<undefined>;
    disableWorkerPool?: boolean;
    diffClassName?: string;
    fontSizePx?: number;
    lightTheme?: BundledTheme;
    darkTheme?: BundledTheme;
    themeType?: "light" | "dark";
    selectedLines?: DiffViewerSelectedLineRange | null;
  };

export interface DiffViewerSelectedLineRange {
  start: number;
  end: number;
  side: "additions" | "deletions";
}

function DiffViewerComponent(props: DiffViewerProps) {
  const rendersPatch = isPatchDiffProps(props);
  const {
    options: optionsOverride,
    disableWorkerPool = false,
    lightTheme,
    darkTheme,
    themeType,
    diffClassName,
    fontSizePx = 12,
    selectedLines,
    className,
    style,
  } = props;
  const viewerStyle = useMemo<DiffViewerStyle>(
    () => ({
      "--diffs-bg": "var(--color-background)",
      "--diffs-light-bg": "var(--color-background)",
      "--diffs-dark-bg": "var(--color-background)",
      // 完整 diff 运行在 @pierre/diffs Shadow DOM 中，不会自动继承外层 font-mono class。
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-font-size": `${fontSizePx}px`,
      ...style,
    }),
    [fontSizePx, style],
  );
  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      diffStyle: "unified",
      diffIndicators: "bars",
      disableFileHeader: true,
      // PatchDiff 只有 patch 里的局部上下文，未包含完整 before/after 内容。
      // 使用 simple 避免展示无法点击展开的 “unmodified lines”；MultiFileDiff 保留可展开提示。
      hunkSeparators: rendersPatch ? "simple" : "line-info",
      lineDiffType: "word-alt",
      overflow: "scroll",
      unsafeCSS: DIFF_VIEWER_UNSAFE_CSS,
      // @pierre/diffs 的 code 节点在 Shadow DOM 内，外层 Tailwind class 无法命中；
      // 需要覆盖其内部样式时走 unsafeCSS 注入，且只做最小覆盖，不做大范围样式重写。
      theme:
        lightTheme && darkTheme
          ? {
              light: lightTheme,
              dark: darkTheme,
            }
          : undefined,
      themeType,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      ...optionsOverride,
    }),
    [darkTheme, lightTheme, optionsOverride, rendersPatch, themeType],
  );

  const diffNode = rendersPatch ? (
    <PatchDiff
      patch={props.patch}
      options={options}
      disableWorkerPool={disableWorkerPool}
      selectedLines={selectedLines}
      className={cn("min-h-full w-full", diffClassName)}
      style={viewerStyle}
    />
  ) : (
    <MultiFileDiff
      oldFile={props.oldFile}
      newFile={props.newFile}
      options={options}
      disableWorkerPool={disableWorkerPool}
      selectedLines={selectedLines}
      className={cn("min-h-full w-full", diffClassName)}
      style={viewerStyle}
    />
  );

  const divProps = rendersPatch ? omitPatchDiffProps(props) : omitMultiFileDiffProps(props);

  return (
    <div
      className={cn("h-full w-full overflow-auto", className)}
      data-diff-viewer=""
      style={viewerStyle}
      {...divProps}
    >
      {diffNode}
    </div>
  );
}

export const DiffViewer = memo(DiffViewerComponent);
DiffViewer.displayName = "DiffViewer";

function isPatchDiffProps(
  props: DiffViewerPatchInput | DiffViewerMultiFileInput,
): props is DiffViewerPatchInput {
  return typeof props.patch === "string";
}

function omitPatchDiffProps({
  patch: _patch,
  options: _options,
  disableWorkerPool: _disableWorkerPool,
  diffClassName: _diffClassName,
  fontSizePx: _fontSizePx,
  lightTheme: _lightTheme,
  darkTheme: _darkTheme,
  themeType: _themeType,
  selectedLines: _selectedLines,
  className: _className,
  style: _style,
  ...divProps
}: DiffViewerProps & DiffViewerPatchInput) {
  return divProps;
}

function omitMultiFileDiffProps({
  oldFile: _oldFile,
  newFile: _newFile,
  options: _options,
  disableWorkerPool: _disableWorkerPool,
  diffClassName: _diffClassName,
  fontSizePx: _fontSizePx,
  lightTheme: _lightTheme,
  darkTheme: _darkTheme,
  themeType: _themeType,
  selectedLines: _selectedLines,
  className: _className,
  style: _style,
  ...divProps
}: DiffViewerProps & DiffViewerMultiFileInput) {
  return divProps;
}
