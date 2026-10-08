/**
 * Stub for ``@zcode/shared`` (legacy types) — minimal H2 placeholder.
 *
 * ZCode 用 ``@zcode/shared`` 暴露旧协议 (zcode-protocol.ts) + 旧会话类型 + 服务调用辅助。
 * 本文件仅声明 v4_verbatim/ 中遇到的 5 类符号；H2.5+ 才补齐完整。
 */

// Old protocol types (v3 era) — minimal stub
export interface LegacyConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt?: number
}

export interface LegacyToolCallRequest {
  id: string
  name: string
  input: unknown
  output?: unknown
}

// Account & provider types — minimal stub
export interface ZCodeAccount {
  id: string
  email: string
  displayName?: string
}

// Workspace & channel types — minimal stub
export interface ZCodeWorkspace {
  id: string
  name: string
  cwd?: string
}

export interface ZCodeChannel {
  id: string
  type: 'web' | 'desktop' | 'mobile'
  workspaceId?: string
}

// Session create source (used in v4 telemetry)
export type SessionCreateSource =
  | 'home'
  | 'shell'
  | 'plan'
  | 'inline'
  | 'restore'
  | 'share_link'
  | 'cli'

// Misc types referenced as a slice (not exhaustive)
export interface ZCodeRuntimeMeta {
  platform: 'web' | 'desktop' | 'mobile'
  version: string
}

export interface ZCodeProfile {
  id: string
  name: string
}

// ``localizeConversationShareUrl`` referenced in SessionPane
export function localizeConversationShareUrl(url: string): string {
  return url
}

// ``reportSessionCreate`` referenced in SessionPane
export function reportSessionCreate(source: SessionCreateSource): void {
  void source
}

// ``@zcode/shared`` includes many utility helpers; add stubs as v4_verbatim grows.