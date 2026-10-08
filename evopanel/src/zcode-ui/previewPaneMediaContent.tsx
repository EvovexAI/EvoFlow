import type { MediaCodeViewerSource } from "@/lib/codeViewer.js";
import type { SyntheticEvent } from "react";

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

export function PreviewPaneMediaContent({
  source,
  loading,
  url,
  error,
  labels,
  onMediaError,
  onMediaLoadedMetadata,
}: PreviewPaneMediaContentProps) {
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

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
      {source.kind === "video" ? (
        <video
          controls
          playsInline
          className="max-h-full max-w-full rounded-lg"
          preload="metadata"
          src={url}
          onError={onMediaError}
          onLoadedMetadata={onMediaLoadedMetadata}
        >
          {labels.unsupported}
        </video>
      ) : (
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
      )}
    </div>
  );
}
