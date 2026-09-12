/** Ambient types for workspace + session helpers (implementation in tauri-api.js). */
 
export const api: Record<string, (...args: any[]) => Promise<any>>
export function getGatewayBaseUrl(): Promise<string>
export function setGatewayBaseUrlOverride(baseUrl: string): void
export function probeGatewayBaseUrl(options?: { ports?: number[]; timeoutMs?: number }): Promise<string | null>
export function checkGatewayHealth(options?: { timeoutMs?: number }): Promise<boolean>
