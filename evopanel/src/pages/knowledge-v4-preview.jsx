/**
 * Thin V4 adapters for the owned-knowledge reader:
 * - MessageResponse (same Streamdown stack as chat V4)
 * - WorkspaceFileTree (same panel as workspace-browse), filtered to KB-supported files
 * - Original-file preview (PDF / Office) for 原文件 ↔ MD toggle
 */
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/tauri-api.js";
import { findOwnedDocByWorkspacePath } from "../lib/knowledge-owned-path.js";
import {
  isSupportedKnowledgeFile,
  shouldSkipKnowledgeDir,
  shouldSkipKnowledgeFile,
} from "../lib/knowledge-file-filter.js";
import { evoflowStubPlatform } from "./settings/evoflow-bridge-services.js";
import { MessageResponse } from "../zcode-ui/components/ai-elements/message.js";
import { MarkdownTableVariantProvider } from "../zcode-ui/components/ai-elements/markdownTableVariant.js";
import { TooltipProvider } from "../zcode-ui/components/ui/tooltip.js";
import { PlatformProvider } from "../zcode-ui/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../zcode-ui/i18n/IntlProvider.js";
import { getOfficeFilePreviewKind } from "../zcode-ui/lib/officeFilePreview.js";
import { V4WorkspaceFileTreePane } from "../react/chat-app/right-stage/v4-workspace-file-tree-pane.js";
import "@/styles-bridge.css";

export { findOwnedDocByWorkspacePath };

const LazyDocxContent = lazy(async () => {
  const module = await import("../zcode-ui/previewPaneOfficeDocxContent.js");
  return { default: module.PreviewPaneOfficeDocxContent };
});

const LazyXlsxContent = lazy(async () => {
  const module = await import("../zcode-ui/previewPaneOfficeXlsxContent.js");
  return { default: module.PreviewPaneOfficeXlsxContent };
});

const LazyLegacyDocContent = lazy(async () => {
  const module = await import("../zcode-ui/previewPaneOfficeLegacyDocContent.js");
  return { default: module.PreviewPaneOfficeLegacyDocContent };
});

const LazyPptxContent = lazy(async () => {
  const module = await import("../zcode-ui/previewPanePptxContent.js");
  return { default: module.PptxPreviewContent };
});

const PPTX_LABELS = {
  loading: "加载演示文稿…",
  loadError: "演示文稿预览失败",
  noSlides: "没有幻灯片",
  previousPage: "上一页",
  nextPage: "下一页",
  pageInput: "页码",
  zoomIn: "放大",
  zoomOut: "缩小",
  thumbnails: "缩略图",
  thumbnail: (pageNumber) => `第 ${pageNumber} 页`,
  exportPdf: "导出 PDF",
  exportingPdf: "正在导出…",
  exportPdfSuccess: (path) => `已导出：${path}`,
  exportPdfFailed: "导出失败",
  selectElement: "选择元素",
  exitElementSelection: "退出选择",
  aiEdit: "AI 编辑",
  commentPlaceholder: "输入说明…",
  cancelAiEdit: "取消",
  addToConversation: "加入对话",
  referencedPageMissing: (pageNumber) => `找不到第 ${pageNumber} 页`,
  referencedSourceChanged: (pageNumber) => `第 ${pageNumber} 页内容已变化`,
};

function isPdfName(name) {
  return /\.pdf$/i.test(String(name || ""));
}

function isPptxName(name) {
  return /\.pptx?$/i.test(String(name || ""));
}

/** True when the original file has a distinct binary preview path (not plain text/md). */
export function isKnowledgeBinaryOriginal(fileName) {
  const name = String(fileName || "");
  if (isPdfName(name) || isPptxName(name)) return true;
  return getOfficeFilePreviewKind(name) != null;
}

export function KnowledgeV4Markdown({ content, className = "" }) {
  const text = String(content || "");
  // 对齐聊天 V4：MessageResponse + 同一套宿主（缺 Platform/Intl 会整段降级成原文）。
  return (
    <div
      className={`zcode-bridge-root ko-v4-md ${className}`.trim()}
      data-markdown-preview="true"
      data-testid="ko-v4-md"
    >
      <ZCodeIntlProvider initialLocale="zh-CN">
        <PlatformProvider platform={evoflowStubPlatform}>
          <MarkdownTableVariantProvider value="evoflow">
            <TooltipProvider delayDuration={0}>
              <div className="ko-v4-md__inner">
                <MessageResponse className="min-w-0 break-words" theme="system">
                  {text}
                </MessageResponse>
              </div>
            </TooltipProvider>
          </MarkdownTableVariantProvider>
        </PlatformProvider>
      </ZCodeIntlProvider>
    </div>
  );
}

/**
 * Original-file preview for owned KB docs (PDF iframe / Office / PPTX).
 * Text-like originals are rendered by the parent via KnowledgeV4Markdown.
 */
