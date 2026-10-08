import type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusQueryOptions,
  CuaPermissionStatusResult,
  CuaPermissionRestartOptions,
  CuaPermissionRestartResult,
  ICuaPermissionService,
} from "./broker.d.ts";

export declare function isCuaPermissionStatusAvailable(
  result: CuaPermissionStatusResult | undefined,
): result is CuaPermissionStatus;

export declare function shouldRunCuaScreenCaptureProbe(
  state: CuaPermissionState | undefined,
  options?: CuaPermissionStatusQueryOptions,
): boolean;

export type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartOptions,
  CuaPermissionRestartResult,
  ICuaPermissionService,
};
