/**
 * useSystemService —— 系统服务 hooks
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  IntranetProbeRequest,
  IntranetProbeResult,
  IntranetProbeTarget,
  SystemInfo,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "./useServices.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_ATTEMPTS = 2;
const DEFAULT_PROBE_PORT = 22;
const MAX_PROBE_ATTEMPTS = 3;

function normalizeProbeTimeoutForStableKey(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeProbeAttemptsForStableKey(attempts: number | undefined): number {
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    return DEFAULT_PROBE_ATTEMPTS;
  }

  return Math.min(MAX_PROBE_ATTEMPTS, Math.max(1, Math.floor(attempts)));
}

function normalizeRequiredSuccessCountForStableKey(
  requiredSuccessCount: number | undefined,
  totalTargets: number,
): number {
  if (totalTargets <= 0) {
    return 1;
  }

  if (typeof requiredSuccessCount !== "number" || !Number.isFinite(requiredSuccessCount)) {
    return 1;
  }

  return Math.min(totalTargets, Math.max(1, Math.floor(requiredSuccessCount)));
}

function normalizeProbeTargetForStableKey(target: IntranetProbeTarget) {
  if (target.kind === "service") {
    const normalizedUrl = target.url.trim();
    const normalizedMarker = target.expectedMarker?.trim();
    const normalizedToken = target.token?.trim();

    return {
      kind: "service",
      id: target.id?.trim() || normalizedUrl,
      url: normalizedUrl,
      expectedMarker:
        normalizedMarker && normalizedMarker.length > 0 ? normalizedMarker : undefined,
      token: normalizedToken && normalizedToken.length > 0 ? normalizedToken : undefined,
      timeoutMs: normalizeProbeTimeoutForStableKey(target.timeoutMs),
    };
  }

  const normalizedHost = target.host.trim();
  const resolvedPort =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : DEFAULT_PROBE_PORT;

  return {
    kind: "tcp",
    id: target.id?.trim() || `${normalizedHost}:${resolvedPort}`,
    host: normalizedHost,
    port: resolvedPort,
    timeoutMs: normalizeProbeTimeoutForStableKey(target.timeoutMs),
  };
}

/** 生成 request 的稳定 key，避免调用方传 inline object 时因引用变化导致重复自动探测 */
function createIntranetProbeRequestStableKey(request: IntranetProbeRequest | null): string {
  if (!request) {
    return "null";
  }

  const normalizedTargets = request.targets.map(normalizeProbeTargetForStableKey);
  return JSON.stringify({
    attempts: normalizeProbeAttemptsForStableKey(request.attempts),
    requiredSuccessCount: normalizeRequiredSuccessCountForStableKey(
      request.requiredSuccessCount,
      normalizedTargets.length,
    ),
    targets: normalizedTargets,
  });
}

/** 只允许最后一次探测写回，防止并发请求乱序覆盖新状态 */
function shouldApplyIntranetProbeRunResult(runId: number, latestRunId: number): boolean {
  return runId === latestRunId;
}

/** 获取系统信息，自带 loading/error/refresh 状态管理 */
export function useSystemInfo() {
  const { systemService } = useServices();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await systemService.info();
      setInfo(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [systemService]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { info, loading, error, refresh };
}

interface UseIntranetProbeOptions {
  enabled?: boolean;
  autoProbe?: boolean;
}

/** 探测当前运行环境是否满足内网判定条件 */
export function useIntranetProbe(
  request: IntranetProbeRequest | null,
  options: UseIntranetProbeOptions = {},
) {
  const { systemService } = useServices();
  const [result, setResult] = useState<IntranetProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const enabled = options.enabled ?? true;
  const autoProbe = options.autoProbe ?? true;
  const latestProbeRunIdRef = useRef(0);
  const latestRequestRef = useRef<IntranetProbeRequest | null>(request);
  latestRequestRef.current = request;
  const requestStableKey = createIntranetProbeRequestStableKey(request);

  const probeNow = useCallback(async () => {
    // 并发探测需要代际控制，否则先发起的请求可能晚返回并覆盖新状态。
    // 这里用 runId 守卫，只允许最新一次探测落库，避免 isIntranet 在网络抖动时来回闪烁。
    const runId = latestProbeRunIdRef.current + 1;
    latestProbeRunIdRef.current = runId;
    const latestRequest = latestRequestRef.current;

    if (!enabled || !latestRequest) {
      setResult(null);
      setProbing(false);
      setError(null);
      return null;
    }

    setProbing(true);
    setError(null);
    try {
      const nextResult = await systemService.probeIntranet(latestRequest);
      if (!shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        return null;
      }
      setResult(nextResult);
      return nextResult;
    } catch (probeError) {
      const normalizedError =
        probeError instanceof Error ? probeError : new Error(String(probeError));
      if (!shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        return null;
      }
      setError(normalizedError);
      logger.warn("[IntranetProbe] 内网探测失败", normalizedError);
      return null;
    } finally {
      if (shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        setProbing(false);
      }
    }
  }, [enabled, systemService]);

  useEffect(() => {
    if (!autoProbe) {
      return;
    }

    // 自动探测不能依赖 request 对象引用：调用方传 inline object 时，每次 render 都会变引用，
    // 使 effect 持续重探测。因此 probeNow 通过 ref 读取最新 request，并保持自身引用稳定；
    // effect 使用 requestStableKey 感知内容变化，避免仅引用变化就触发自动探测。
    void probeNow();
  }, [autoProbe, enabled, probeNow, requestStableKey]);

  return {
    result,
    isIntranet: result?.isIntranet ?? false,
    probing,
    error,
    probeNow,
  };
}
