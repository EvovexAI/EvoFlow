import type {
  IPlatformService,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import type { IMcpSyncService } from "@zcode/services";
import { logger } from "@/logger.js";

export type McpPlatformService = Pick<
  IPlatformService,
  "loadMcpFromUserDirectory" | "saveMcpToUserDirectory" | "migrateLegacyCommonMcp"
>;

export type McpDirectoryService = Pick<
  IMcpSyncService,
  "loadMcpFromUserDirectory" | "saveMcpToUserDirectory"
>;

export interface MigrateLegacyResult {
  totalCount: number;
  importedCount: number;
  skippedCount: number;
  sourcePath?: string;
}

export async function persistCliMcpToUserDirectory(
  platform: McpPlatformService | null,
  payload: SaveCliMcpToUserDirectoryRequest,
  directoryService?: McpDirectoryService | null,
): Promise<boolean> {
  if (directoryService) {
    await directoryService.saveMcpToUserDirectory(payload);
    return true;
  }
  if (!platform?.saveMcpToUserDirectory) {
    logger.warn(
      "[mcpStore] platform MCP save unavailable, skip persisting CLI MCP to user directory",
    );
    return false;
  }

  const result = await platform.saveMcpToUserDirectory(payload);
  if (!result?.success) {
    throw new Error(result?.error ?? "Failed to persist MCP config");
  }
  return true;
}

async function fetchLegacyCommonMcp(
  platform: McpPlatformService | null,
  payload?: MigrateLegacyCommonMcpRequest,
): Promise<MigrateLegacyCommonMcpResult> {
  if (!platform?.migrateLegacyCommonMcp) {
    return { servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 };
  }

  return platform.migrateLegacyCommonMcp(payload ?? {});
}

export async function fetchNativeMcpServers(
  platform: McpPlatformService | null,
  payload?: LoadCliMcpFromUserDirectoryRequest,
  directoryService?: McpDirectoryService | null,
): Promise<NativeMcpServerRecord[]> {
  if (directoryService) {
    const result = await directoryService.loadMcpFromUserDirectory(payload);
    return result.servers ?? [];
  }
  if (!platform?.loadMcpFromUserDirectory) {
    return [];
  }
  const result = await platform.loadMcpFromUserDirectory(payload);
  return result.servers ?? [];
}

export async function migrateLegacyCommonMcpFromDesktop(
  platform: McpPlatformService | null,
  payload?: MigrateLegacyCommonMcpRequest,
): Promise<MigrateLegacyCommonMcpResult> {
  return fetchLegacyCommonMcp(platform, payload);
}
