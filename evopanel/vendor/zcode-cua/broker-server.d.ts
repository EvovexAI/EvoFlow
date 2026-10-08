import type { CuaPermissionRestartOptions, CuaPermissionRestartResult } from "./broker.d.ts";

export declare const HELPER_ADDON_ENV: string;
export declare const WINDOWS_DEV_CONTROL_PROTOCOL: string;

export interface HelperLaunchSpec {
  [key: string]: unknown;
}

export declare function buildHelperOpenArgs(spec: HelperLaunchSpec, launcherPid?: number): string[];

export declare function isCuaLocalDevelopmentRuntime(
  env?: NodeJS.ProcessEnv,
  compiledLocalDevelopmentRuntime?: boolean,
): boolean;

export interface HelperPermissionSubjectIdentity {
  appPath: string;
  executablePath: string;
  displayName: string;
  bundleId: string;
  [key: string]: unknown;
}

export declare function resolveHelperPermissionSubjectIdentity(
  appPath: string,
): Promise<HelperPermissionSubjectIdentity>;

export interface CuaHelperVerifierDependencies {
  readExecutableArchs: (executablePath: string) => Promise<string[]>;
  [key: string]: unknown;
}

export interface CuaHelperInstallerOptions {
  env?: NodeJS.ProcessEnv;
  logger?: unknown;
  bundledAppPath?: string;
  plan?: unknown;
  dependencies?: Partial<CuaHelperVerifierDependencies>;
}

export interface CuaHelperInstaller {
  ensureInstalled(): Promise<string>;
  verifyInstalled(appPath: string, options?: unknown): Promise<void>;
}

export declare function createCuaHelperInstaller(
  options?: CuaHelperInstallerOptions,
): CuaHelperInstaller;

export declare const defaultCuaHelperVerifierDependencies: CuaHelperVerifierDependencies;

export declare function cuaBrokerRefreshMarkerPath(socketPath: string): string | undefined;
export interface CuaBrokerRefreshMarkerHandle {
  path: string;
}
export declare function publishCuaBrokerRefreshMarker(
  socketPath: string,
  options?: { deadlineMs?: number; now?: () => number },
): Promise<CuaBrokerRefreshMarkerHandle>;

export interface HelperNativeAddon {
  [key: string]: unknown;
}

export declare function loadRealNativeAddon(options?: unknown): HelperNativeAddon;
export declare function resolvePackagedNativeAddonPath(options?: unknown): string | undefined;
export declare function resolveInTreeAddonPath(options?: unknown): string | undefined;

export interface AxReadOnlySource {
  [key: string]: unknown;
}

export declare function createAxReadOnlyMethods(
  source: AxReadOnlySource,
  registry?: unknown,
  options?: unknown,
): Record<string, unknown>;
export declare const ROLE_TO_KIND: Readonly<Record<string, string>>;
export declare function roleToKind(role: string): string | undefined;

export declare class CuaHelperLifecycleManager<Managed> {
  constructor(dispose?: (managed: Managed) => Promise<void> | void);
  acquire(options: {
    isAdmitted?: () => boolean;
    shouldRetainCurrent?: (current: Managed) => boolean;
    create: () => Managed | undefined;
  }): Promise<Managed | undefined>;
  peek(): Managed | undefined;
  readonly disposed: boolean;
  dispose(managed?: Managed): Promise<void>;
}

export interface CuaProductMcpServerResolverContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  [key: string]: unknown;
}

export interface CuaHelperTransportHandle {
  socketPath: string;
  pluginAuthority: string;
  [key: string]: unknown;
}

export interface CuaPermissionStatusQueryReport {
  grant_owner: string | null;
  owner?: { display_name?: string | null } | null;
  accessibility: "granted" | "stale" | "denied" | "unknown";
  accessibility_probe?: { ok: boolean; classification?: string };
  screen_recording: "granted" | "denied" | "unknown";
  screen_capture_probe?: { ok: boolean; classification?: string };
  [key: string]: unknown;
}

