import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { ZCODE_AGENT_RUNTIME } from "@zcode/shared";

const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : null;

function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePlatformScopedBundledAgentRoots(moduleDir?: string): Array<string | null> {
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    resolvePath(process.cwd(), "bundled-agents", platformKey),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-agents", platformKey),
    // dev:web 会用 pnpm --filter @zcode/server dev 启动，cwd 落在 packages/server。
    // ZCode Agent 资源可能位于桌面包或仓库根的 bundled-agents/<platform>。
    // 这里统一补齐仓库内所有平台化目录候选，desktop/web/server 共享一套解析链路。
    resolvePath(process.cwd(), "..", "desktop", "bundled-agents", platformKey),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-agents", platformKey) : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-agents", platformKey) : null,
  ];
}

function resolveLegacyBundledResourceRoots(moduleDir?: string): Array<string | null> {
  return [
    resolvePath(process.cwd(), "bundled-resources"),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-resources"),
    resolvePath(process.cwd(), "..", "desktop", "bundled-resources"),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-resources") : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-resources") : null,
  ];
}

export function findZCodeAgentRuntimeBinary(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];
  const envPath = process.env[runtime.binaryEnvVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // import.meta.dirname 在打包后的 CJS bundle（zcode-server.cjs）中是 undefined，
  // 直接传给 resolvePath 会报 "paths[0]" argument must be of type string。
  // 这里做空值保护，只有 import.meta.dirname 存在时才构建对应的候选路径。
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/**
 * 查找 agent 的 JS bundle（resources/glm/zcode.cjs）。
 * 桌面打包态用 app 内置的 Electron Node runtime 直接执行这个 bundle，不再随包内置独立 Node 二进制。
 * 候选目录与 findZCodeAgentRuntimeBinary 完全平行，只是入口换成平台无关的 nodeBundleEntryFile。
 * 不查 GLM_BINARY_PATH——那个 env 指向原生二进制，语义不同。
 */
export function findZCodeAgentRuntimeNodeBundle(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveNodeBundleSegments();
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];

  // 与 findZCodeAgentRuntimeBinary 一致，打包后的 CJS bundle 里 import.meta.dirname 为 undefined，
  // 这里做空值保护后再构建仓库内候选路径。
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}
