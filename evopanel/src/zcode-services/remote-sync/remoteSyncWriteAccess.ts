import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteSyncWriteAccessResult } from "@zcode/shared";

export async function checkRemoteSyncDirectoryWriteAccess(
  directoryPath: string,
): Promise<RemoteSyncWriteAccessResult> {
  const markerPath = join(directoryPath, `.zcode-sync-preflight-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(directoryPath, { recursive: true });
    await writeFile(markerPath, "ok", { encoding: "utf-8", flag: "wx" });
    await rm(markerPath, { force: true });
    return { ok: true, path: directoryPath };
  } catch (error) {
    await rm(markerPath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path: directoryPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkRemoteSyncDirectoriesWriteAccess(
  directoryPaths: readonly string[],
): Promise<RemoteSyncWriteAccessResult> {
  for (const directoryPath of directoryPaths) {
    const result = await checkRemoteSyncDirectoryWriteAccess(directoryPath);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, path: directoryPaths.join(", ") };
}
