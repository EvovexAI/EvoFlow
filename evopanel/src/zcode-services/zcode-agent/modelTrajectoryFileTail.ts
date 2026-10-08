import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir } from "#src/paths.js";

// 32 MiB 足以覆盖常规最近调用，同时避免 64/256 MiB 诊断文件造成 Host 内存峰值。
const MAX_TRAJECTORY_READ_BYTES = 32 * 1024 * 1024;

export interface TrajectoryFileTail {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

// debug（开发态）与 rollout（生产态）都尝试，避免数据目录环境变量差异导致读不到。
export function resolveModelIODirs(): string[] {
  const roots = new Set<string>([
    join(homedir(), ".zcode", "cli"),
    join(getDataBaseDir(), ".zcode", "cli"),
  ]);
  return [...roots].flatMap((root) => [join(root, "debug"), join(root, "rollout")]);
}

// 与 runner-debug.ts 的 sanitizeFileSegment 保持一致：仅保留文件名安全字符。
export function sanitizeSessionSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function readTrajectoryFileTail(filePath: string): Promise<TrajectoryFileTail> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TRAJECTORY_READ_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return { text, bytesRead, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
