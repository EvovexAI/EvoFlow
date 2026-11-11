// NOT MOUNTED. 产品里的截图画廊在 react/components/CuaToolPreview.tsx。
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveBrowserScreenshotSrcAsync } from "@/lib/chat-normalize.js";
import type { NodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";

export function NodeReplImageGrid({
  images,
  resultImageLabel,
}: {
  images: ReadonlyArray<NodeReplDisplayModel["images"][number]>;
  resultImageLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resolvedSrcs, setResolvedSrcs] = useState<string[]>([]);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let active = true;
    void Promise.all(
      images.map(async (image) => {
        if (image.base64) return `data:${image.mimeType};base64,${image.base64}`;
        if (image.url) {
          try {
            return (await resolveBrowserScreenshotSrcAsync(image.url)) || "";
          } catch {
            return "";
          }
        }
        return "";
      }),
    ).then((srcs) => {
      if (active) setResolvedSrcs(srcs);
    });
    return () => {
      active = false;
    };
  }, [images]);

  const previewItems = useMemo(
    () =>
      images
        .map((image, index) => ({
          alt: `${resultImageLabel} ${index + 1}`,
          filename: `result-image-${index + 1}`,
          src: resolvedSrcs[index] || "",
          key: image.base64
            ? `${image.mimeType}:${image.base64.length}:${index}`
            : `${image.mimeType}:url:${image.url}:${index}`,
        }))
        .filter((item) => item.src),
    [images, resolvedSrcs, resultImageLabel],
  );
  const openImageLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });

  const handleOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open) {
      window.setTimeout(() => triggerRefs.current[previewIndex]?.focus(), 0);
    }
  };

  if (previewItems.length === 0) return null;

  return (
    <>
      <ImageThumbnailGallery data-node-repl-image-gallery="" grouped>
        {previewItems.map((item, index) => (
          <button
            ref={(node) => {
              triggerRefs.current[index] = node;
            }}
            type="button"
            aria-label={`${openImageLabel} ${index + 1}`}
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
        dialogTestId="node-repl-image-lightbox"
        imageTestId="node-repl-image-lightbox-image"
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={handleOpenChange}
        open={previewOpen}
      />
    </>
  );
}
