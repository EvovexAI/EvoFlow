import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface SshConnectionHistorySuggestions {
  hosts: string[];
  ports: string[];
  usernames: string[];
  privateKeyPaths: string[];
}

function dedupeSuggestions(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const normalizedValue = value.trim();
    if (!normalizedValue || seen.has(normalizedValue)) {
      return [];
    }

    seen.add(normalizedValue);
    return [normalizedValue];
  });
}

export function buildSshConnectionHistorySuggestions(
  remoteWorkspaceSessions: readonly RemoteWorkspaceSessionEntry[],
): SshConnectionHistorySuggestions {
  const sshSnapshots = remoteWorkspaceSessions.flatMap((entry) =>
    entry.target.kind === "ssh" ? [entry.target] : [],
  );

  return {
    // SSH 历史候选要按最近连接顺序去重展示，否则同一个 host / username
    // 会在多次连接后重复堆叠，focus 打开下拉时很难找到真正最近使用的项。
    hosts: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.host)),
    ports: dedupeSuggestions(sshSnapshots.map((snapshot) => String(snapshot.port ?? 22))),
    usernames: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.username)),
    privateKeyPaths: dedupeSuggestions(
      sshSnapshots.map((snapshot) => snapshot.privateKeyPath ?? ""),
    ),
  };
}
