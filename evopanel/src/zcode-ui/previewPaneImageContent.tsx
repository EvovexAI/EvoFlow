import type { CSSProperties, SyntheticEvent } from "react";
import { useCallback, useMemo, useState } from "react";

interface ImagePreviewContentProps {
  title: string;
  imageSource: string;
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

function getImagePreviewPixelRatio(sourceName: string): number {
  const fileName = sourceName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(fileName);
  const ratio = match ? Number(match[1]) : 1;

  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function ImagePreviewContent({
  title,
  fitToContainer = false,
  imageSource,
  sourcePath,
}: ImagePreviewContentProps) {
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null);
  const pixelRatio = useMemo(
    () => getImagePreviewPixelRatio(sourcePath ?? title),
    [sourcePath, title],
  );
  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (
      fitToContainer ||
      pixelRatio <= 1 ||
      naturalSize?.source !== imageSource ||
      naturalSize.width <= 0 ||
      naturalSize.height <= 0
    ) {
      return undefined;
    }

    return {
      // Retina 文件名里的 @2x/@3x 表示物理像素倍率，预览时折算为 CSS 像素，避免素材被放大显示。
      height: naturalSize.height / pixelRatio,
      width: naturalSize.width / pixelRatio,
    };
  }, [fitToContainer, imageSource, naturalSize, pixelRatio]);
  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      if (fitToContainer) {
        return;
      }

      const image = event.currentTarget;

      setNaturalSize({
        source: imageSource,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    },
    [fitToContainer, imageSource],
  );
  const imageClassName = fitToContainer
    ? "h-full max-h-full w-full max-w-full object-contain"
    : "h-auto max-h-full w-auto max-w-full object-contain";

  return (
    <div
      className={`flex h-full min-h-0 items-center justify-center overflow-hidden p-10 ${IMAGE_PREVIEW_CHECKERBOARD_CLASS}`}
    >
      <img
        alt={title}
        className={imageClassName}
        onLoad={handleLoad}
        src={imageSource}
        style={imageStyle}
      />
    </div>
  );
}

export function SvgPreviewContent({ title, svgContent }: { title: string; svgContent: string }) {
  return (
    <ImagePreviewContent
      fitToContainer
      title={title}
      imageSource={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`}
    />
  );
}
