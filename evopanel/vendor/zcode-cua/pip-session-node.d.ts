import type { PipSessionEvent } from "./pip-session.d.ts";

export interface PipSessionApplyResult {
  applied: boolean;
  reason?: string;
}

export interface PipSessionClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  peerChecker?: (peer: unknown) => boolean;
  onDiagnostic?: (diagnostic: { code: string; message?: string }) => void;
}

export interface PipSessionClient {
  enabled: boolean;
  connect(): Promise<void>;
  send(event: PipSessionEvent): Promise<PipSessionApplyResult>;
  close(): void;
}

export declare function createPipSessionClient(options?: PipSessionClientOptions): PipSessionClient;
