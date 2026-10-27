/**
 * platform media.* 结果预览区：生图 / 生视频 inline 展示（对齐飞书/微信截图画廊体验）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { resolveChatImageSrc } from "../../../lib/chat-image-src.js";
import type { PlatformUiToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

type MediaItem = NonNullable<PlatformUiToolResultDisplay["media"]>[number];

function isVideoItem(item: MediaItem): boolean {
  const kind = String(item.kind || "").toLowerCase();
  if (kind === "video") return true;
  const mime = String(item.mimeType || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const uri = String(item.artifactUri || item.absolutePath || item.url || "");
  return /\.(mp4|webm|mov|mkv|m4v)(\?|$)/i.test(uri);
}

function resolveSrc(item: MediaItem): string {
  const raw = String(item.artifactUri || item.absolutePath || item.url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("/api/")) {
    return raw;
  }
  return resolveChatImageSrc(raw) || raw;
}

export function PlatformMediaPreview({
  media,
  label = "生成媒体",
}: {
  media: ReadonlyArray<MediaItem>;
  label?: string;
}) {
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resolved, setResolved] = useState<Array<{ src: string; video: boolean; key: string }>>([]);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let active = true;
    const next = media
      .map((item, index) => {
        const src = resolveSrc(item);
        if (!src) return null;
        return {
          src,
          video: isVideoItem(item),
          key: `${item.kind || ""}:${src}:${index}`,
        };
      })
      .filter((x): x is { src: string; video: boolean; key: string } => !!x);
    if (active) setResolved(next);
    return () => {
      active = false;
    };
  }, [media]);

  const imageItems = useMemo(
    () =>
      resolved
        .map((item, index) => ({
          ...item,
          index,
          alt: `${label} ${index + 1}`,
          filename: `platform-media-${index + 1}`,
        }))
        .filter((item) => !item.video && item.src),
    [resolved, label],
  );

  const videoItems = useMemo(() => resolved.filter((item) => item.video && item.src), [resolved]);

  if (!resolved.length) return null;

  return (
    <div
      className="mt-2 space-y-2"
      data-platform-media-preview=""
      data-testid="platform-media-preview"
    >
      {imageItems.length > 0 ? (
        <>
          <ImageThumbnailGallery
            data-platform-media-image-gallery=""
            grouped={imageItems.length >= 2}
          >
            {imageItems.map((item, index) => (
              <button
                ref={(node) => {
                  triggerRefs.current[index] = node;
                }}
                type="button"
                aria-label={`预览 ${item.alt}`}
                className={imageThumbnailTriggerClassName}
                data-image-thumbnail-trigger=""
                key={item.key}
                onClick={() => {
                  setPreviewIndex(index);
                  setPreviewOpen(true);
                }}
              >
                <img
                  alt={item.alt}
                  className={imageThumbnailClassName}
                  draggable={false}
                  loading="lazy"
                  src={item.src}
                />
              </button>
            ))}
          </ImageThumbnailGallery>
          <ImagePreviewDialog
            dialogTestId="platform-media-image-lightbox"
            imageTestId="platform-media-image-lightbox-image"
            initialIndex={previewIndex}
            items={imageItems}
            onOpenChange={(open) => {
              setPreviewOpen(open);
              if (!open) {
                window.setTimeout(() => triggerRefs.current[previewIndex]?.focus(), 0);
              }
            }}
            open={previewOpen}
          />
        </>
      ) : null}

      {videoItems.map((item) => (
        <div
          key={item.key}
          className="overflow-hidden rounded-lg border border-border bg-background-subtle"
          data-platform-media-video=""
        >
          <video
            className="max-h-72 w-full bg-black object-contain"
            controls
            preload="metadata"
            src={item.src}
          >
            <track kind="captions" />
          </video>
        </div>
      ))}
    </div>
  );
}
