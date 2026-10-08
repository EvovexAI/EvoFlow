export declare const CUA_REQUEST_ACCESS_STATUS_META_KEY: string;

export interface CuaRequestAccessStatus {
  schemaVersion: 1;
  platform: "darwin";
  grantOwner: string;
  accessibility: "granted" | "stale" | "denied";
  screenRecording: "unknown" | "granted" | "denied";
}

export interface CuaRequestAccessStatusSchema {
  safeParse(
    input: unknown,
  ): { success: true; data: CuaRequestAccessStatus } | { success: false; error: Error };
}

export declare const cuaRequestAccessStatusSchema: CuaRequestAccessStatusSchema;
