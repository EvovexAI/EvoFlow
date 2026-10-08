import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir, getWorkspaceHash } from "../../paths.js";
import type { GitCheckpointMeta } from "@zcode/shared";

function isGitCheckpointMeta(value: unknown): value is GitCheckpointMeta {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<GitCheckpointMeta>;
  return (
    typeof candidate.checkpointId === "string" &&
    typeof candidate.workspacePath === "string" &&
    typeof candidate.repoRoot === "string" &&
    typeof candidate.workspaceInRepoPath === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.refName === "string" &&
    typeof candidate.commitOid === "string" &&
    candidate.scope === "workspace"
  );
}

export class GitCheckpointStore {
  constructor(
    private readonly options?: {
      rootDir?: string;
    },
  ) {}

  private readonly writeChains = new Map<string, Promise<void>>();

  private get checkpointsDir(): string {
    return this.options?.rootDir ?? join(getAppConfigDir(), "checkpoints");
  }

  private checkpointDir(workspacePath: string): string {
    return join(this.checkpointsDir, getWorkspaceHash(workspacePath));
  }

  private checkpointFilePath(workspacePath: string, checkpointId: string): string {
    return join(this.checkpointDir(workspacePath), `${checkpointId}.json`);
  }

  private async waitForPendingWrite(filePath: string): Promise<void> {
    await this.writeChains.get(filePath)?.catch(() => {});
  }

  private enqueueWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(filePath) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(filePath, completion);
    void completion.finally(() => {
      if (this.writeChains.get(filePath) === completion) {
        this.writeChains.delete(filePath);
      }
    });
    return result;
  }

  private async writeManifestAtomic(filePath: string, meta: GitCheckpointMeta): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
    await rename(tempPath, filePath);
  }

  async save(meta: GitCheckpointMeta): Promise<void> {
    const filePath = this.checkpointFilePath(meta.workspacePath, meta.checkpointId);
    await this.enqueueWrite(filePath, async () => {
      await mkdir(this.checkpointDir(meta.workspacePath), { recursive: true });
      await this.writeManifestAtomic(filePath, meta);
    });
  }

  async load(workspacePath: string, checkpointId: string): Promise<GitCheckpointMeta | null> {
    const filePath = this.checkpointFilePath(workspacePath, checkpointId);
    try {
      await this.waitForPendingWrite(filePath);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      return isGitCheckpointMeta(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async delete(workspacePath: string, checkpointId: string): Promise<void> {
    const filePath = this.checkpointFilePath(workspacePath, checkpointId);
    await this.enqueueWrite(filePath, async () => {
      await rm(filePath, { force: true });
    });
  }
}
