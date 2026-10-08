import { stat } from "node:fs/promises";

/** 只选择执行目录，不捕获数据库错误；无可用备用目录时保留原路径供正常启动报错。 */
export async function resolveZCodeAgentSpawnCwd(
  options: { requestedCwd: string; workspacePath: string; spawnFallbackCwd?: string },
  probe: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<{ cwd: string; usedFallback: boolean; cwdExists: boolean }> {
  const usable = async (path: string | undefined) => {
    if (!path) return false;
    try {
      return (await probe(path)).isDirectory();
    } catch {
      // 旧 Agent 对失效历史目录统一使用备用 cwd；ENOTDIR/EACCES 也必须保持这一语义。
      return false;
    }
  };
  const cwdExists = await usable(options.requestedCwd);
  if (
    options.requestedCwd === options.workspacePath &&
    !cwdExists &&
    (await usable(options.spawnFallbackCwd))
  )
    return { cwd: options.spawnFallbackCwd!, usedFallback: true, cwdExists: true };
  return { cwd: options.requestedCwd, usedFallback: false, cwdExists };
}
