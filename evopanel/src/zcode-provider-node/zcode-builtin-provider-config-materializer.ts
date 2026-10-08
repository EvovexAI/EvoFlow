import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface MaterializeZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/**
 * 在环境目录释放唯一随包基线；升级以退出旧进程为前提，不保留历史 hash 副本。
 * 与下载配置分离，并复用统一锁及原子写入，避免并发启动读到半份 JSON。
 */
export async function materializeZCodeBuiltinProviderConfig(
  options: MaterializeZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  const content = `${serializeZCodeBuiltinRelease(
    decodeZCodeBuiltinRelease(JSON.parse(options.content)),
  )}\n`;
  const filePath = join(
    options.environmentConfigRoot,
    "runtime",
    "provider",
    "bundled",
    "zcode-builtin.json",
  );
  await withFileLock(filePath, async () => {
    if ((await readOptionalFile(filePath)) !== content) {
      await atomicWritePrivateTextFile(filePath, content);
    }
  });
  return filePath;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
