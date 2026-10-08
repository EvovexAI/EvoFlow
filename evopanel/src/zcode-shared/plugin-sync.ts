export type PluginSyncImportStatus = "synced" | "skipped" | "failed";
export type PluginSyncComponentType = "skills" | "commands" | "hooks" | "mcp";

export interface PluginSyncCandidate {
  id: string;
  name: string;
  pluginId: string;
  directoryName: string;
  description?: string;
  version?: string;
  path: string;
  sizeBytes: number;
  enabled: boolean;
  enabledOverride?: boolean;
  componentTypes: PluginSyncComponentType[];
}

export interface PluginSyncCandidateListResult {
  candidates: PluginSyncCandidate[];
  maxArchiveBytes: number;
}

export interface PluginSyncRemoteStatus {
  pluginId: string;
  directoryName: string;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
}

export interface PluginSyncRemoteStatusResult {
  statuses: PluginSyncRemoteStatus[];
}

export interface PluginSyncArchiveExportResult {
  archive: Uint8Array;
  archiveBytes: number;
  plugins: Array<{
    id: string;
    name: string;
    pluginId: string;
    directoryName: string;
    enabled?: boolean;
  }>;
}

export interface PluginSyncMarketplaceSourceArchiveExportResult {
  archive: Uint8Array;
  archiveBytes: number;
  marketplaceId: string;
  pluginNames: string[];
}

export interface PluginSyncMarketplaceSourceImportResult {
  marketplaceId: string;
  path: string;
  status: Exclude<PluginSyncImportStatus, "failed">;
}

export interface PluginSyncImportResultItem {
  name: string;
  pluginId: string;
  directoryName: string;
  status: PluginSyncImportStatus;
  path?: string;
  error?: string;
}

export interface PluginSyncImportResult {
  results: PluginSyncImportResultItem[];
}
