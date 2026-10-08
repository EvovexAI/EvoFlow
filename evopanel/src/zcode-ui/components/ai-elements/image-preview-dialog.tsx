"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export interface ImagePreviewDialogItem {
  alt: string;
  error?: boolean;
  filename?: string;
  loading?: boolean;
  mediaType?: string;
  src?: string;
}

interface PreviewOffset {
  x: number;
  y: number;
}

interface PreviewSize {
  height: number;
  width: number;
}

const defaultPreviewOffset: PreviewOffset = { x: 0, y: 0 };
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const imageExtensionByMediaType: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

export function clampImagePreviewOffset(
  offset: PreviewOffset,
  scale: number,
  imageSize: PreviewSize,
  viewportSize: PreviewSize,
): PreviewOffset {
  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportSize.height) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

function safeDownloadBaseName(item: ImagePreviewDialogItem) {
  return (
    (item.filename || item.alt)
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
      .slice(0, 80) || "image"
  );
}

class ImageDownloadError extends Error {
  constructor(readonly code: "download_failed" | "file_too_large") {
    super(code);
  }
}

function isHttpSource(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function sanitizeImageSourceForLog(source: string) {
  if (source.startsWith("data:")) return "data-url";
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

async function readBoundedImageBlob(source: string) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok || !response.body) throw new ImageDownloadError("download_failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new ImageDownloadError("file_too_large");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // Web 下载也必须在读取过程中截断，不能等 response.blob() 完整占用 renderer 内存。
        controller.abort();
        throw new ImageDownloadError("file_too_large");
      }
      chunks.push(value);
    }
    if (receivedBytes === 0) throw new ImageDownloadError("download_failed");
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes.buffer], {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

function startBrowserNativeDownload(source: string) {
  const link = document.createElement("a");
  link.href = source;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function ImagePreviewDialog({
  dialogTestId,
  imageTestId,
  initialIndex,
  items,
  onActiveIndexChange,
  onOpenChange,
  open,
}: {
  dialogTestId?: string;
  imageTestId?: string;
  initialIndex: number;
  items: readonly ImagePreviewDialogItem[];
  onActiveIndexChange?: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewOffset, setPreviewOffset] = useState(defaultPreviewOffset);
  const [isDownloading, setIsDownloading] = useState(false);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewPointersRef = useRef(new Map<number, PreviewOffset>());
  const dragStartRef = useRef<{
    offset: PreviewOffset;
    pointer: PreviewOffset;
  } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);
  const activeItem = items[activeIndex];
  const activeItemIsVideo = activeItem?.mediaType?.startsWith("video/") === true;
  const hasMultiple = items.length > 1;

  const resetPreviewTransform = () => {
    const viewport = previewViewportRef.current;
    if (viewport) {
      for (const pointerId of previewPointersRef.current.keys()) {
        if (viewport.hasPointerCapture(pointerId)) {
          viewport.releasePointerCapture(pointerId);
        }
      }
    }
    previewPointersRef.current.clear();
    dragStartRef.current = null;
    pinchStartRef.current = null;
    setPreviewScale(1);
    setPreviewOffset(defaultPreviewOffset);
  };

  const navigate = (direction: -1 | 1) => {
    if (items.length <= 1) return;
    const next = (activeIndex + direction + items.length) % items.length;
    setActiveIndex(next);
    onActiveIndexChange?.(next);
    resetPreviewTransform();
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0)));
    resetPreviewTransform();
  }, [initialIndex, items.length, open]);

  useEffect(() => {
    setVideoState("loading");
  }, [activeIndex, activeItem?.src, open]);

  useEffect(() => {
    return () => {
      // 媒体 gallery 切离 video 时旧播放器可能继续解码或发声；显式暂停，
      // 让图片/视频混合导航只保留当前项的播放生命周期。
      previewVideoRef.current?.pause();
    };
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") navigate(-1);
      else if (event.key === "ArrowRight") navigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, items.length, open]);

  const clampPreviewOffset = (offset: PreviewOffset, scale: number) => {
    const image = previewImageRef.current;
    const viewport = previewViewportRef.current;
    if (!image || !viewport) return defaultPreviewOffset;
    return clampImagePreviewOffset(
      offset,
      scale,
      { height: image.offsetHeight, width: image.offsetWidth },
      { height: viewport.clientHeight, width: viewport.clientWidth },
    );
  };

  useEffect(() => {
    if (!open) return;
    const clampCurrentOffset = () => {
      setPreviewOffset((current) => clampPreviewOffset(current, previewScale));
    };
    window.addEventListener("resize", clampCurrentOffset);
    return () => window.removeEventListener("resize", clampCurrentOffset);
  }, [open, previewScale]);

  const changePreviewScale = (delta: number) => {
    const nextScale = Math.min(3, Math.max(0.5, previewScale + delta));
    setPreviewScale(nextScale);
    setPreviewOffset((current) => clampPreviewOffset(current, nextScale));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = { x: event.clientX, y: event.clientY };
    previewPointersRef.current.set(event.pointerId, pointer);
    if (previewPointersRef.current.size === 1) {
      dragStartRef.current = { offset: previewOffset, pointer };
      pinchStartRef.current = null;
      return;
    }
    const [first, second] = Array.from(previewPointersRef.current.values());
    if (!first || !second) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (distance === 0) return;
    pinchStartRef.current = { distance, scale: previewScale };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!previewPointersRef.current.has(event.pointerId)) return;
    previewPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const pointers = Array.from(previewPointersRef.current.values());
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      if (!first || !second || !pinchStartRef.current) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const nextScale = Math.min(
        3,
        Math.max(0.5, pinchStartRef.current.scale * (distance / pinchStartRef.current.distance)),
      );
      setPreviewScale(nextScale);
      setPreviewOffset((current) => clampPreviewOffset(current, nextScale));
      return;
    }
    const dragStart = dragStartRef.current;
    const pointer = pointers[0];
    if (!dragStart || !pointer) return;
    setPreviewOffset(
      clampPreviewOffset(
        {
          x: dragStart.offset.x + pointer.x - dragStart.pointer.x,
          y: dragStart.offset.y + pointer.y - dragStart.pointer.y,
        },
        previewScale,
      ),
    );
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 显式释放图片拖拽捕获；残留 capture 会让后续 hover/click 继续命中视口而非浮层按钮。
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    previewPointersRef.current.delete(event.pointerId);
    pinchStartRef.current = null;
    const remainingPointer = Array.from(previewPointersRef.current.values())[0];
    dragStartRef.current = remainingPointer
      ? { offset: previewOffset, pointer: remainingPointer }
      : null;
  };

  const downloadActiveImage = async () => {
    if (!activeItem?.src || activeItemIsVideo || isDownloading) return;
    setIsDownloading(true);
    try {
      if (platform?.saveFile && isHttpSource(activeItem.src)) {
        const result = await platform.saveFile({
          sourceUrl: activeItem.src,
          suggestedName: `${safeDownloadBaseName(activeItem)}.png`,
        });
        if (result.canceled) return;
        if (!result.success || !result.path) throw new Error(result.error || "save_failed");
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }, { path: result.path }));
        return;
      }

      let blob: Blob;
      try {
        blob = await readBoundedImageBlob(activeItem.src);
      } catch (error) {
        if (
          !platform?.saveFile &&
          isHttpSource(activeItem.src) &&
          !(error instanceof ImageDownloadError && error.code === "file_too_large")
        ) {
          // <img> 可显示无 CORS 资源，但 fetch 无法读取；交给浏览器原生导航避免假失败。
          startBrowserNativeDownload(activeItem.src);
          toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
          return;
        }
        throw error;
      }
      const extension = imageExtensionByMediaType[blob.type.toLowerCase()] ?? "png";
      const filename = `${safeDownloadBaseName(activeItem)}.${extension}`;
      if (platform?.saveFile) {
        const result = await platform.saveFile({
          data: await blob.arrayBuffer(),
          suggestedName: filename,
        });
        if (result.canceled) return;
        if (!result.success || !result.path) throw new Error(result.error || "save_failed");
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }, { path: result.path }));
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
    } catch (error) {
      logger.warn("[ImagePreviewDialog] 图片下载失败", {
        // 签名 URL 的 userinfo/query/fragment 不参与排障，禁止写入持久化日志。
        src: sanitizeImageSourceForLog(activeItem.src),
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        // Radix modal 会禁用 body 指针事件；预览层需显式恢复命中并退出 Electron 拖拽区。
        className="pointer-events-auto h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none place-items-center gap-0 overflow-hidden border-0 bg-transparent p-10 shadow-none [app-region:no-drag] sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] platform-linux-desktop:h-[calc(100dvh-4rem)]"
        data-testid={dialogTestId}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {activeItem?.alt || intl.formatMessage({ id: "chat.attachments.preview.title" })}
        </DialogTitle>
        <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 [app-region:no-drag] platform-mac-desktop:top-12 platform-linux-desktop:right-6 platform-linux-desktop:top-4 platform-windows-desktop:right-6 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]">
          {!activeItemIsVideo ? (
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.download" })}
              className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
              disabled={!activeItem?.src || isDownloading}
              onClick={downloadActiveImage}
              size="icon-md"
              variant="ghost"
            >
              <DownloadIcon />
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
              size="icon-md"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        {hasMultiple ? (
          <>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.previous" })}
              className="pointer-events-auto absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(-1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.next" })}
              className="pointer-events-auto absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowRightIcon />
            </Button>
          </>
        ) : null}
        {activeItem ? (
          activeItemIsVideo ? (
            <div className="flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
              {activeItem.src ? (
                videoState === "unsupported" ? (
                  <p
                    className="max-w-xl px-6 text-center text-ui-base text-foreground-subtle"
                    role="alert"
                  >
                    {intl.formatMessage({
                      id: "chat.attachments.preview.videoUnsupported",
                    })}
                  </p>
                ) : (
                  <>
                    {videoState === "loading" ? (
                      <p className="text-ui-base text-foreground-subtle" role="status">
                        {intl.formatMessage({
                          id: "chat.attachments.preview.videoLoading",
                        })}
                      </p>
                    ) : null}
                    {/* 可发送的 video MIME 不保证当前 Chromium 能解码其容器或 codec；
                解码失败只收口当前 gallery item，不能关闭预览或影响相邻媒体。 */}
                    <video
                      controls
                      playsInline
                      className={cn(
                        "max-h-full max-w-full rounded-xl border border-border bg-background shadow-2xl",
                        videoState === "loading" && "invisible absolute",
                      )}
                      onError={() => setVideoState("unsupported")}
                      onLoadedMetadata={() => setVideoState("ready")}
                      ref={previewVideoRef}
                      src={activeItem.src}
                    />
                  </>
                )
              ) : activeItem.error ? (
                <p className="px-6 text-center text-ui-base text-destructive" role="alert">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoUnavailable",
                  })}
                </p>
              ) : activeItem.loading ? (
                <p className="text-ui-base text-foreground-subtle" role="status">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoLoading",
                  })}
                </p>
              ) : null}
            </div>
          ) : activeItem.src ? (
            <div
              className="flex size-full min-h-0 min-w-0 touch-none cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing"
              onPointerCancel={handlePointerEnd}
              onPointerDown={handlePointerDown}
              onLostPointerCapture={handlePointerEnd}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              ref={previewViewportRef}
            >
              <img
                alt={activeItem.alt}
                className="max-h-full max-w-full select-none rounded-xl border border-border bg-background object-contain shadow-2xl"
                data-testid={imageTestId}
                draggable={false}
                onLoad={resetPreviewTransform}
                ref={previewImageRef}
                src={activeItem.src}
                style={{
                  transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewScale})`,
                }}
              />
            </div>
          ) : null
        ) : null}
        {!activeItemIsVideo ? (
          <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-popover-border bg-popover/95 p-1 shadow-md [app-region:no-drag]">
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
              className="rounded-full"
              disabled={previewScale <= 0.5}
              onClick={() => changePreviewScale(-0.5)}
              size="icon-sm"
              variant="ghost"
            >
              <MinusIcon />
            </Button>
            <span className="min-w-12 text-center text-ui-base text-foreground">
              {Math.round(previewScale * 100)}%
            </span>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
              className="rounded-full"
              disabled={previewScale >= 3}
              onClick={() => changePreviewScale(0.5)}
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
