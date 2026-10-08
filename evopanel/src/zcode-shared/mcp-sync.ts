import type { McpServerConfig } from "./mcp.js";

export type McpSyncImportStatus = "synced" | "skipped" | "failed";
export type McpSyncSource = "zcode" | "agents";

export interface McpSyncCandidate {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncCandidateListResult {
  candidates: McpSyncCandidate[];
  localHomeDir: string;
}

export interface McpSyncRemoteStatus {
  name: string;
  exists: boolean;
  path?: string;
}

export interface McpSyncRemoteStatusResult {
  statuses: McpSyncRemoteStatus[];
  remoteHomeDir: string;
}

export interface McpSyncExportedServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncExportResult {
  servers: McpSyncExportedServer[];
  localHomeDir: string;
}

export interface McpSyncImportResultItem {
  name: string;
  status: McpSyncImportStatus;
  path?: string;
  error?: string;
}

export interface McpSyncImportResult {
  results: McpSyncImportResultItem[];
}
