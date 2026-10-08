import type { McpServerStatus, ZCodeMcpServer, ZCodeMcpServerStatusSnapshot } from "@zcode/shared";

type MappedMcpServerStatus = {
  authorization?: ZCodeMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ZCodeMcpServerStatusSnapshot["failureKind"];
  serverRequestId?: string;
  status: McpServerStatus;
};

function mapRuntimeStatusToUi(snapshot: ZCodeMcpServerStatusSnapshot): MappedMcpServerStatus {
  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
      };
    case "failed":
      return {
        status: "error",
        error: snapshot.error,
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
      };
    case "disabled":
      return { status: "unknown", error: snapshot.error };
    case "untrusted":
      return {
        status: "unknown",
        error: snapshot.error ?? "Project MCP server requires explicit connection before use.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
      };
  }
}

export function mergeMcpServerStatusSnapshots(
  servers: ZCodeMcpServer[],
  statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
  options: { markMissingConnectingAsError?: boolean } = {},
): ZCodeMcpServer[] {
  const markMissingConnectingAsError = options.markMissingConnectingAsError ?? true;
  return servers.map((server) => {
    if (server.source !== "zcodeagentmcp") {
      return server;
    }
    const snapshot = statuses[server.name];
    if (!snapshot) {
      if (markMissingConnectingAsError && server.enabled && server.status === "connecting") {
        return {
          ...server,
          // mcp/list 正常返回但缺少当前行时，继续保留 connecting 会让设置页无限转圈。
          status: "error",
          failureKind: "status_unavailable",
          toolCount: undefined,
        };
      }
      return server;
    }
    const mapped = mapRuntimeStatusToUi(snapshot);
    return {
      ...server,
      status: mapped.status,
      authorization: mapped.authorization,
      error: mapped.error,
      failureKind: mapped.failureKind,
      serverRequestId: mapped.serverRequestId,
      toolCount: snapshot.toolCount,
      changed: false,
      lastConnected:
        mapped.status === "connected" ? new Date(snapshot.updatedAt) : server.lastConnected,
    };
  });
}
