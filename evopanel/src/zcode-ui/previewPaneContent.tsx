import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
/* eslint-disable max-lines -- PreviewPane 内容路由同时承载文本、图片、媒体、Office、PDF 和 PPTX 渲染。 */
import type { BundledTheme } from "shiki";
import { useMemo, type Ref, type SyntheticEvent, type UIEventHandler } from "react";
import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { CodeCommentLabels } from "@/components/ui/code-viewer.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { CodeContent } from "@/previewPaneCodeContent.js";
import { ImagePreviewContent, SvgPreviewContent } from "@/previewPaneImageContent.js";
import { PreviewPaneMediaContent } from "@/previewPaneMediaContent.js";
import { PdfPreviewContent } from "@/previewPanePdfContent.js";
import { PptxPreviewContent } from "@/previewPanePptxContent.js";
import { PatchFallbackContent } from "@/previewPanePatchFallbackContent.js";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { Theme } from "@/useTheme.js";
import type { OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { PreviewPaneOfficeContent } from "@/previewPaneOfficeContent.js";
import type { PptxElementReferenceSource } from "@/lib/pptxElementReference.js";
import type { MediaCodeViewerSource, PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";
import { resolveCodeReviewContentProjection } from "@/previewPaneCodeReview.js";

interface PreviewPaneContentProps {
  source: CodeViewerSource;
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
  loadingInitial: boolean;
  loadingImagePreview: boolean;
  imagePreview: FileMediaPreview | null;
  mediaSource: MediaCodeViewerSource | null;
  loadingMediaPreview: boolean;
  mediaPreviewUrl: string | null;
  onMediaError: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void;
  loadingPdfPreview: boolean;
  pdfViewerSource: PdfViewerSource | null;
  pdfViewerLabels: PdfViewerLabels;
  loadingOfficePreview: boolean;
  officePreview: FileBinaryPreview | null;
  officePreviewKind: OfficeFilePreviewKind | null;
  loadingPptxPreview: boolean;
  pptxPreviewData: ArrayBuffer | null;
  pptxViewerLabels: PptxPreviewViewerLabels;
  pptxReferenceSource: PptxElementReferenceSource | null;
  pptxReferenceNavigation: PptxReferencePreviewNavigation | null;
  pptxReferenceNavigationReady: boolean;
  error: string | null;
  codePreviewSettings: CodePreviewSettings;
  codeTheme: BundledTheme;
  resolvedTheme: "light" | "dark";
  /** 应用主题（store 耦合剥离）：透传给 markdown/mermaid 预览，缺省按 "system" 兜底。 */
  theme?: Theme;
  workspacePath?: string;
  onOpenBrowserUrl?: (url: string) => void;
  markdownSelectionTarget?: MarkdownSelectionTarget;
  markdownViewMode: "preview" | "code";
  svgViewMode: "preview" | "code";
  wrapLongLines: boolean;
  codeComments: readonly CodeCommentPreview[];
  enableCodeLineSelection?: boolean;
  enableCodeGutterUtility?: boolean;
  codeCommentLabels: CodeCommentLabels;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
}

function isSvgPath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

function getPreviewPaneErrorTextClass(
  error: string | null,
  fileMissingMessage: string,
): "text-destructive" | "text-foreground-subtlest" {
  return error === fileMissingMessage ? "text-foreground-subtlest" : "text-destructive";
}

export function PreviewPaneContent({
  source,
  filePreview,
  fileTooLarge,
  loadingInitial,
  loadingImagePreview,
  imagePreview,
  mediaSource,
  loadingMediaPreview,
  mediaPreviewUrl,
  onMediaError,
  onMediaLoadedMetadata,
  loadingPdfPreview,
  pdfViewerSource,
  pdfViewerLabels,
  loadingOfficePreview,
  officePreview,
  officePreviewKind,
  loadingPptxPreview,
  pptxPreviewData,
  pptxViewerLabels,
  pptxReferenceSource,
  pptxReferenceNavigation,
  pptxReferenceNavigationReady,
  error,
  codePreviewSettings,
  codeTheme,
  resolvedTheme,
  theme,
  workspacePath,
  onOpenBrowserUrl,
  markdownSelectionTarget,
  markdownViewMode,
  svgViewMode,
  wrapLongLines,
  codeComments,
  enableCodeLineSelection = false,
  enableCodeGutterUtility = false,
  codeCommentLabels,
  onSubmitCodeComment,
  onDeleteCodeComment,
  onScroll,
  scrollContainerRef,
}: PreviewPaneContentProps) {
  const { intl } = useZCodeIntl();
  const fileMissingMessage = intl.formatMessage({ id: "codeViewer.fileMissing" });
  const mediaLabels = {
    loading: intl.formatMessage({ id: "codeViewer.loadingMedia" }),
    unavailable: intl.formatMessage({ id: "codeViewer.mediaUnavailable" }),
    unsupported: intl.formatMessage({ id: "codeViewer.mediaUnsupported" }),
  };
  const multiFileDiffFiles = useMemo(() => {
    if (source.type !== "multi-file-diff") {
      return null;
    }

    // DiffViewer 是 memo 组件，预览 pane 父级滚动/加载状态刷新时，
    // JSX 内联 oldFile/newFile 会生成新对象并强制 diff 重新渲染。
    return {
      oldFile: {
        name: source.path ?? source.title,
        contents: source.beforeContent,
        cacheKey: `old:${source.path ?? source.title}:${source.beforeContent.length}:${source.beforeContent.slice(0, 100)}:${source.beforeContent.slice(-100)}`,
      },
      newFile: {
        name: source.path ?? source.title,
        contents: source.afterContent,
        cacheKey: `new:${source.path ?? source.title}:${source.afterContent.length}:${source.afterContent.slice(0, 100)}:${source.afterContent.slice(-100)}`,
      },
    };
  }, [
    source.type,
    source.type === "multi-file-diff" ? source.afterContent : null,
    source.type === "multi-file-diff" ? source.beforeContent : null,
    source.type === "multi-file-diff" ? source.path : null,
    source.type === "multi-file-diff" ? source.title : null,
  ]);

  if (source.type === "patch") {
    return (
      // 兜底分支：patch 既不是 markdown/code/image，但仍然需要独立渲染。
      <PatchFallbackContent
        patch={source.patch}
        codePreviewSettings={codePreviewSettings}
        resolvedTheme={resolvedTheme}
        sourcePath={source.path}
        sourceTitle={source.title}
      />
    );
  }

  if (source.type === "multi-file-diff" && multiFileDiffFiles) {
    return (
      <DiffViewer
        oldFile={multiFileDiffFiles.oldFile}
        newFile={multiFileDiffFiles.newFile}
        diffClassName="block"
        fontSizePx={codePreviewSettings.fontSizePx}
        lightTheme={codePreviewSettings.lightTheme}
        darkTheme={codePreviewSettings.darkTheme}
        themeType={resolvedTheme}
      />
    );
  }

  if (source.type === "text") {
    const isMarkdownSource = source.language === "markdown";
    const isSvgSource = isSvgPath(source.path);
    if (isMarkdownSource && markdownViewMode === "preview") {
      return (
        <MarkdownPreviewContent
          selectionTarget={markdownSelectionTarget}
          sourceKey={
            source.path ??
            JSON.stringify([source.title, source.type === "text" ? source.content : ""])
          }
          sourceTitle={source.path ?? source.title}
          sourcePath={source.path}
          content={source.content}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      );
    }

    if (isSvgSource && svgViewMode === "preview") {
      return <SvgPreviewContent title={source.title} svgContent={source.content} />;
    }

    return (
      <CodeContent
        code={source.content}
        language={source.language}
        codePreviewSettings={codePreviewSettings}
        codeTheme={codeTheme}
        theme={theme}
        wrapLongLines={wrapLongLines}
        comments={codeComments}
        enableLineSelection={enableCodeLineSelection}
        enableGutterUtility={enableCodeGutterUtility}
        labels={codeCommentLabels}
        onSubmitCodeComment={onSubmitCodeComment}
        onDeleteCodeComment={onDeleteCodeComment}
        onScroll={onScroll}
        scrollContainerRef={scrollContainerRef}
      />
    );
  }

  if (source.type === "image") {
    if (loadingImagePreview || (!error && !imagePreview)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingImage" })}
        </div>
      );
    }

    if (error || !imagePreview) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.imageUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return (
      <ImagePreviewContent
        title={source.title}
        imageSource={`data:${imagePreview.mediaType};base64,${imagePreview.dataBase64}`}
        sourcePath={source.path}
      />
    );
  }

  if (source.type === "media" && mediaSource) {
    return (
      <PreviewPaneMediaContent
        error={error}
        labels={mediaLabels}
        loading={loadingMediaPreview}
        onMediaError={onMediaError}
        onMediaLoadedMetadata={onMediaLoadedMetadata}
        source={mediaSource}
        url={mediaPreviewUrl}
      />
    );
  }

  if (source.type === "pdf") {
    if (loadingPdfPreview || (!error && !pdfViewerSource)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingPdf" })}
        </div>
      );
    }

    if (error || !pdfViewerSource) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.pdfUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return <PdfPreviewContent source={pdfViewerSource} labels={pdfViewerLabels} />;
  }

  if (source.type === "file" && officePreviewKind) {
    return (
      <PreviewPaneOfficeContent
        error={error}
        kind={officePreviewKind}
        loading={loadingOfficePreview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        preview={officePreview}
        resolvedTheme={resolvedTheme}
        sourcePath={source.path}
      />
    );
  }

  if (source.type === "pptx") {
    if (loadingPptxPreview || (!error && !pptxPreviewData)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingPptx" })}
        </div>
      );
    }

    if (error || !pptxPreviewData) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.pptxUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return (
      <PptxPreviewContent
        data={pptxPreviewData}
        labels={pptxViewerLabels}
        fileName={source.path}
        onOpenBrowserUrl={onOpenBrowserUrl}
        {...(pptxReferenceSource ? { referenceSource: pptxReferenceSource } : {})}
        {...(pptxReferenceNavigation ? { referenceNavigation: pptxReferenceNavigation } : {})}
        referenceNavigationReady={pptxReferenceNavigationReady}
      />
    );
  }

  if (loadingInitial && !filePreview) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.loadingFile" })}
      </div>
    );
  }

  if (error && !filePreview) {
    return (
      <div
        className={`p-3 text-ui-base ${getPreviewPaneErrorTextClass(error, fileMissingMessage)}`}
      >
        {error}
      </div>
    );
  }

  if (fileTooLarge) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.fileTooLarge" })}
      </div>
    );
  }

  if (!filePreview) {
    return null;
  }

  if (filePreview.isBinary) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.binary" })}
      </div>
    );
  }

  if (filePreview.content.length === 0) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.empty" })}
      </div>
    );
  }

  const fileLanguage = inferCodeLanguage(source.path, filePreview.content);
  const codeReviewProjection =
    source.type === "code-review"
      ? resolveCodeReviewContentProjection(source, filePreview.content)
      : null;
  const isMarkdownFile = fileLanguage === "markdown";
  const isSvgFile = isSvgPath(source.path);
  if (source.type !== "code-review" && isMarkdownFile && markdownViewMode === "preview") {
    return (
      <MarkdownPreviewContent
        selectionTarget={markdownSelectionTarget}
        sourceKey={source.path ?? source.title}
        sourceTitle={source.path ?? source.title}
        sourcePath={source.path}
        content={filePreview.content}
        workspacePath={workspacePath}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    );
  }

  if (source.type !== "code-review" && isSvgFile && svgViewMode === "preview") {
    return <SvgPreviewContent title={source.title} svgContent={filePreview.content} />;
  }

  return (
    <CodeContent
      code={filePreview.content}
      language={fileLanguage}
      codePreviewSettings={codePreviewSettings}
      codeTheme={codeTheme}
      theme={theme}
      wrapLongLines={wrapLongLines}
      comments={codeReviewProjection?.inlineComments ?? codeComments}
      topComment={codeReviewProjection?.topComment}
      topCommentShowRange={false}
      topCommentNotice={
        codeReviewProjection?.targetLineOutOfRange
          ? intl.formatMessage({ id: "codeViewer.review.targetLineMissing" })
          : undefined
      }
      focusedRange={codeReviewProjection?.focusedRange}
      focusRequestId={source.type === "code-review" ? source.review.requestId : undefined}
      enableLineSelection={source.type === "code-review" ? false : enableCodeLineSelection}
      enableGutterUtility={source.type === "code-review" ? false : enableCodeGutterUtility}
      labels={codeCommentLabels}
      onSubmitCodeComment={source.type === "code-review" ? undefined : onSubmitCodeComment}
      onDeleteCodeComment={source.type === "code-review" ? undefined : onDeleteCodeComment}
      onScroll={onScroll}
      scrollContainerRef={scrollContainerRef}
    />
  );
}