export interface CuaProductHelperHost {
  readonly running: boolean;
  readonly socketPath: string | null;
  readonly pluginAuthority: string | null;
  start(): Promise<CuaHelperHandle>;
  stop(): Promise<void>;
  restart(): Promise<CuaHelperHandle>;
  restartAfterCurrentStart(): Promise<CuaHelperHandle>;
  restartAfterCurrentStartPreservingTransport?(
    restartOptions?: CuaHelperTransportRestartOptions,
  ): Promise<CuaHelperTransportRestartResult>;
  waitForTransport?(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
  checkHealth(timeoutMs?: number): Promise<import("./broker.d.ts").HelperHealth>;
}

export type ManagedCuaProductHelperHost = CuaProductHelperHost;

export interface CuaHelperHost extends CuaProductHelperHost {
  readonly reservedTransport: CuaHelperTransportHandle | undefined;
  waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
  queryScreenCaptureProbe(): Promise<{ ok: boolean; reason?: string }>;
  queryScreenRecordingPreflight(): Promise<"granted" | "denied" | "unknown" | undefined>;
  queryPermissionStatus(): Promise<CuaPermissionStatusQueryReport>;
}

export interface CuaHelperTransportRestartOptions {
  beforeFreshStart?: () => void;
  [key: string]: unknown;
}

export interface CuaHelperTransportRestartResult {
  handle: CuaHelperHandle;
  reused: boolean;
}

export interface CuaHelperHandle {
  socketPath: string;
  launchSocketPath?: string;
  pluginAuthority: string;
  helperAppPath?: string;
  bundleId?: string | null;
  pid?: number | null;
  [key: string]: unknown;
}

export interface CuaProductMcpServerConfigLike {
  [key: string]: unknown;
}

export interface CuaProductMcpServerResolver {
  resolveMcpServers<T>(
    servers: T[] | undefined,
    context?: CuaProductMcpServerResolverContext,
  ): Promise<T[] | undefined>;
  restart(): Promise<void>;
  restartAfterPermissionGrant(onboardingSessionId?: string): Promise<void>;
}

export declare class CuaProductHelperWorkspaceRegistry {
  setEnabled(context: CuaProductMcpServerResolverContext | undefined, enabled: boolean): void;
}

export interface CreateProductCuaHelperHostOptions {
  logger?: unknown;
  env?: NodeJS.ProcessEnv;
  helperInstaller?: CuaHelperInstaller;
  bundledHelperAppPath?: string;
  healthTimeoutMs?: number;
  [key: string]: unknown;
}

export declare function createProductCuaHelperHost(
  options?: CreateProductCuaHelperHostOptions,
): CuaHelperHost;

export declare function createCuaProductMcpServerResolver(
  host: CuaProductHelperHost,
  options?: { hasActiveTurn?: () => boolean },
): CuaProductMcpServerResolver;

export interface IsOfficialCuaPluginEnabledForWorkspaceOptions {
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  [key: string]: unknown;
}

export declare function isOfficialCuaPluginEnabledForWorkspace(
  options?: IsOfficialCuaPluginEnabledForWorkspaceOptions,
): boolean;

export declare function waitForCuaHelperStartup<T>(
  startup: Promise<T>,
  deadlineMs?: number,
): Promise<T>;

export declare function isPotentialZCodeCuaAgentMcpServer(server: unknown): boolean;

export interface CuaScreenCaptureProbeResult {
  ok: boolean;
  reason?: string;
}

export declare function isScreenCaptureProbeSuccess(
  probe: CuaScreenCaptureProbeResult | undefined,
): boolean;

export declare function markCuaProductHelperAgentEnvUnavailable(
  host: Pick<CuaHelperHost, "start">,
): void;
export declare function hasCuaProductHelperAgentEnvUnavailable(
  host: Pick<CuaHelperHost, "start">,
): boolean;
export declare function clearCuaProductHelperAgentEnvUnavailable(
  host: Pick<CuaHelperHost, "start">,
): void;

export declare function reapOrphanedHelpers(options: {
  logger?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<void>;

export interface HelperPermissionRequestResult {
  ok: boolean;
  reason?: string;
}

export declare function requestHelperAccessibilityPermissionViaLaunchServices(
  options?: unknown,
): Promise<HelperPermissionRequestResult>;

export declare function requestHelperScreenRecordingPermissionViaLaunchServices(
  options?: unknown,
): Promise<HelperPermissionRequestResult>;

export type { CuaPermissionRestartOptions, CuaPermissionRestartResult };
