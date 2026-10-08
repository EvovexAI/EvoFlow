import type { ArmsCustomEventPayload } from "@zcode/shared";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";

interface ArmsCustomEventE2EEntry extends ArmsCustomEventPayload {
  recordedAt: number;
}

const MAX_ARMS_CUSTOM_EVENT_ENTRIES = 200;

type ArmsCustomEventDebugWindow = Window & {
  __zcodeArmsCustomEventsE2E?: ArmsCustomEventE2EEntry[];
};

/**
 * 仅 E2E 构建记录 renderer 实际提交给 desktop bridge 的 ARMS payload。
 * 缓冲保持有界，且生产构建不创建 window 字段，避免形成第二套持久化或回放通道。
 */
export function recordArmsCustomEventForE2E(
  payload: ArmsCustomEventPayload,
  options: {
    enabled?: boolean;
    host?: ArmsCustomEventDebugWindow;
    now?: () => number;
  } = {},
): void {
  const enabled = options.enabled ?? shouldExposeE2EStoreBridge();
  if (!enabled || (typeof window === "undefined" && !options.host)) return;

  const host = options.host ?? (window as ArmsCustomEventDebugWindow);
  const buffer = (host.__zcodeArmsCustomEventsE2E ??= []);
  buffer.push({
    ...payload,
    ...(payload.properties ? { properties: { ...payload.properties } } : {}),
    recordedAt: (options.now ?? Date.now)(),
  });
  if (buffer.length > MAX_ARMS_CUSTOM_EVENT_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ARMS_CUSTOM_EVENT_ENTRIES);
  }
}
