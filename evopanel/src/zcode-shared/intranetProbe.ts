export interface IntranetProbeTcpTarget {
  /** 目标唯一 ID；未传时默认使用 host:port */
  id?: string;
  kind?: "tcp";
  host: string;
  /** 默认 22（SSH） */
  port?: number;
  /** 单次探测超时，默认 800ms */
  timeoutMs?: number;
}

export interface IntranetProbeServiceTarget {
  /** 目标唯一 ID；未传时默认使用 url */
  id?: string;
  kind: "service";
  /** 内网探测服务 URL，例如 由调用方通过 .env 提供 */
  url: string;
  /** 期望服务返回 marker（可选） */
  expectedMarker?: string;
  /** 简单 token（可选）；会放在 x-zcode-intranet-token 请求头 */
  token?: string;
  /** 单次探测超时，默认 800ms */
  timeoutMs?: number;
}

export type IntranetProbeTarget = IntranetProbeTcpTarget | IntranetProbeServiceTarget;

export interface IntranetProbeRequest {
  targets: IntranetProbeTarget[];
  /** 每个目标最大重试次数，默认 2，范围 [1, 3] */
  attempts?: number;
  /**
   * 命中多少个目标算“在内网”。
   * 默认 1（任一目标可达即可）。
   */
  requiredSuccessCount?: number;
}

export interface IntranetProbeTcpTargetResult {
  targetId: string;
  kind: "tcp";
  host: string;
  port: number;
  reachable: boolean;
  /** 实际尝试次数 */
  attemptCount: number;
  /** 可达时为毫秒耗时，不可达时为 null */
  latencyMs: number | null;
  /** 最后一次失败原因 */
  error?: string;
}

export interface IntranetProbeServiceTargetResult {
  targetId: string;
  kind: "service";
  url: string;
  reachable: boolean;
  /** 实际尝试次数 */
  attemptCount: number;
  /** 可达时为毫秒耗时，不可达时为 null */
  latencyMs: number | null;
  /** 服务返回 marker（如果有） */
  marker?: string;
  /** 最后一次失败原因 */
  error?: string;
}

export type IntranetProbeTargetResult =
  | IntranetProbeTcpTargetResult
  | IntranetProbeServiceTargetResult;

export interface IntranetProbeResult {
  /** 最终内网判定 */
  isIntranet: boolean;
  /** 探测成功的目标数 */
  reachedTargetCount: number;
  /** 判定阈值 */
  requiredSuccessCount: number;
  /** 参与探测的目标总数 */
  totalTargets: number;
  /** 时间戳（ms） */
  checkedAt: number;
  /** 当前探测策略 */
  strategy: "tcp-connect" | "service-http" | "mixed";
  results: IntranetProbeTargetResult[];
}

export interface IntranetProbeServiceResponse {
  ok: boolean;
  marker?: string;
}
