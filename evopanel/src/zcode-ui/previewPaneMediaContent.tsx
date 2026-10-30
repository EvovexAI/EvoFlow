import type { MediaCodeViewerSource } from "@/lib/codeViewer.js";
import type { MouseEvent as ReactMouseEvent, SyntheticEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { Maximize2Icon } from "lucide-react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface PreviewPaneMediaContentProps {
  source: MediaCodeViewerSource;
  loading: boolean;
  url: string | null;
  error: string | null;
  labels: {
    loading: string;
    unavailable: string;
    unsupported: string;
  };
  onMediaError?: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata?: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

interface MediaNaturalSize {
  source: string;
  width: number;
  height: number;
}

/** Native video controls sit near the bottom; ignore clicks there so play/scrub still work. */
const VIDEO_CONTROLS_HIT_ZONE_PX = 48;

export function PreviewPaneMediaContent({
  source,
  loading,
  url,
  error,
  labels,
  onMediaError,
  onMediaLoadedMetadata,
}: PreviewPaneMediaContentProps) {
  const { intl } = useZCodeIntl();
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [naturalSize, setNaturalSize] = useState<MediaNaturalSize | null>(null);

  const handleLoadedMetadata = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>) => {
      const el = event.currentTarget;
      if (el instanceof HTMLVideoElement && el.videoWidth > 0 && el.videoHeight > 0 && url) {
        setNaturalSize({
          source: url,
          width: el.videoWidth,
          height: el.videoHeight,
        });
      }
      onMediaLoadedMetadata?.(event);
    },
    [onMediaLoadedMetadata, url],
  );

  const openPreview = useCallback(() => {
    if (url) setPreviewOpen(true);
  }, [url]);

  const handleVideoClick = useCallback(
    (event: ReactMouseEvent<HTMLVideoElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.bottom - event.clientY < VIDEO_CONTROLS_HIT_ZONE_PX) return;
      openPreview();
    },
    [openPreview],
  );

  if (loading || (!error && !url)) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>;
  }

  if (error || !url) {
    return (
      <div className="p-3 text-ui-base text-destructive" role="alert">
        {error ?? labels.unavailable}
      </div>
    );
  }

  if (source.kind !== "video") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
        <audio
          controls
          className="w-full max-w-2xl"
          preload="metadata"
          src={url}
          onError={onMediaError}
          onLoadedMetadata={onMediaLoadedMetadata}
        >
          {labels.unsupported}
        </audio>
      </div>
    );
  }

  const measured =
    naturalSize?.source === url && naturalSize.width > 0 && naturalSize.height > 0
      ? naturalSize
      : null;
  const mediaType = source.mediaType?.startsWith("video/")
    ? source.mediaType
    : "video/mp4";
  const openLabel = intl.formatMessage({ id: "chat.attachments.preview.openVideo" });

  return (
    <>
      <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-background p-6">
        <video
          controls
          playsInline
          className="h-full max-h-full w-full max-w-full cursor-zoom-in rounded-lg object-contain"
          data-natural-height={measured?.height}
          data-natural-width={measured?.width}
          preload="metadata"
          src={url}
          onClick={handleVideoClick}
          onDoubleClick={openPreview}
          onError={onMediaError}
          onLoadedMetadata={handleLoadedMetadata}
        >
          {labels.unsupported}
        </video>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={openLabel}
          className="absolute top-8 right-8 size-8 shadow-sm"
          title={openLabel}
          onClick={(event) => {
            event.stopPropagation();
            openPreview();
          }}
          ref={expandButtonRef}
        >
          <Maximize2Icon className="size-3.5" />
        </Button>
      </div>
      <ImagePreviewDialog
        initialIndex={0}
        items={[
          {
            alt: source.title,
            filename: source.path || source.title,
            mediaType,
            src: url,
          },
        ]}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) {
            window.setTimeout(() => expandButtonRef.current?.focus(), 0);
          }
        }}
        open={previewOpen}
      />
    </>
  );
}
