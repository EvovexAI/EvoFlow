export type RuntimeToolId = "bfs" | "ripgrep" | "ugrep";

export interface RuntimeToolRuntimeDescriptor {
  binaryEnvVar: string;
  bundledResourceDir: string;
  resolveEntrySegments(platform: string): string[];
}

export interface RemoteRuntimeToolDescriptor extends RuntimeToolRuntimeDescriptor {
  versions: Readonly<Partial<Record<string, string>>>;
}

export interface ResolvedRemoteRuntimeTool {
  toolId: RuntimeToolId;
  runtime: RemoteRuntimeToolDescriptor;
  version: string;
}

function resolvePlatformBinaryName(binaryName: string, platform: string): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export const RUNTIME_TOOL_RUNTIME: Record<RuntimeToolId, RuntimeToolRuntimeDescriptor> = {
  bfs: {
    binaryEnvVar: "ZCODE_BFS_BINARY",
    bundledResourceDir: "bfs",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("bfs", platform)],
  },
  ripgrep: {
    binaryEnvVar: "ZCODE_RG_BINARY",
    bundledResourceDir: "ripgrep",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("rg", platform)],
  },
  ugrep: {
    binaryEnvVar: "ZCODE_UGREP_BINARY",
    bundledResourceDir: "ugrep",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("ugrep", platform)],
  },
};

export const REMOTE_RUNTIME_TOOL_RUNTIME = {
  bfs: {
    ...RUNTIME_TOOL_RUNTIME.bfs,
    versions: {
      linux: "v4.1.1-2",
    },
  },
  ripgrep: {
    ...RUNTIME_TOOL_RUNTIME.ripgrep,
    versions: {
      darwin: "v13.0.0-10",
      linux: "v14.1.1-1",
    },
  },
  ugrep: {
    ...RUNTIME_TOOL_RUNTIME.ugrep,
    versions: {
      linux: "v7.8.4-1",
    },
  },
} as const satisfies Record<RuntimeToolId, RemoteRuntimeToolDescriptor>;

export function getRemoteRuntimeToolsForPlatform(platform: string): ResolvedRemoteRuntimeTool[] {
  // Linux remote 已切到 native-search 三工具，但 Darwin 仍依赖 legacy rg13。
  // 部署集合必须按目标平台解析，不能用一个全局版本把两条发布链互相覆盖。
  return (
    Object.entries(REMOTE_RUNTIME_TOOL_RUNTIME) as Array<
      [RuntimeToolId, RemoteRuntimeToolDescriptor]
    >
  ).flatMap(([toolId, runtime]) => {
    const version = runtime.versions[platform];
    return version ? [{ toolId, runtime, version }] : [];
  });
}

export function getRuntimeToolRuntime(toolId: RuntimeToolId): RuntimeToolRuntimeDescriptor {
  return RUNTIME_TOOL_RUNTIME[toolId];
}
