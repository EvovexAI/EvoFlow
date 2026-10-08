// Thin re-export shim — the broker server (51 files, formerly under
// services/src/cua-permission-broker/) has been consolidated into
// @zcode/zcode-cua as part of the single-package merge. This file preserves
// the existing `#src/cua-permission-broker/index.js` import site for the
// services internal callers (node.ts, accessor.ts, etc.) so they keep
// compiling without per-file edits.
//
// Why two layers:
//   - `@zcode/zcode-cua/broker/server` (51 server files) — broker server +
//     Helper install/launch/verify/reaper + native seam + electron backend +
//     MCP injection + host orchestration + the cuaPermissionService types.
//   - `@zcode/zcode-cua/broker` (protocol) — brokerProtocol / helperErrors /
//     helperHealth / helperConstants / socketPath / brokerAuth / types / ports.
//
// Both barrels re-export the ax-types symbols (AxAppPayload, AxReadOnlySource,
// etc.) — server via axReadOnly.ts, protocol via types.ts. A bare
// `export * from both` triggers TS2308 (member already exported). We avoid the
// collision by re-exporting ONLY the protocol symbols services actually
// consumes (the env-var constants + helper identity argv constants + helper
// error class + auth/socket helpers). Everything else stays reachable through
// the server barrel's flat re-export.

// Server barrel (flat). Pulls in everything reachable from the 51 server files
// (brokerServer, cuaHelperHost, electronNativeBackend, mcpBrokerInjection,
// cuaProductMcpResolver, helperAppBundle, etc.)
// plus the ax-types re-export via axReadOnly.
export * from "@zcode/zcode-cua/broker/server";

/** @deprecated 默认 CUA 装配不再使用，仅为旧注入方保留兼容导出。 */
export {
  CuaAgentAdmissionGate,
  type CuaAgentSpawnAdmissionContext,
} from "./cuaAgentAdmissionGate.js";
// Services 自己拥有 permission-service descriptor value，并复用 producer ports type。
export {
  ICuaPermissionService,
  isCuaPermissionStatusAvailable,
  shouldRunCuaScreenCaptureProbe,
} from "./cuaPermissionService.js";
export type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
} from "./cuaPermissionService.js";

// Protocol-layer symbols services actually consumes (node.ts) that the 51
// server files do not re-export. Listed explicitly to avoid TS2308 collisions
// on the shared ax-types names.
export {
  // brokerProtocol.ts / types.ts -- these intentionally live in the protocol
  // barrel, not the server barrel. Keep the services compatibility shim
  // complete when the producer tightens its server export boundary.
  BrokerError,
  actionUnavailable,
  dispatchRequest,
  errorResponse,
  errorResponseFromException,
  handleRequestLine,
  elementUnavailable,
  foregroundRequired,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  okResponse,
  notAuthorized,
  notSelectable,
  notSettable,
  parseRequestLine,
  serializeResponse,
  // helperHealth.ts -- client-side broker RPC. Only the protocol barrel exports
  // it (the 51 server files do not), so the PiP turn-boundary closer reaches it
  // through here rather than importing the producer barrel per call site.
  callBrokerMethod,
  // socketPath.ts
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  mintBrokerSocketPath,
  resolveBrokerSocketPath,
  // helperErrors.ts
  CuaHelperError,
  isCuaHelperError,
} from "@zcode/zcode-cua/broker";
export type {
  BrokerErrorCode,
  BrokerMethod,
  BrokerRequest,
  BrokerResponse,
  CuaHelperErrorCode,
  NativeAutomationBackend,
} from "@zcode/zcode-cua/broker";

export { WindowsCuaHelperHost } from "./windowsCuaDevHelperHost.js";
export type {
  ManagedCuaProductHelperHost,
  WindowsCuaChild,
  WindowsCuaChildProcessAdapter,
  WindowsCuaHelperHostOptions,
} from "./windowsCuaDevHelperHost.js";

export { createCuaPipSessionService } from "./cuaPipSessionService.js";
export { ICuaPipSessionService } from "./cuaPipSession.js";
export type { CuaPipPresentationCredentials } from "./cuaPipSessionService.js";
export type { CuaPipSessionService } from "./cuaPipSession.js";
