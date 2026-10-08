import type { FileEntry, ZCodeTaskMeta, ZCodeTaskRuntimeStatus } from "@zcode/shared";
import type { IFileService } from "@zcode/services";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";
import { isChatTaskRunning } from "@/lib/chatStatus.js";
import { logger } from "@/logger.js";

const WINDOWS_RESERVED_NAME_SCAN_SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  ".turbo",
  ".vite",
]);

interface WorkspaceRemovalRiskScanOptions {
  maxEntries?: number;
  maxFindings?: number;
  skippedDirectories?: ReadonlySet<string>;
}

interface WorkspaceRemovalRiskScanResult {
  findings: string[];
  scannedEntries: number;
  truncated: boolean;
}

const DEFAULT_MAX_SCAN_ENTRIES = 10_000;
const DEFAULT_MAX_FINDINGS = 20;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set(["CON", "PRN", "AUX", "NUL"]);

for (let index = 1; index <= 9; index += 1) {
  WINDOWS_RESERVED_DEVICE_NAMES.add(`COM${index}`);
  WINDOWS_RESERVED_DEVICE_NAMES.add(`LPT${index}`);
}

export function hasRunningWorkspaceChat(params: {
  workspaceState: Pick<WorkspaceZCodeUIState, "draftRuntime" | "taskRuntimeByTaskId">;
  taskItems: Pick<ZCodeTaskMeta, "taskId">[];
}): boolean {
  if (isChatTaskRunning(params.workspaceState.draftRuntime.status)) {
    return true;
  }

  return Object.values(params.workspaceState.taskRuntimeByTaskId).some((runtimeState) =>
    isWorkspaceRemovalBlockingRuntimeStatus(runtimeState.status),
  );
}

function isWorkspaceRemovalBlockingRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return isChatTaskRunning(status);
}

function isWindowsReservedDevicePathSegment(segment: string): boolean {
  const normalizedSegment = segment.replace(/[ .]+$/u, "");
  if (!normalizedSegment) {
    return false;
  }

  const dotIndex = normalizedSegment.indexOf(".");
  const baseName = dotIndex === -1 ? normalizedSegment : normalizedSegment.slice(0, dotIndex);
  return WINDOWS_RESERVED_DEVICE_NAMES.has(baseName.toUpperCase());
}

export async function scanWindowsReservedDeviceNameFiles(
  fileService: Pick<IFileService, "readdir">,
  rootPath: string,
  options: WorkspaceRemovalRiskScanOptions = {},
): Promise<WorkspaceRemovalRiskScanResult> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_SCAN_ENTRIES;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const skippedDirectories =
    options.skippedDirectories ?? WINDOWS_RESERVED_NAME_SCAN_SKIPPED_DIRECTORIES;
  const pendingDirectories = [rootPath];
  const findings: string[] = [];
  let scannedEntries = 0;
  let truncated = false;

  while (pendingDirectories.length > 0) {
    const currentPath = pendingDirectories.shift();
    if (!currentPath) {
      continue;
    }

    let entries: FileEntry[];
    try {
      entries = await fileService.readdir({ path: currentPath, includeHidden: true });
    } catch (error) {
      // Windows 保留名风险扫描只是移除后的提示能力；单个目录无权限或被删除时不能影响项目移除。
      logger.debug("[workspaceRemovalRiskScan] 读取目录失败，跳过风险扫描子树", {
        path: currentPath,
        error,
      });
      continue;
    }

    for (const entry of entries) {
      scannedEntries += 1;
      if (isWindowsReservedDevicePathSegment(entry.name)) {
        findings.push(entry.path);
        if (findings.length >= maxFindings) {
          return { findings, scannedEntries, truncated: true };
        }
      }

      if (scannedEntries >= maxEntries) {
        truncated = true;
        return { findings, scannedEntries, truncated };
      }

      if (entry.type === "directory" && !skippedDirectories.has(entry.name)) {
        pendingDirectories.push(entry.path);
      }
    }
  }

  return { findings, scannedEntries, truncated };
}
