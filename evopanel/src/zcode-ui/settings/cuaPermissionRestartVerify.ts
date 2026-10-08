// 重启 Helper 后的 accessibility 验证:吸收 tccd 传播 lag + 决定是否升级到"重启 ZCode"兜底。
//
// 背景:macOS Accessibility 授权后,运行中 Helper 的 AXIsProcessTrusted 被进程级缓存,必须重启 Helper
// (出新进程)才能吃到。restartHelper 返回时新 Helper 的 broker socket 已健康,但 AX 状态可能仍读 stale
// (tccd 传播有几秒 lag)。若只 refresh 一次,很可能又读到 stale,让用户以为重启无效。
//
// 本 helper 在重启后轮询 accessibility:脱离 stale(granted/denied/unknown)即视为"已解决"返回 false;
// 直到超时仍 stale(或一直 unavailable/抛错)才返回 true,触发 UI 升级到"重启 ZCode"兜底。
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";

interface WaitForAccessibilityNotStaleOptions {
  /** 总超时(默认 6s):覆盖 tccd 传播 lag,首轮通常立即 granted。 */
  timeoutMs?: number;
  /** 轮询间隔(默认 500ms)。 */
  intervalMs?: number;
}

type GetCuaPermissionStatusFn = () => Promise<CuaPermissionStatusResult>;

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 重启 Helper 后轮询 accessibility,判断是否脱离 stale。
 *
 * @returns `false` —— accessibility 在超时内脱离 stale(granted/denied/unknown),无需升级。
 *          `true`  —— 直到超时仍 stale(或持续 unavailable/抛错),升级到"重启 ZCode"兜底。
 *
 * 语义说明:
 *  - `granted` → 重启吃到授权了,解决。
 *  - `denied`/`unknown` → 是真实权限缺口(用户没授权),不是"重启失败",不升级(交给授权引导)。
 *  - `stale` 持续 → tccd 缓存没刷新 / 重启机制卡住 → 升级。
 *  - unavailable / 抛错 → 重启中途瞬时态,继续轮询;超时仍未恢复 → 升级。
 */
export async function waitForAccessibilityNotStale(
  getStatus: GetCuaPermissionStatusFn,
  options: WaitForAccessibilityNotStaleOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await getStatus();
      if (isCuaPermissionStatusAvailable(result) && result.accessibility !== "stale") {
        return false;
      }
    } catch {
      // 重启中途 getStatus 可能瞬时失败(socket 切换 / Helper 刚起)。视为未解决,继续轮询。
    }
    if (Date.now() >= deadline) return true;
    await sleep(intervalMs);
  }
}
