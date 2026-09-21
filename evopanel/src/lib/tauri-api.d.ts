/** Ambient types for tauri-api.js — keep in sync with exported runtime symbols. */

export const api: Record<string, (...args: any[]) => Promise<any>>

export function getGatewayBaseUrl(): Promise<string>
export function setGatewayBaseUrlOverride(baseUrl: string): void
export function probeGatewayBaseUrl(options?: {
  ports?: number[]
  timeoutMs?: number
  kind?: string
}): Promise<string | null>
export function checkGatewayHealth(options?: { timeoutMs?: number }): Promise<boolean>

export function getModelCatalogPrefetch(): Promise<{
  models: any[]
  primary: string
} | null> | null

export function noteGatewayLiveness(ok: boolean): void
export function noteGatewayProcessDown(): void
export function resetGatewayWarmLatch(reason?: string): void
export function isGatewayWarming(): boolean

export function onBackendStatusChange(fn: (online: boolean) => void): () => void
export function onBackendReadyChange(fn: (ready: boolean) => void): () => void
export function isBackendOnline(): boolean
export function isBackendReady(): boolean
export function kickAppServerPrewarm(reason?: string): Promise<boolean>
export function checkBackendReady(): Promise<boolean>
export function waitForBackendReady(maxWaitMs?: number): Promise<boolean>
export function isExtendedReady(): boolean
export function checkExtendedReady(): Promise<boolean>

export function gatewayProxy(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown> | null,
  options?: { silent?: boolean; timeoutMs?: number } | null,
): Promise<any>

declare const _default: {
  api: typeof api
  getGatewayBaseUrl: typeof getGatewayBaseUrl
  setGatewayBaseUrlOverride: typeof setGatewayBaseUrlOverride
  probeGatewayBaseUrl: typeof probeGatewayBaseUrl
  checkGatewayHealth: typeof checkGatewayHealth
  getModelCatalogPrefetch: typeof getModelCatalogPrefetch
  isGatewayWarming: typeof isGatewayWarming
  waitForBackendReady: typeof waitForBackendReady
  checkBackendReady: typeof checkBackendReady
  isBackendReady: typeof isBackendReady
  onBackendReadyChange: typeof onBackendReadyChange
  onBackendStatusChange: typeof onBackendStatusChange
  isBackendOnline: typeof isBackendOnline
  noteGatewayLiveness: typeof noteGatewayLiveness
  resetGatewayWarmLatch: typeof resetGatewayWarmLatch
  kickAppServerPrewarm: typeof kickAppServerPrewarm
  isExtendedReady: typeof isExtendedReady
  checkExtendedReady: typeof checkExtendedReady
  gatewayProxy: typeof gatewayProxy
}
export default _default
