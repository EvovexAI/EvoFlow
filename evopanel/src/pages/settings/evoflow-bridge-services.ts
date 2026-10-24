/**
 * EvoFlow 设置中心 — ZCode UI 桥接服务工厂（共享模块）。
 *
 * mcp-server-management.tsx 与 plugin-management.tsx 两个桥接页共用的
 * Gateway HTTP service 实现：mcpSyncService / settingsSyncService /
 * clientConfigService / skillsService stub / stubPlatform。
 *
 * pluginManagementService 不在这里：MCP 桥接页使用预设市场 fake，
 * 插件桥接页使用真实的 EvoflowPluginManagementClient（/api/plugins）。
 */

import type { IPlatformService } from "@zcode/shared";
import type {
  IMcpSyncService,
  ISettingsSyncService,
} from "@zcode/services";
import { gatewayProxy } from "../../lib/tauri-api.js";

// ---------------------------------------------------------------------------
// Gateway HTTP helpers
// ---------------------------------------------------------------------------

export interface GatewayMcpConfigServer {
  name: string;
  enabled: boolean;
  transport: string;
  command: string;
  args: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  load_status?: string;
  error?: string | null;
  tool_count?: number;
  tools?: { name: string; description?: string }[];
}

export interface GatewayMcpListResponse {
  config_path?: string;
  mcp_servers?: Record<string, GatewayMcpConfigServer>;
  servers?: GatewayMcpConfigServer[];
  total_tools?: number;
}

export async function gatewayGetJson<T>(url: string): Promise<T> {
  // 桌面端走 gatewayProxy，避免裸 fetch 相对 /api 拿到 SPA HTML。
  return (await gatewayProxy("GET", url)) as T;
}

export async function gatewaySendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  return (await gatewayProxy(method, url, body ?? null)) as T;
}

function toNativeMcpServerRecord(name: string, s: GatewayMcpConfigServer) {
  const config: Record<string, unknown> = {};
  if (s.transport === "stdio") {
    if (s.command) config.command = s.command;
    if (s.args?.length) config.args = s.args;
    if (s.env) config.env = s.env;
  } else if (s.transport === "http" || s.transport === "streamableHttp") {
    if (s.url) config.url = s.url;
    if (s.headers) config.headers = s.headers;
  } else if (s.command) {
    config.command = s.command;
    if (s.args?.length) config.args = s.args;
  }
  if (s.transport) config.type = s.transport;

  return {
    source: "zcodeagentmcp" as const,
    scope: "user" as const,
    name,
    config,
    enabled: s.enabled !== false,
  };
}

// ---------------------------------------------------------------------------
// mcpSyncService — Gateway HTTP 实现
// ---------------------------------------------------------------------------

export function createEvoflowMcpSyncService(): IMcpSyncService {
  // 整个 service 强转 as IMcpSyncService — ZCode 的 McpSync schema 与 EvoFlow
  // gateway 形态不严格匹配, 只覆盖 load/list/save 三条主线。
  return {
    async loadMcpFromUserDirectory(_req: unknown) {
      const resp = await gatewayGetJson<GatewayMcpListResponse>("/api/config/mcp-servers");
      const map = resp.mcp_servers ?? {};
      const servers = Object.entries(map).map(([name, s]) =>
        toNativeMcpServerRecord(name, s as GatewayMcpConfigServer),
      );
      return { servers };
    },

    async listWorkspaceMcpServerStatuses(_params: unknown) {
      try {
        const status = await gatewayGetJson<GatewayMcpListResponse>(
          "/api/observability/mcp-status",
        );
        return {
          mcpServers: (status.servers ?? []).map((s) => ({
            name: s.name,
            enabled: s.enabled,
            status: s.load_status,
            toolCount: s.tool_count ?? 0,
            tools: s.tools ?? [],
            error: s.error ?? null,
          })),
          totalTools: status.total_tools ?? 0,
        };
      } catch {
        return { mcpServers: [], totalTools: 0 };
      }
    },

    async saveMcpToUserDirectory(payload: unknown) {
      // payload: { servers: Record<string, McpServerConfig>, projectPath? }
      const servers = (payload as unknown as { servers?: Record<string, Record<string, unknown>> }).servers ?? {};
      for (const [name, cfg] of Object.entries(servers)) {
        const transport = (cfg.type as string) ?? "stdio";
        const body: Record<string, unknown> = { name, enabled: true, transport };
        if (transport === "stdio") {
          if (typeof cfg.command === "string") body.command = cfg.command;
          if (Array.isArray(cfg.args)) body.args = cfg.args;
          if (cfg.env) body.env = cfg.env;
        } else {
          if (typeof cfg.url === "string") body.url = cfg.url;
          if (cfg.headers) body.headers = cfg.headers;
        }
        await gatewaySendJson(
          `/api/config/mcp-servers/${encodeURIComponent(name)}`,
          "PUT",
          body,
        );
      }
    },

    async listLocalUserMcpCandidates() {
      return { candidates: [] } as never;
    },

    async listRemoteUserMcpStatuses() {
      return { statuses: {} } as never;
    },

    async exportMcpServers() {
      return { servers: [] } as never;
    },

    async checkRemoteUserMcpWriteAccess() {
      return { allowed: false } as never;
    },

    async importMcpServers(_params: {
      servers: unknown[];
      localHomeDir: string;
      localWorkspacePath?: string;
      remoteWorkspacePath?: string;
      overwrite?: false;
    }) {
      return { imported: 0, skipped: 0 } as never;
    },
  } as unknown as IMcpSyncService;
}

// ---------------------------------------------------------------------------
// settingsSyncService — no-op
// ---------------------------------------------------------------------------

export function createEvoflowSettingsSyncService(): ISettingsSyncService {
  const noop = async () => ({});
  return {
    pullSettings: noop,
    pushSettings: noop,
    listPendingChanges: noop,
  } as unknown as ISettingsSyncService;
}

// ---------------------------------------------------------------------------
// Stub platform
// ---------------------------------------------------------------------------

export const evoflowStubPlatform: IPlatformService = {
  selectDirectory: async () => null,
  selectFile: async () => null,
  selectFiles: async () => [],
  activateOrSetWorkspace: async () => ({ activated: false }),
  onRemoteConnectionLog: () => () => {},
  onRemoteSessionClosed: () => () => {},
  onBotRemoteWorkspaceReconnected: () => () => {},
  connectRemote: async () => ({ success: false, error: "stub" }),
  // V4 MessageFileLink / useFileContextActions：无桌面宿主时降级，勿抛缺方法
  getInstalledEditors: async () => [],
  openInEditor: async () => ({ success: false, error: "stub" }),
  openInFileManager: async () => ({ success: false, error: "stub" }),
  openExternal: async () => {},
} as unknown as IPlatformService;
