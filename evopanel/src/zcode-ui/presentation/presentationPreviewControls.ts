export const PPTX_MIN_ZOOM_PERCENT = 25;
export const PPTX_MAX_ZOOM_PERCENT = 300;
export const PPTX_ZOOM_STEP_PERCENT = 25;

export function clampPresentationPageNumber(target: number, pageCount: number): number {
  const safePageCount = Math.max(1, Math.floor(pageCount));
  if (!Number.isFinite(target)) {
    return 1;
  }
  return Math.min(Math.max(1, Math.round(target)), safePageCount);
}

export function clampPresentationZoomPercent(target: number): number {
  if (!Number.isFinite(target)) {
    return 100;
  }
  return Math.min(Math.max(PPTX_MIN_ZOOM_PERCENT, Math.round(target)), PPTX_MAX_ZOOM_PERCENT);
}