export function KnowledgeOriginalFilePreview({ docId, fileName, title = "" }) {
  const name = String(fileName || "");
  const officeKind = useMemo(() => getOfficeFilePreviewKind(name), [name]);
  const pdf = isPdfName(name);
  const pptx = isPptxName(name);
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [objectUrl, setObjectUrl] = useState("");
  const [officeBuffer, setOfficeBuffer] = useState(null);
  const [pptxBuffer, setPptxBuffer] = useState(null);
  const [error, setError] = useState("");

  const resolvedTheme = useMemo(() => {
    if (typeof document === "undefined") return "light";
    const root = document.documentElement;
    const theme = root.getAttribute("data-theme") || "";
    if (theme === "dark" || root.classList.contains("dark")) return "dark";
    return "light";
  }, []);

  useEffect(() => {
    if (!docId) {
      setPhase("error");
      setError("缺少文档");
      return undefined;
    }
    let cancelled = false;
    let createdUrl = "";
    setPhase("loading");
    setError("");
    setObjectUrl("");
    setOfficeBuffer(null);
    setPptxBuffer(null);

    (async () => {
      try {
        // 让出一帧，先画出「加载原文件…」，避免点选卡死感
        await new Promise((r) => requestAnimationFrame(() => r()));
        if (cancelled) return;
        const blob = await api.fetchOwnedKnowledgeDocumentFileBlob(docId);
        if (cancelled) return;
        if (pdf) {
          createdUrl = URL.createObjectURL(blob);
          setObjectUrl(createdUrl);
          setPhase("ready");
          return;
        }
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;
        if (officeKind) {
          // 直接喂 ArrayBuffer，避免整文件同步 base64 卡主线程
          setOfficeBuffer(buffer);
          setPhase("ready");
          return;
        }
        if (pptx) {
          setPptxBuffer(buffer);
          setPhase("ready");
          return;
        }
        setError("该格式暂不支持原文件预览，请切换到 MD");
        setPhase("error");
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || "原文件加载失败");
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [docId, pdf, pptx, officeKind]);

  if (phase === "loading") {
    return <div className="ko-empty">加载原文件…</div>;
  }
  if (phase === "error") {
    return (
      <div className="ko-empty" data-testid="ko-original-error">
        {error || "原文件预览失败，可切换到 MD 查看解析正文。"}
      </div>
    );
  }

  if (pdf && objectUrl) {
    return (
      <article className="ko-page-body ko-page-body--pdf" data-testid="ko-pdf-frame">
        <object
          className="ko-pdf-iframe"
          data={objectUrl}
          type="application/pdf"
          title={title || "PDF"}
        >
          <iframe className="ko-pdf-iframe" src={objectUrl} title={title || "PDF"} />
        </object>
      </article>
    );
  }

  if (officeKind && officeBuffer) {
    const officeError = "Office 预览失败";
    const sourcePath = name || "document";
    return (
      <article
        className="ko-page-body ko-page-body--original zcode-bridge-root"
        data-testid="ko-office-original"
      >
        <ZCodeIntlProvider initialLocale="zh-CN">
          <Suspense fallback={<div className="ko-empty">加载 Office 预览…</div>}>
            {officeKind === "excel" ? (
              <LazyXlsxContent
                buffer={officeBuffer}
                errorMessage={officeError}
                isDark={resolvedTheme === "dark"}
                sourcePath={sourcePath}
              />
            ) : officeKind === "docx" ? (
              <LazyDocxContent
                buffer={officeBuffer}
                errorMessage={officeError}
                sourcePath={sourcePath}
              />
            ) : (
              <LazyLegacyDocContent
                buffer={officeBuffer}
                errorMessage={officeError}
                sourcePath={sourcePath}
              />
            )}
          </Suspense>
        </ZCodeIntlProvider>
      </article>
    );
  }

  if (pptx && pptxBuffer) {
    return (
      <article
        className="ko-page-body ko-page-body--original zcode-bridge-root"
        data-testid="ko-pptx-original"
      >
        <ZCodeIntlProvider initialLocale="zh-CN">
          <Suspense fallback={<div className="ko-empty">加载演示文稿…</div>}>
            <LazyPptxContent data={pptxBuffer} fileName={name} labels={PPTX_LABELS} />
          </Suspense>
        </ZCodeIntlProvider>
      </article>
    );
  }

  return (
    <div className="ko-empty" data-testid="ko-original-error">
      该格式暂不支持原文件预览，请切换到 MD。
    </div>
  );
}

export function KnowledgeV4FileTree({
  workspacePath,
  activePreviewPath = null,
  onOpenFile,
  className = "",
}) {
  const root = String(workspacePath || "").trim();
  const active = useMemo(() => activePreviewPath || null, [activePreviewPath]);
  const acceptFileName = useCallback((fileName) => {
    const name = String(fileName || "");
    if (!name || shouldSkipKnowledgeFile(name)) return false;
    return isSupportedKnowledgeFile(name);
  }, []);
  const acceptDirectoryName = useCallback((dirName) => {
    return !shouldSkipKnowledgeDir(dirName);
  }, []);

  if (!root) {
    return <div className="ko-empty" style={{ padding: 16 }}>未绑定本地文件夹</div>;
  }
  return (
    <div className={`ko-zcode-file-tree zcode-bridge-root h-full min-h-0 ${className}`.trim()}>
      <V4WorkspaceFileTreePane
        workspacePath={root}
        activePreviewPath={active}
        acceptFileName={acceptFileName}
        acceptDirectoryName={acceptDirectoryName}
        hideEmptyDirectories
        onClose={() => {}}
        onOpenCodeViewer={(source) => {
          const path =
            source && typeof source === "object"
              ? String(source.path || source.filePath || source.absolutePath || "")
              : "";
          if (!path) return;
          const leaf = path.replace(/\\/g, "/").split("/").pop() || "";
          if (!acceptFileName(leaf)) return;
          onOpenFile?.(path, source);
        }}
      />
    </div>
  );
}
