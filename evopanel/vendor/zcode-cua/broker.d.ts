export declare const BROKER_SOCKET_ENV: string;
export declare const BROKER_UNAVAILABLE_ENV: string;

export declare class BrokerError extends Error {
  code: string;
  details?: unknown;
  constructor(message?: string, options?: { code?: string; details?: unknown });
}

export declare class CuaHelperError extends Error {
  code: string;
  constructor(message?: string, options?: { code?: string });
}

export declare function isCuaHelperError(value: unknown): value is CuaHelperError;

export declare const notAuthorized: (message?: string, details?: unknown) => BrokerError;
export declare const notSelectable: (message?: string, details?: unknown) => BrokerError;
export declare const notSettable: (message?: string, details?: unknown) => BrokerError;
export declare const elementUnavailable: (message?: string, details?: unknown) => BrokerError;
export declare const actionUnavailable: (message?: string, details?: unknown) => BrokerError;
export declare const foregroundRequired: (message?: string, details?: unknown) => BrokerError;

export interface HelperHealth {
  bundleId: string | null;
  pid: number | null;
}

export interface CallBrokerMethodArgs {
  socketPath: string;
  method: string;
  params?: unknown;
  timeoutMs?: number;
}

export declare function callBrokerMethod<T = unknown>(args: CallBrokerMethodArgs): Promise<T>;

export interface ProbeHelperHealthOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  perTryTimeoutMs?: number;
}

export declare function probeHelperHealth(
  socketPath: string,
  options?: ProbeHelperHealthOptions,
): Promise<HelperHealth>;

export interface SocketPathOptions {
  dir?: string;
  env?: Record<string, string | undefined>;
}

export declare function mintBrokerSocketPath(options?: SocketPathOptions): string;
export declare function resolveBrokerSocketPath(options?: SocketPathOptions): string;

export interface BrokerRequest {
  id?: string | null;
  method: string;
  params?: unknown;
}

export interface BrokerResponse {
  ok: boolean;
  [key: string]: unknown;
}

export declare function parseRequestLine(line: string): BrokerRequest | undefined;
export declare function okResponse(result: unknown): BrokerResponse;
export declare function errorResponse(message: string, options?: { code?: string }): BrokerResponse;
export declare function errorResponseFromException(error: unknown): BrokerResponse;
export declare function serializeResponse(response: BrokerResponse): string;

export type BrokerErrorCode = string;
export type BrokerMethod = string;
export type CuaHelperErrorCode = string;
export type NativeAutomationBackend = Record<string, unknown>;

export interface BrokerHandler {
  (params: unknown, context?: unknown): Promise<unknown>;
}

export declare function dispatchRequest(
  backend: NativeAutomationBackend,
  request: BrokerRequest,
): Promise<BrokerResponse>;
export declare function handleRequestLine(
  backend: NativeAutomationBackend,
  line: string,
): Promise<BrokerResponse>;

export declare function isBrokerMethod(method: string): method is BrokerMethod;
export declare function isReadOnlyBrokerMethod(method: string): boolean;

export type CuaPermissionState = "granted" | "stale" | "denied" | "unknown";

export interface CuaPermissionStatus {
  available?: true;
  platform?: string;
  grantOwner: string | null;
  owner?: { display_name?: string } | null;
  accessibility: CuaPermissionState;
  accessibility_probe_ok?: boolean;
  accessibilityProbeOk?: boolean;
  grantOwnerDisplayName?: string | null;
  screenRecording: CuaPermissionState;
  screenCaptureProbeOk?: boolean;
  idle?: boolean;
  reason?: string;
}

export interface CuaPermissionStatusUnavailable {
  available: false;
  reason: string;
  idle?: boolean;
  grantOwnerDisplayName?: string | null;
}

export type CuaPermissionStatusResult = CuaPermissionStatus | CuaPermissionStatusUnavailable;

export interface CuaPermissionStatusQueryOptions {
  probeScreenCapture?: boolean;
  [key: string]: unknown;
}

export interface CuaPermissionRestartResult {
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface CuaPermissionRestartOptions {
  onboardingSessionId?: string;
  reason?: string;
  beforeFreshStart?: () => void;
  [key: string]: unknown;
}

export interface ICuaPermissionService {
  getStatus(
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CuaPermissionStatusQueryOptions,
  ): Promise<CuaPermissionStatusResult>;
  restartHelper(
    workspacePath?: string,
    workspaceIdentity?: string,
    options?: CuaPermissionRestartOptions,
  ): Promise<CuaPermissionRestartResult>;
}
