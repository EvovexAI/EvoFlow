import { existsSync } from "node:fs";
import { normalize } from "node:path";
import type { ZCodeAgentMcpServer } from "@zcode/shared";

function normalizePathForCompare(value: string): string {
  const normalized = normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isFilesystemServer(
  server: ZCodeAgentMcpServer,
): server is Extract<ZCodeAgentMcpServer, { command: string }> {
  return (
    "command" in server &&
    server.name === "filesystem" &&
    server.args.some((arg) => arg.includes("@modelcontextprotocol/server-filesystem"))
  );
}

export function appendWorkspaceToFilesystemMcpServers(
  mcpServers: ZCodeAgentMcpServer[] | undefined,
  workspacePath: string,
): ZCodeAgentMcpServer[] | undefined {
  if (!mcpServers || mcpServers.length === 0) {
    return mcpServers;
  }

  const trimmedWorkspacePath = workspacePath.trim();
  if (!trimmedWorkspacePath || !existsSync(trimmedWorkspacePath)) {
    return mcpServers;
  }

  let changed = false;
  const workspaceKey = normalizePathForCompare(trimmedWorkspacePath);
  const nextServers = mcpServers.map((server) => {
    if (!isFilesystemServer(server)) {
      return server;
    }

    const hasWorkspace = server.args.some((arg) => normalizePathForCompare(arg) === workspaceKey);
    if (hasWorkspace) {
      return server;
    }

    changed = true;
    // 用户目录里的 filesystem MCP 可能只包含固定目录，
    // 不会自动允许当前 workspace，导致 agent 写当前项目文件时报
    // "Access denied - path outside allowed directories"。这里仅在本机路径存在时
    // 非持久化追加当前 workspace，避免远程 workspace 被误注入本机 MCP。
    return {
      ...server,
      args: [...server.args, trimmedWorkspacePath],
    };
  });

  return changed ? nextServers : mcpServers;
}
