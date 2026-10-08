/**
 * 设备标识符 —— renderer 进程内单例缓存
 *
 * 生成策略：
 * - 桌面端：使用 main 进程提供的 deviceMid（基于 userData 路径的 SHA-256，稳定且唯一）
 * - 手机端（Web 远程控制）：使用物理属性指纹（browserPlatform + screen.width/height + colorDepth），
 *   抗浏览器/网络/语言/时区变化，换手机才会变
 */
import { createUuid } from "@zcode/shared";

let cachedStreamClientId: string | null = null;

/**
 * 设置稳定的设备 ID（由 platform.getDeviceId() 提供）。
 * 必须在首次调用 getStreamClientId() 之前调用。
 */
export function setStreamClientId(deviceId: string): void {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    // deviceId 注入异常时如果写入空字符串，所有实例会共享 "renderer:"，
    // owner/observer 过滤会误判成同一客户端。这里回退到进程内稳定随机值，避免跨实例碰撞。
    cachedStreamClientId = cachedStreamClientId ?? `renderer:fallback-${createUuid()}`;
    return;
  }
  cachedStreamClientId = `renderer:${normalizedDeviceId}`;
}

/**
 * 生成手机端物理属性指纹。
 * 用于手机端在 platform.getDeviceId() 返回之前自行生成稳定的设备 ID。
 */
export function generateMobileDeviceFingerprint(): string {
  const nav = globalThis.navigator as Navigator & { platform?: string };
  const platform = nav?.platform ?? "";
  const screenWidth = globalThis.screen?.width;
  const screenHeight = globalThis.screen?.height;
  const colorDepth = globalThis.screen?.colorDepth;
  const parts = [
    platform,
    screenWidth !== undefined ? String(screenWidth) : "",
    screenHeight !== undefined ? String(screenHeight) : "",
    colorDepth !== undefined ? String(colorDepth) : "",
  ];
  return parts.filter(Boolean).join("|");
}
