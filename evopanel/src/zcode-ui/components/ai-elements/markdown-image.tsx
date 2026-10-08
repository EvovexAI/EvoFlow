"use client";

import type { FileMediaPreview } from "@zcode/shared";
import { decodeMarkdownArtifactImageSource } from "@zcode/shared";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import { Children, isValidElement } from "react";
import type { ComponentProps, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  sanitizeImageSourceForLog,
  type ImagePreviewDialogItem,
} from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImagePreviewPath } from "@/lib/codeViewer.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import { logger } from "@/logger.js";

export { clampImagePreviewOffset as clampMarkdownImagePreviewOffset } from "@/components/ai-elements/image-preview-dialog.js";

export type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  workspacePath?: string;
  workspaceHomePath?: string;
  sessionId?: string;
  readAttachment?: (params: {
    sessionId: string;
    ref: string;
  }) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
};

const markdownImageOnlyLinePattern = /^\s*!\[[^\]]*]\([^\n]+\)\s*$/;
const markdownFenceLinePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Streamdown 会在 rehype 前按空行拆块。仅移除连续纯图片行之间的空行，让同组图片进入
 * 同一个 Markdown 块；代码围栏里的相似文本必须保持原样。
 */
export function normalizeConsecutiveMarkdownImageBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let activeFenceMarker: "`" | "~" | null = null;
  let activeFenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(markdownFenceLinePattern);
    const fenceRun = fenceMatch?.[2];
    if (fenceRun) {
      const marker = fenceRun[0] as "`" | "~";
      const suffix = fenceMatch[3] ?? "";
      if (
        activeFenceMarker === marker &&
        fenceRun.length >= activeFenceLength &&
        suffix.trim() === ""
      ) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      } else if (!activeFenceMarker && (marker === "~" || !suffix.includes("`"))) {
        activeFenceMarker = marker;
        activeFenceLength = fenceRun.length;
      }
      normalized.push(line);
      continue;
    }

    if (!activeFenceMarker && markdownImageOnlyLinePattern.test(line)) {
      normalized.push(line);
      let nextIndex = index + 1;
      while (nextIndex < lines.length && !(lines[nextIndex] ?? "").trim()) {
        nextIndex += 1;
      }
      if (
        nextIndex > index + 1 &&
        nextIndex < lines.length &&
        markdownImageOnlyLinePattern.test(lines[nextIndex] ?? "")
      ) {
        index = nextIndex - 1;
      }
      continue;
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

/**
 * Streamdown 的 harden 会过滤 rehype 自定义属性，因此在 React component mapping
 * 层识别纯图片段落，确保画廊标记和响应式 class 不会被安全层剥离。
 */
export function MarkdownImageParagraph({
  children,
  node: _node,
  ...props
}: ComponentProps<"p"> & { node?: unknown }) {
  const meaningfulChildren = Children.toArray(children).filter(
    (child) => typeof child !== "string" || child.trim().length > 0,
  );
  const isImageGallery =
    meaningfulChildren.length >= 2 &&
    meaningfulChildren.every(
      (child) =>
        isValidElement(child) &&
        (child.props as { node?: { tagName?: string } }).node?.tagName === "img",
    );

  if (isImageGallery) {
    return (
      <ImageThumbnailGallery data-markdown-image-gallery="">
        {meaningfulChildren}
      </ImageThumbnailGallery>
    );
  }

  return <p {...props}>{children}</p>;
}

function formatMediaPreviewDataUrl(preview: FileMediaPreview): string {
  return `data:${preview.mediaType};base64,${preview.dataBase64}`;
}

function readPreviewGroup(target: HTMLButtonElement): ImagePreviewDialogItem[] {
  const gallery = target.closest("[data-markdown-image-gallery]");
  const buttons = gallery
    ? Array.from(gallery.querySelectorAll<HTMLButtonElement>("[data-markdown-image-trigger]"))
    : [target];
  return buttons.flatMap((button) => {
    const image = button.querySelector<HTMLImageElement>("img[data-markdown-image]");
    return image?.src ? [{ alt: image.alt, filename: image.alt, src: image.src }] : [];
  });
}

export function MarkdownImage({
  alt,
  className,
  node: _node,
  onError,
  onLoad,
  readAttachment,
  sessionId,
  src,
  workspacePath,
  workspaceHomePath,
  ...props
}: MarkdownImageProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const resolvedSrc = typeof src === "string" ? src : "";
  const artifactRef = useMemo(() => decodeMarkdownArtifactImageSource(resolvedSrc), [resolvedSrc]);
  const localImageLink = useMemo(() => {
    const fileLink = resolveMarkdownFileLink(workspacePath, resolvedSrc, {
      homePath: workspaceHomePath,
    });
    return fileLink && isImagePreviewPath(fileLink.path) ? fileLink : null;
  }, [resolvedSrc, workspaceHomePath, workspacePath]);
  const [localImageDataUrl, setLocalImageDataUrl] = useState<string | null>(null);
  const [localImageFailed, setLocalImageFailed] = useState(false);
  const [artifactImageUrl, setArtifactImageUrl] = useState<string | null>(null);
  const [artifactImageFailed, setArtifactImageFailed] = useState(false);
  const [previewItems, setPreviewItems] = useState<ImagePreviewDialogItem[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [browserImageState, setBrowserImageState] = useState<{
    source: string;
    status: "loading" | "loaded" | "error";
  }>({ source: "", status: "loading" });
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setLocalImageDataUrl(null);
    setLocalImageFailed(false);
    if (!localImageLink || !services) return;

    let disposed = false;
    services.fileService
      .readMediaPreview({ path: localImageLink.path })
      .then((preview) => {
        if (!disposed) setLocalImageDataUrl(formatMediaPreviewDataUrl(preview));
      })
      .catch((error) => {
        if (disposed) return;
        setLocalImageFailed(true);
        logger.warn("[MarkdownImage] markdown 本地图片预览失败", {
          path: localImageLink.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [localImageLink, services]);

  useEffect(
    () => () => {
      // 关闭预览后的异步焦点恢复可能晚于消息节点卸载，
      // 必须取消旧任务，避免焦点落到已脱离文档的图片按钮。
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setArtifactImageUrl(null);
    setArtifactImageFailed(false);
    if (!artifactRef) return;
    if (!sessionId || !readAttachment) {
      setArtifactImageFailed(true);
      return;
    }

    let disposed = false;
    let objectUrl: string | null = null;
    readAttachment({ sessionId, ref: artifactRef })
      .then((result) => {
        if (disposed) return;
        if ("url" in result) {
          setArtifactImageUrl(result.url);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
        );
        setArtifactImageUrl(objectUrl);
      })
      .catch((error) => {
        if (disposed) return;
        setArtifactImageFailed(true);
        logger.warn("[MarkdownImage] assistant artifact 图片预览失败", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactRef, readAttachment, sessionId]);

  const displaySrc = artifactRef
    ? artifactImageUrl
    : localImageLink
      ? localImageDataUrl
      : resolvedSrc;
  if (!resolvedSrc) return null;
  if ((artifactRef || localImageLink) && !displaySrc) {
    const failed = artifactRef ? artifactImageFailed : localImageFailed;
    return (
      <div
        aria-label={failed ? intl.formatMessage({ id: "codeViewer.imageUnavailable" }) : undefined}
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-xl border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground-subtle md:h-44 md:w-56 md:shrink-0",
          className,
        )}
        data-markdown-local-image={failed ? "error" : "loading"}
        role={failed ? "img" : "status"}
        title={localImageLink?.path}
      >
        {failed ? (
          <ImageOffIcon aria-hidden="true" className="size-6" />
        ) : (
          intl.formatMessage({ id: "common.loading" })
        )}
      </div>
    );
  }
  const effectiveImageStatus =
    browserImageState.source === displaySrc ? browserImageState.status : "loading";
  if (effectiveImageStatus === "error") {
    return (
      <div
        aria-label={intl.formatMessage({ id: "codeViewer.imageUnavailable" })}
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-xl border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground-subtle md:h-44 md:w-56 md:shrink-0",
          className,
        )}
        data-markdown-image-state="error"
        role="img"
        title={localImageLink?.path}
      >
        <ImageOffIcon aria-hidden="true" className="size-6" />
      </div>
    );
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    const items = readPreviewGroup(event.currentTarget);
    setPreviewItems(items);
    setPreviewIndex(
      Math.max(
        0,
        items.findIndex((item) => item.src === displaySrc),
      ),
    );
    setPreviewOpen(true);
  };
  const imageAlt = alt || intl.formatMessage({ id: "chat.attachments.preview.title" });
  const handlePreviewOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open) {
      // Dialog 关闭后手动将焦点归还图片触发按钮，避免焦点落到 body，
      // 让键盘用户能够从原图继续浏览消息。
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = window.setTimeout(() => {
        previewTriggerRef.current?.focus();
        focusTimerRef.current = null;
      }, 0);
    }
  };

  return (
    <>
      <button
        ref={previewTriggerRef}
        type="button"
        aria-label={intl.formatMessage({ id: "chat.attachments.preview.open" })}
        className={cn(
          imageThumbnailTriggerClassName,
          effectiveImageStatus === "loading" &&
            // 画廊父级的响应式 w-auto/h-44 选择器优先级高于普通尺寸类，
            // 加载态内部又是绝对定位，导致按钮宽度塌缩；仅在加载期间强制固定方形。
            "relative !h-44 !w-44 !max-w-full cursor-default",
        )}
        data-image-thumbnail-trigger=""
        data-markdown-image-trigger=""
        onClick={openPreview}
        title={localImageLink?.path}
      >
        {effectiveImageStatus === "loading" ? (
          <span
            aria-label={intl.formatMessage({ id: "common.loading" })}
            className="markdown-image-loading-shimmer absolute inset-0 flex size-full items-center justify-center text-foreground-subtle"
            data-markdown-image-state="loading"
            role="status"
          >
            <ImageIcon aria-hidden="true" className="size-6" />
          </span>
        ) : null}
        <img
          // React 复用同一 img 时，旧资源的异步事件可能命中新 src 的处理器。
          // 按资源重建节点，确保 load/error 只更新触发该事件的图片状态。
          key={displaySrc}
          alt={imageAlt}
          className={cn(
            imageThumbnailClassName,
            effectiveImageStatus === "loading" && "invisible",
            className,
          )}
          data-markdown-image=""
          data-streamdown="image"
          draggable={false}
          loading="lazy"
          onError={(event) => {
            // 远程 Markdown 图片不能直接交给浏览器渲染：加载失败时既没有状态，
            // 也没有运行时轨迹，用户只能看到空白区域。
            setBrowserImageState({ source: displaySrc ?? "", status: "error" });
            logger.warn("[MarkdownImage] markdown 图片加载失败", {
              source: sanitizeImageSourceForLog(displaySrc ?? ""),
            });
            onError?.(event);
          }}
          onLoad={(event) => {
            setBrowserImageState({ source: displaySrc ?? "", status: "loaded" });
            onLoad?.(event);
          }}
          src={displaySrc ?? undefined}
          {...props}
        />
      </button>
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={handlePreviewOpenChange}
        open={previewOpen}
      />
    </>
  );
}
