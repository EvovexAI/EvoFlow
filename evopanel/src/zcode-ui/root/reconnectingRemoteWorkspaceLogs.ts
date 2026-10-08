import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface ReconnectingRemoteWorkspaceEntry {
  workspaceKey?: string;
  id?: string;
  requestId?: string;
  target: RemoteWorkspaceSessionEntry["target"];
}

function sanitizeRemoteWorkspaceReconnectLogLabelSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "-");
}

function getRemoteWorkspaceReconnectLogTargetSuffix(
  target: RemoteWorkspaceSessionEntry["target"],
): string {
  switch (target.kind) {
    case "ssh":
      return target.host;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `${distro}-${user}` : distro;
    }
    case "docker":
      return target.container;
  }
}

function buildRemoteWorkspaceReconnectLogLabelPrefix(
  target: RemoteWorkspaceSessionEntry["target"],
): string {
  return `remote-workspace-${target.kind}-${sanitizeRemoteWorkspaceReconnectLogLabelSegment(getRemoteWorkspaceReconnectLogTargetSuffix(target))}-`;
}

export function resolveRemoteWorkspaceReconnectLogWorkspaceKeys({
  runtimeLabel,
  runtimeRequestId,
  reconnectingEntries,
}: {
  runtimeLabel: string;
  runtimeRequestId?: string;
  reconnectingEntries: ReconnectingRemoteWorkspaceEntry[];
}): string[] {
  const normalizedRuntimeRequestId = runtimeRequestId?.trim();
  if (normalizedRuntimeRequestId) {
    return reconnectingEntries
      .filter((entry) => entry.requestId?.trim() === normalizedRuntimeRequestId)
      .map((entry) => entry.workspaceKey ?? entry.id ?? "")
      .filter((workspaceKey) => workspaceKey.length > 0);
  }

  if (!runtimeLabel.startsWith("remote-workspace-")) {
    return [];
  }

  const matchedEntries = reconnectingEntries.filter((entry) =>
    runtimeLabel.startsWith(buildRemoteWorkspaceReconnectLogLabelPrefix(entry.target)),
  );
  // 旧版本日志没有 requestId，只能靠 target label 前缀兜底。
  // 同一 target 并发重连时前缀会相同，继续复制到所有 workspace 会把诊断信息串到错误 tooltip。
  // 因此只有唯一命中时才按前缀归属，多命中则放弃猜测，等待带 requestId 的日志精确路由。
  if (matchedEntries.length !== 1) {
    return [];
  }

  return matchedEntries
    .map((entry) => entry.workspaceKey ?? entry.id ?? "")
    .filter((workspaceKey) => workspaceKey.length > 0);
}
