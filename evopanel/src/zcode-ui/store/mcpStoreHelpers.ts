import type {
  McpConfig,
  McpServerConfig,
  McpSource,
  NativeMcpServerRecord,
  ZCodeMcpServer,
} from "@zcode/shared";

const MCP_CONFIG_KEY = "zcode-mcp-config";
export const MCP_DELETED_PRELOAD_KEY = "zcode-mcp-deleted-preload";

export const DEFAULT_MCP_CONFIG: McpConfig = {
  mcp: { mcpServers: {} },
  zcodeagentmcp: { mcpServers: {}, projects: {} },
};

export function safeReadJson<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function safeWriteJson(key: string, value: unknown): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // ignore storage errors
  }
}

export function loadPersistedConfig(): McpConfig {
  return { ...DEFAULT_MCP_CONFIG };
}

export function readLegacyCommonMcpServers(): Record<string, McpServerConfig> {
  const saved = safeReadJson<Record<string, unknown>>(MCP_CONFIG_KEY, {});
  const legacyServers = (saved.mcp as { mcpServers?: Record<string, McpServerConfig> } | undefined)
    ?.mcpServers;
  return legacyServers && typeof legacyServers === "object" ? legacyServers : {};
}

export function clearLegacyCommonMcpServers(): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(MCP_CONFIG_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function toScopeKey(projectPath?: string): string {
  if (!projectPath) {
    return "global";
  }

  const normalized = projectPath.replace(/[\\/]+$/, "");
  if (!normalized) {
    return "workspace";
  }

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}-${segments[segments.length - 1]}`;
  }
  return segments[0] ?? "workspace";
}

function toIdKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "default";
}

export function makeServerId(
  source: McpSource,
  name: string,
  projectPath?: string,
  directorySource?: NonNullable<NativeMcpServerRecord["location"]>["source"],
): string {
  const sourceKey =
    source === "zcodeagentmcp" && directorySource && directorySource !== "zcode"
      ? `${source}-${directorySource}`
      : source;
  return `${sourceKey}-${toIdKey(toScopeKey(projectPath))}-${toIdKey(name)}`;
}

export function buildServerList(
  _config: McpConfig,
  nativeServers: NativeMcpServerRecord[],
  enabledStates: Record<string, boolean>,
  deletedPreload: Set<string>,
  existingServers: ZCodeMcpServer[],
): ZCodeMcpServer[] {
  const existingById = new Map(existingServers.map((s) => [s.id, s]));

  function makeServer(
    serverId: string,
    name: string,
    serverConfig: McpServerConfig,
    source: McpSource,
    scope: ZCodeMcpServer["scope"],
    enabledBySource?: boolean,
    projectPath?: string,
    file?: ZCodeMcpServer["file"],
    location?: ZCodeMcpServer["location"],
  ): ZCodeMcpServer {
    const prev = existingById.get(serverId);
    const configChanged = prev ? !isSameMcpServerConfig(prev.config, serverConfig) : true;
    return {
      id: serverId,
      name,
      config: serverConfig,
      enabled: enabledStates[serverId] ?? prev?.enabled ?? enabledBySource ?? true,
      // MCP 配置保存后会触发设置页状态刷新；如果继续沿用旧健康状态，
      // 用户修改 timeoutMs 后会短暂看到上一版连接结果，依赖 changed 的检查也不会重新执行。
      changed: prev ? prev.changed || configChanged : true,
      status: configChanged ? "unknown" : (prev?.status ?? "unknown"),
      error: configChanged ? undefined : prev?.error,
      toolCount: configChanged ? undefined : prev?.toolCount,
      lastConnected: configChanged ? undefined : prev?.lastConnected,
      source,
      scope,
      projectPath,
      location,
      file,
    };
  }

  const servers: ZCodeMcpServer[] = [];

  for (const server of nativeServers) {
    const serverId = makeServerId(
      server.source,
      server.name,
      server.projectPath,
      server.location?.source,
    );
    if (!deletedPreload.has(serverId)) {
      servers.push(
        makeServer(
          serverId,
          server.name,
          server.config,
          server.source,
          server.scope,
          server.enabled,
          server.projectPath,
          server.file,
          server.location,
        ),
      );
    }
  }

  return servers;
}

function isSameMcpServerConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function getServerPriority(server: ZCodeMcpServer): number {
  if (server.scope === "workspace") return 2;
  if (server.scope === "user") return 1;
  return 0;
}
