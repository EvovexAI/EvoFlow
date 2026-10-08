import { readSafeLocalStorage } from "@/lib/browserEnvironment.js";

const DEFAULT_UI_FONT_SIZE_PX = 14;
export const MIN_UI_FONT_SIZE_PX = 12;
export const MAX_UI_FONT_SIZE_PX = 20;
export const UI_FONT_SIZE_STORAGE_KEY = "zcode-ui-font-size-px";

export function normalizeUiFontSizePx(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_UI_FONT_SIZE_PX, Math.max(MIN_UI_FONT_SIZE_PX, Math.round(value)))
    : DEFAULT_UI_FONT_SIZE_PX;
}

export function loadUiFontSizePx(): number {
  const rawValue = readSafeLocalStorage(UI_FONT_SIZE_STORAGE_KEY);
  const storedValue = rawValue === null ? Number.NaN : Number(rawValue);
  return normalizeUiFontSizePx(Number.isFinite(storedValue) ? storedValue : undefined);
}

export function applyUiFontSizePx(fontSizePx: number): void {
  const rootStyle = typeof document === "undefined" ? undefined : document.documentElement?.style;
  if (!rootStyle?.setProperty) {
    return;
  }
  // 只更新 UI 字号 Token 的基准变量，避免根 font-size 连带缩放图标、间距和圆角。
  rootStyle.setProperty("--ui-font-size", `${normalizeUiFontSizePx(fontSizePx)}px`);
}

export function subscribeToUiFontSizeStorageChanges(): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== UI_FONT_SIZE_STORAGE_KEY) {
      return;
    }

    const storedValue = event.newValue === null ? Number.NaN : Number(event.newValue);
    applyUiFontSizePx(Number.isFinite(storedValue) ? storedValue : DEFAULT_UI_FONT_SIZE_PX);
  };

  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
