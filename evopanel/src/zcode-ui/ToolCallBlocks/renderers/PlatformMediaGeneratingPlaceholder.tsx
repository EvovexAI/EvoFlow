/**
 * 同步生图（platform media.generate_image）进行中的彩色占位：
 * 工具卡下方先出现「正在出图」的色块 + 百分比，完成后由真实预览替换。
 */
import { useEffect, useMemo, useState } from "react";

function parseAspectRatio(raw: string | undefined): { w: number; h: number } {
  const m = String(raw || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return { w: 16, h: 9 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 16, h: 9 };
  return { w, h };
}

/** 按已耗时缓升到 ~92%，等工具真正完成再由上层换成成片。 */
function estimateProgressPercent(elapsedSec: number): number {
  const eased = 8 + 84 * (1 - Math.exp(-elapsedSec / 18));
  return Math.max(3, Math.min(92, Math.floor(eased)));
}

export function PlatformMediaGeneratingPlaceholder({
  aspectRatio,
  label = "图片生成中",
}: {
  aspectRatio?: string;
  label?: string;
}) {
  const { w, h } = useMemo(() => parseAspectRatio(aspectRatio), [aspectRatio]);
  const [pct, setPct] = useState(3);

  useEffect(() => {
    const started = Date.now();
    setPct(3);
    const tick = () => {
      setPct(estimateProgressPercent((Date.now() - started) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className="mt-2 w-full max-w-[10rem]"
      data-platform-media-generating=""
      data-testid="platform-media-generating"
      role="status"
      aria-live="polite"
      aria-label={`${label} ${pct}%`}
    >
      {/* 进度只画在色块上（中心 % + 底条）；上方不再重复长文案/百分比。 */}
      <div
        className="relative w-full overflow-hidden rounded-xl border border-border shadow-sm"
        style={{ aspectRatio: `${w} / ${h}` }}
      >
        <div className="platform-media-gen-mesh absolute inset-0" aria-hidden="true" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/35 px-3 py-1 text-ui-sm font-medium text-white backdrop-blur-sm">
            {pct}%
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/20">
          <div
            className="h-full bg-white/90 transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
