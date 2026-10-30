import type { SyntheticEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ImagePreviewContentProps {
  title: string;
  imageSource: string;
  /** @deprecated Always fits the pane; kept for call-site compatibility. */
  fitToContainer?: boolean;
  sourcePath?: string;
}

interface ImageNaturalSize {
  source: string;
  width: number;
  height: number;
}

const IMAGE_PREVIEW_CHECKERBOARD_CLASS =
  "[background-color:var(--color-background)] [background-image:linear-gradient(45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(-45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-surface)_75%),linear-gradient(-45deg,transparent_75%,var(--color-surface)_75%)] [background-position:0_0,0_4px,4px_-4px,-4px_0] [background-size:8px_8px]";

export function ImagePreviewContent({
  title,
  imageSource,
  sourcePath,
}: ImagePreviewContentProps) {
  const { intl } = useZCodeIntl();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const image = event.currentTarget;
      setNaturalSize({
        source: imageSource,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    },
    [imageSource],
  );

  const measured =
    naturalSize?.source === imageSource &&
    naturalSize.width > 0 &&
    naturalSize.height > 0
      ? naturalSize
      : null;

  return (
    <>
      <div
        className={`flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden p-10 ${IMAGE_PREVIEW_CHECKERBOARD_CLASS}`}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-label={intl.formatMessage({ id: "chat.attachments.preview.open" })}
          className="flex h-full min-h-0 w-full min-w-0 cursor-zoom-in items-center justify-center border-0 bg-transparent p-0"
          onClick={() => setPreviewOpen(true)}
          title={intl.formatMessage({ id: "chat.attachments.preview.open" })}
        >
          <img
            alt={title}
            className="h-full max-h-full w-full max-w-full object-contain"
            data-natural-height={measured?.height}
            data-natural-width={measured?.width}
            draggable={false}
            onLoad={handleLoad}
            src={imageSource}
          />
        </button>
      </div>
      <ImagePreviewDialog
        initialIndex={0}
        items={[
          {
            alt: title,
            filename: sourcePath ?? title,
            src: imageSource,
          },
        ]}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) {
            window.setTimeout(() => triggerRef.current?.focus(), 0);
          }
        }}
        open={previewOpen}
      />
    </>
  );
}

export function SvgPreviewContent({ title, svgContent }: { title: string; svgContent: string }) {
  return (
    <ImagePreviewContent
      title={title}
      imageSource={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`}
    />
  );
}
