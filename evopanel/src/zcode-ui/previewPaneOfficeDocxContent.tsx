import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderAsync, type Options } from "docx-preview";
import {
  calculateDocxPreviewFit,
  installDocumentLinkSafety,
  type DocxPreviewFit,
} from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

const DOCX_RENDER_OPTIONS = {
  breakPages: true,
  debug: false,
  experimental: true,
  ignoreFonts: false,
  ignoreHeight: false,
  // docx-preview@0.4.0 在该选项为 false 时会合并纸张尺寸相同、
  // 但页边距不同的相邻 section，导致封面后的正文丢失分页并沿用封面的零边距。
  // 保持官方预览的默认行为，优先保留 OOXML section 边界和各页 pgMar。
  ignoreLastRenderedPageBreak: true,
  ignoreWidth: false,
  inWrapper: true,
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  renderEndnotes: true,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
  useBase64URL: true,
} satisfies Partial<Options>;

const DOCX_PAGE_BOX_SHADOW = "0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)";

let nextDocxPreviewClassId = 0;

function createDocxPreviewClassName(): string {
  nextDocxPreviewClassId += 1;
  return `zcode-docx-preview-${nextDocxPreviewClassId}`;
}

function isSameDocxPreviewFit(current: DocxPreviewFit | null, next: DocxPreviewFit): boolean {
  return (
    current !== null &&
    Math.abs(current.scale - next.scale) < 0.001 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

export function PreviewPaneOfficeDocxContent({
  buffer,
  errorMessage,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewClassName] = useState(createDocxPreviewClassName);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");

  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || renderState !== "ready") {
      return;
    }

    const next = calculateDocxPreviewFit({
      availableWidth: viewport.clientWidth,
      naturalHeight: content.offsetHeight,
      naturalWidth: content.offsetWidth,
    });
    if (!next) {
      return;
    }

    setFit((current) => {
      if (isSameDocxPreviewFit(current, next)) {
        return current;
      }
      // 调试说明：拖动 Preview Pane 时会按帧触发 ResizeObserver；高频尺寸轨迹只走 debug，
      // 生产构建不落盘，避免响应式布局把日志量放大到和 resize 事件同数量级。
      logger.debug("[PreviewPane] DOCX 预览宽度已同步", {
        path: sourcePath,
        availableWidth: viewport.clientWidth,
        naturalWidth: content.offsetWidth,
        scale: next.scale,
      });
      return next;
    });
  }, [renderState, sourcePath]);

  useEffect(() => {
    const visibleContainer = renderContainerRef.current;
    if (!visibleContainer) {
      return;
    }

    let active = true;
    let disposeLinkSafety: (() => void) | undefined;
    const className = previewClassName;
    const renderRoot = document.createElement("div");
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    renderRoot.dataset.docxRenderRoot = "";
    styleContainer.dataset.docxRenderStyles = "";
    bodyContainer.dataset.docxRenderBody = "";
    renderRoot.append(styleContainer, bodyContainer);

    setRenderState("loading");
    setFit(null);
    visibleContainer.replaceChildren();

    void renderAsync(buffer, bodyContainer, styleContainer, {
      ...DOCX_RENDER_OPTIONS,
      className,
    })
      .then(() => {
        if (!active) {
          return;
        }

        const wrapper = bodyContainer.querySelector<HTMLElement>(`.${className}-wrapper`);
        if (wrapper) {
          // docx-preview 默认给页面包装层写入灰色背景和固定 30px padding，
          // 会与 Preview Pane 主题冲突，也会让窄屏缩放把装饰间距算进纸张宽度。
          wrapper.style.background = "transparent";
          wrapper.style.padding = "0";
          wrapper.style.width = "max-content";
        }

        // docx-preview 默认使用 50% 黑色页面阴影，在 Preview Pane 中会形成过深黑边；
        // 追加作用域样式复用原 react-docx 的浅色纸张阴影，并一次覆盖当前文档的所有页面。
        const pageSurfaceStyle = document.createElement("style");
        pageSurfaceStyle.dataset.docxPageSurfaceStyle = "";
        pageSurfaceStyle.textContent = `.${className}-wrapper>section.${className} { box-shadow: ${DOCX_PAGE_BOX_SHADOW}; }`;
        styleContainer.append(pageSurfaceStyle);

        disposeLinkSafety = installDocumentLinkSafety(renderRoot, onOpenBrowserUrl);

        visibleContainer.replaceChildren(renderRoot);
        setRenderState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error("[PreviewPane] DOCX 文件解析失败", {
          path: sourcePath,
          error: message,
        });
        visibleContainer.replaceChildren();
        setRenderState("error");
      });

    return () => {
      // renderAsync 不提供取消能力；切换文件后只允许最新 source 提交可见 DOM，
      // 旧任务即使稍后完成也只能停留在脱离文档树的临时容器中。
      active = false;
      disposeLinkSafety?.();
      renderRoot.remove();
      visibleContainer.replaceChildren();
    };
  }, [buffer, onOpenBrowserUrl, previewClassName, sourcePath]);

  useLayoutEffect(() => {
    if (renderState !== "ready") {
      return;
    }

    updateFit();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateFit);
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current);
    }
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      resizeObserver.disconnect();
    };
  }, [renderState, updateFit]);

  return (
    <div
      aria-busy={renderState === "loading" ? "true" : undefined}
      className="h-full min-h-0 w-full min-w-0 bg-background"
      data-office-preview-kind="docx"
      data-office-preview-pending={renderState === "loading" ? "" : undefined}
    >
      {renderState === "error" ? (
        <div className="p-3 text-ui-base text-destructive" role="alert">
          {errorMessage}
        </div>
      ) : null}
      <div
        className={
          renderState === "error"
            ? "hidden"
            : "h-full min-h-0 w-full min-w-0 overflow-auto p-4 max-sm:p-2"
        }
      >
        <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
          <div
            className="relative mx-auto"
            data-docx-fit-frame
            style={fit ? { width: fit.width, height: fit.height } : undefined}
          >
            {/* docx-preview 保留纸张原始宽度；窄 Preview Pane 需要只缩小不放大，
                并同步包装层宽高，避免单独 transform 后仍保留未缩放的横向滚动区。 */}
            <div
              ref={contentRef}
              className="w-max"
              data-docx-fit-content
              style={
                fit
                  ? {
                      position: "absolute",
                      left: 0,
                      top: 0,
                      transform: `scale(${fit.scale})`,
                      transformOrigin: "top left",
                    }
                  : undefined
              }
            >
              <div ref={renderContainerRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
