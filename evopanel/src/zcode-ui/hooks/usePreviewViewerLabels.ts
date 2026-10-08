import { useMemo } from "react";
import type { PdfViewerLabels } from "@/components/ui/pdf-viewer.js";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 两个重量级叶子查看器（PDF / PPTX）的本地化标签。
 *
 * 抽出来的理由：`PreviewPane` 与 dwf 的 `workflow-artifact` tab 都要喂同一批 `codeViewer.*`
 * 文案给同一对组件。各写一份的结果是其中一处漏译或漏一个键——而这两个 labels 对象都是
 * **必填全字段**的接口，漏一个是类型错误，漏译却只是运行时看到 message id。
 */
export function usePdfViewerLabels(): PdfViewerLabels {
  const { intl } = useZCodeIntl();
  return useMemo(
    () => ({
      loading: intl.formatMessage({ id: "codeViewer.pdf.loading" }),
      loadError: intl.formatMessage({ id: "codeViewer.pdf.loadError" }),
      noData: intl.formatMessage({ id: "codeViewer.pdf.noData" }),
      previousPage: intl.formatMessage({ id: "codeViewer.pdf.previousPage" }),
      nextPage: intl.formatMessage({ id: "codeViewer.pdf.nextPage" }),
      pageInput: intl.formatMessage({ id: "codeViewer.pdf.pageInput" }),
      zoomIn: intl.formatMessage({ id: "codeViewer.pdf.zoomIn" }),
      zoomOut: intl.formatMessage({ id: "codeViewer.pdf.zoomOut" }),
    }),
    [intl],
  );
}

export function usePptxViewerLabels(): PptxPreviewViewerLabels {
  const { intl } = useZCodeIntl();
  return useMemo<PptxPreviewViewerLabels>(
    () => ({
      loading: intl.formatMessage({ id: "codeViewer.pptx.loading" }),
      loadError: intl.formatMessage({ id: "codeViewer.pptx.loadError" }),
      noSlides: intl.formatMessage({ id: "codeViewer.pptx.noSlides" }),
      previousPage: intl.formatMessage({ id: "codeViewer.pptx.previousPage" }),
      nextPage: intl.formatMessage({ id: "codeViewer.pptx.nextPage" }),
      pageInput: intl.formatMessage({ id: "codeViewer.pptx.pageInput" }),
      zoomIn: intl.formatMessage({ id: "codeViewer.pptx.zoomIn" }),
      zoomOut: intl.formatMessage({ id: "codeViewer.pptx.zoomOut" }),
      thumbnails: intl.formatMessage({ id: "codeViewer.pptx.thumbnails" }),
      thumbnail: (pageNumber) =>
        intl.formatMessage({ id: "codeViewer.pptx.thumbnail" }, { pageNumber: String(pageNumber) }),
      exportPdf: intl.formatMessage({ id: "codeViewer.pptx.exportPdf" }),
      exportingPdf: intl.formatMessage({ id: "codeViewer.pptx.exportingPdf" }),
      exportPdfSuccess: (path) =>
        intl.formatMessage({ id: "codeViewer.pptx.exportPdfSuccess" }, { path }),
      exportPdfFailed: intl.formatMessage({ id: "codeViewer.pptx.exportPdfFailed" }),
      selectElement: intl.formatMessage({ id: "codeViewer.pptx.selectElement" }),
      exitElementSelection: intl.formatMessage({ id: "codeViewer.pptx.exitElementSelection" }),
      aiEdit: intl.formatMessage({ id: "codeViewer.pptx.aiEdit" }),
      commentPlaceholder: intl.formatMessage({ id: "codeViewer.pptx.commentPlaceholder" }),
      cancelAiEdit: intl.formatMessage({ id: "codeViewer.pptx.cancelAiEdit" }),
      addToConversation: intl.formatMessage({ id: "codeViewer.pptx.addToConversation" }),
      referencedPageMissing: (pageNumber) =>
        intl.formatMessage(
          { id: "chat.pptxElements.previewPageMissing" },
          { pageNumber: String(pageNumber) },
        ),
      referencedSourceChanged: (pageNumber) =>
        intl.formatMessage(
          { id: "chat.pptxElements.previewSourceChanged" },
          { pageNumber: String(pageNumber) },
        ),
    }),
    [intl],
  );
}
