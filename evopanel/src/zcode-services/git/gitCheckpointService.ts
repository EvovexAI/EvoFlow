import { randomUUID } from "node:crypto";
import type {
  GitCheckpointDiff,
  GitCheckpointDiffQuery,
  GitCheckpointMeta,
  GitCheckpointRequest,
  GitCheckpointRestoreQuery,
  GitCheckpointRestoreResult,
  GitRepositoryRequest,
} from "@zcode/shared";
import type { IGitCheckpointService } from "./gitCheckpoint.js";
import { createGitCheckpointRepo, type GitCheckpointRepo } from "./repo/gitCheckpointRepo.js";
import { GitCheckpointStore } from "./repo/gitCheckpointStore.js";

function ensureCheckpointExists(
  meta: GitCheckpointMeta | null,
  checkpointId: string,
): GitCheckpointMeta {
  if (!meta) {
    throw new Error(`Checkpoint does not exist: ${checkpointId}`);
  }
  return meta;
}

function ensureSameWorkspace(meta: GitCheckpointMeta, workspacePath: string): void {
  if (meta.workspacePath !== workspacePath) {
    throw new Error(`Checkpoint workspace mismatch: ${meta.checkpointId}`);
  }
}

function ensureComparableCheckpoints(left: GitCheckpointMeta, right: GitCheckpointMeta): void {
  if (left.repoRoot !== right.repoRoot) {
    throw new Error("Checkpoint repoRoot mismatch.");
  }
  if (left.scope !== right.scope) {
    throw new Error("Checkpoint scope mismatch.");
  }
  if (left.workspaceInRepoPath !== right.workspaceInRepoPath) {
    throw new Error("Checkpoint workspace scope mismatch.");
  }
}

export function createGitCheckpointService(options?: {
  store?: GitCheckpointStore;
  repo?: GitCheckpointRepo;
}): IGitCheckpointService {
  const store = options?.store ?? new GitCheckpointStore();
  const repo = options?.repo ?? createGitCheckpointRepo();

  async function loadCheckpoint(
    workspacePath: string,
    checkpointId: string,
  ): Promise<GitCheckpointMeta> {
    const meta = ensureCheckpointExists(
      await store.load(workspacePath, checkpointId),
      checkpointId,
    );
    ensureSameWorkspace(meta, workspacePath);
    return meta;
  }

  return {
    async createCheckpoint(params: GitRepositoryRequest): Promise<GitCheckpointMeta> {
      const checkpointId = randomUUID();
      const meta = await repo.createCheckpoint({
        workspacePath: params.workspacePath,
        checkpointId,
      });
      await store.save(meta);
      return meta;
    },

    async diffCheckpoints(params: GitCheckpointDiffQuery): Promise<GitCheckpointDiff> {
      const [from, to] = await Promise.all([
        loadCheckpoint(params.workspacePath, params.fromCheckpointId),
        loadCheckpoint(params.workspacePath, params.toCheckpointId),
      ]);
      ensureComparableCheckpoints(from, to);
      return await repo.diffCheckpoints({
        workspacePath: params.workspacePath,
        from,
        to,
      });
    },

    async restoreBetweenCheckpoints(
      params: GitCheckpointRestoreQuery,
    ): Promise<GitCheckpointRestoreResult> {
      const [from, to] = await Promise.all([
        loadCheckpoint(params.workspacePath, params.fromCheckpointId),
        loadCheckpoint(params.workspacePath, params.toCheckpointId),
      ]);
      ensureComparableCheckpoints(from, to);
      return await repo.restoreBetweenCheckpoints({
        workspacePath: params.workspacePath,
        from,
        to,
        force: params.force,
      });
    },

    async deleteCheckpoint(params: GitCheckpointRequest): Promise<void> {
      const checkpoint = await loadCheckpoint(params.workspacePath, params.checkpointId);
      await repo.deleteCheckpoint({
        workspacePath: params.workspacePath,
        checkpoint,
      });
      await store.delete(params.workspacePath, params.checkpointId);
    },
  };
}
