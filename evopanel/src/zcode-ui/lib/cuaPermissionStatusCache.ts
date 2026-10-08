/**
 * CUA 权限状态的本地缓存。
 *
 * 为什么需要：`useCuaPermissionStatus` 的 status 冷启动时是 null，而设置页两行权限的
 * detail 按钮只在 `=== "granted"` 时隐藏，于是 null 期间两行都会渲染出「打开辅助功能 /
 * 打开屏幕录制」按钮，等首次查询（真实结果是已授权）返回后按钮又整体消失，行高塌陷 ——
 * 用户每次进设置页都要看一次抖动。输入框常驻入口也一样，冷启动先走 starting 再跳 ready。
 *
 * 缓存把上一次的真实结果留到下次启动，作为首屏的乐观初值，让常见路径（授权状态没变）
 * 首屏即终态、不再跳变。
 *
 * 边界（重要）：这里缓存的值**只用于渲染**，绝不参与任何授权决策。
 * - 展示跟 `settled`（有可展示内容即成立），所以缓存命中时设置页的「打开系统设置」按钮
 *   **立即可点**，不会等到真实结果返回——这是有意的取舍，否则按钮文案会在「验证中…」与
 *   终态之间抖动。安全性不靠这个按钮的 disabled 兜底，而是靠点击边沿：
 *   `openPermissionSettings` 会重新 `getStatus` 并用 `requiredCuaPermissionsForFreshStatus`
 *   精确校验，陈旧值点不出错误的系统面板，只会 toast 提示并触发刷新。
 * - `fresh` 仍然只在真实结果到达后才置 true，供决策类判断使用。
 * - 真正的功能门禁在 Helper/producer；失败作为普通 MCP tool error 到达模型，
 *   与本缓存无关，也不会由 Renderer 自动触发权限副作用。
 * 因此缓存最坏的后果是首屏多显示一瞬正确性未知的状态，随即被下一次事件驱动的查询覆盖。
 */
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionState,
  type CuaPermissionStatus,
  type CuaPermissionStatusResult,
} from "@zcode/services";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** TCC 授权是 App（Helper bundle）级而非 workspace 级，因此全局单键，不按 workspace 分。 */
const CUA_PERMISSION_STATUS_CACHE_KEY = "zcode-cua-permission-status";

/**
 * 缓存有效期。授权状态可能在 ZCode 未运行时被用户在系统设置里改掉，缓存越旧越不可信；
 * 超期后宁可回到冷启动态（null），也不要用一个可能已被撤销的 granted 去渲染首屏。
 */
const CUA_PERMISSION_STATUS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PERMISSION_STATES: readonly CuaPermissionState[] = ["granted", "stale", "denied", "unknown"];

interface CachedEnvelope {
  savedAt: number;
  status: CuaPermissionStatus;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPermissionState(value: unknown): value is CuaPermissionState {
  return PERMISSION_STATES.includes(value as CuaPermissionState);
}

/**
 * 全字段校验。缓存是跨版本存活的，字段一旦漂移（改名/改类型）就可能把 undefined 喂进
 * 渲染分支，产生比抖动更难查的问题；这里宁可判定失效回到 null。
 */
function parseCachedStatus(value: unknown): CuaPermissionStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.grantOwner !== "string" ||
    !isPermissionState(candidate.accessibility) ||
    !isPermissionState(candidate.screenRecording) ||
    typeof candidate.accessibilityProbeOk !== "boolean" ||
    typeof candidate.screenCaptureProbeOk !== "boolean"
  ) {
    return null;
  }
  if (
    candidate.grantOwnerDisplayName !== undefined &&
    typeof candidate.grantOwnerDisplayName !== "string"
  ) {
    return null;
  }

  const parsed: CuaPermissionStatus = {
    grantOwner: candidate.grantOwner,
    accessibility: candidate.accessibility,
    accessibilityProbeOk: candidate.accessibilityProbeOk,
    screenRecording: candidate.screenRecording,
    screenCaptureProbeOk: candidate.screenCaptureProbeOk,
  };
  if (typeof candidate.grantOwnerDisplayName === "string") {
    parsed.grantOwnerDisplayName = candidate.grantOwnerDisplayName;
  }
  return parsed;
}

export function readCachedCuaPermissionStatus(
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): CuaPermissionStatus | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(CUA_PERMISSION_STATUS_CACHE_KEY) ?? null;
  } catch {
    // 隐私模式 / storage 被禁用：等价于没有缓存。
    return null;
  }
  if (!raw) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;

  const { savedAt, status } = envelope as Partial<CachedEnvelope>;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  // savedAt 在未来 = 时钟回拨或被篡改，无法判断新鲜度，不采信。
  const age = now - savedAt;
  if (age < 0 || age > CUA_PERMISSION_STATUS_CACHE_TTL_MS) return null;

  return parseCachedStatus(status);
}

export function persistCuaPermissionStatus(
  status: CuaPermissionStatusResult,
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): void {
  // unavailable 表示 Helper 没起来 / 非 macOS / 非 product 模式，是环境态而不是授权态。
  // 记住它只会让下次冷启动复现一个错误的首屏，因此不写入（也不清除已有的有效缓存）。
  if (!isCuaPermissionStatusAvailable(status)) return;

  const envelope: CachedEnvelope = { savedAt: now, status };
  try {
    storage?.setItem(CUA_PERMISSION_STATUS_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // 配额满 / 隐私模式：缓存只是首屏优化，写不进去不影响功能。
  }
}
