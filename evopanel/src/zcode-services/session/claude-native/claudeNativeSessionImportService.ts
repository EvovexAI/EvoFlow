import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { normalize, resolve } from "node:path";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedClaudeTaskFile } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import {
  buildSearchableTextFromMessages,
  persistImportedClaudeTask,
  writeImportedClaudeTaskSnapshot,
} from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("claude-native-import");

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function cleanupCreatedArtifacts(paths: readonly string[]): Promise<void> {
  for (const path of new Set(paths)) {
    try {
      await rm(path, { force: true });
    } catch {
      // 清理失败不阻断主流程
    }
  }
}

export async function importClaudeNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession?: (source: ClaudeNativeImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
}): Promise<ZCodeImportSessionsResult> {
  const normalizedSessionIds = [
    ...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean)),
  ];
  const result: ZCodeImportSessionsResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  logger.info(
    undefined,
    `开始导入 Claude 原生 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  for (const sessionId of normalizedSessionIds) {
    let createdOutputPaths: string[] = [];
    let importedWorkspacePath: string | undefined;
    try {
      const candidate = await claudeNativeSessionImportRepo.findImportableSession({
        workspacePath: params.workspacePath,
        sessionId,
      });
      if (!candidate) {
        result.skipped.push({
          provider: "claude",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        });
        continue;
      }

      importedWorkspacePath = candidate.workspacePath;
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: "claude",
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      if (
        params.workspacePath &&
        normalizePathForComparison(importedWorkspacePath) !==
          normalizePathForComparison(params.workspacePath)
      ) {
        result.skipped.push({
          provider: "claude",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      const copiedArtifacts = await claudeNativeSessionImportRepo.copySessionFileToWorkspace({
        workspacePath: importedWorkspacePath,
        workspaceIdentity: params.workspacePath ? params.workspaceIdentity : undefined,
        sourcePath: candidate.sourcePath,
      });
      createdOutputPaths = copiedArtifacts.createdOutputPaths;

      const importedSource = await parseClaudeNativeSessionFile({
        filePath: candidate.sourcePath,
        workspacePath: importedWorkspacePath,
        sessionId,
        sourcePath: candidate.sourcePath,
        fallbackCreatedAt: candidate.createdAt,
        fallbackUpdatedAt: candidate.updatedAt,
      });

      const targetWorkspaceIdentity = params.workspacePath ? params.workspaceIdentity : undefined;
      let meta: ZCodeTaskMeta;
      if (params.createImportedSession) {
        meta = await params.createImportedSession(importedSource);
        const sessionFile = buildImportedClaudeTaskFile(importedSource, undefined, meta.taskId);
        await writeImportedClaudeTaskSnapshot({
          sessionFile: {
            ...sessionFile,
            meta: {
              ...sessionFile.meta,
              ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
            },
          },
        });
        meta = await params.taskIndexRepo.syncTaskMeta({
          meta: {
            ...meta,
            migrationSource: "claudeCode",
            workspaceIdentity: targetWorkspaceIdentity ?? meta.workspaceIdentity,
          },
          searchableText: buildSearchableTextFromMessages(sessionFile.messages),
          // 已导入会话被删除/归档后再次导入，不能继承旧行隐藏状态，
          // 否则导入结果成功但 active 列表查不到对应会话。
          archived: false,
          deleted: false,
        });
      } else {
        const sessionFile = buildImportedClaudeTaskFile(importedSource);
        meta = await persistImportedClaudeTask({
          taskIndexRepo: params.taskIndexRepo,
          sessionFile,
          workspaceIdentity: targetWorkspaceIdentity,
        });
      }
      params.onTaskImported(meta);

      result.imported.push({
        provider: "claude",
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      await cleanupCreatedArtifacts(createdOutputPaths);
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 Claude 原生 session 失败 session=${sessionId}`, error);
      result.failed.push({
        provider: "claude",
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `Claude 原生 session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
