import { useEffect, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { pendingCommandRegistry, type PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { isPendingCommandForWorkspace } from "@/v4/pendingCommandWorkspace.js";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";

interface UsePendingCommandRecoveryOptions {
  layer: SessionDataLayer;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  status: "connecting" | "live" | "error" | "closed";
  subscriptionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * pending registry 的 React 接缝：projection 用 queue/guided/transcript anchor 收口；远端 query
 * 只在 subscription 代际进入 live 时执行，不跟随 streaming snapshot 高频重跑。
 */
export function usePendingCommandRecovery({
  layer,
  sessionId,
  snapshot,
  status,
  subscriptionId,
  workspacePath,
  workspaceIdentity,
}: UsePendingCommandRecoveryOptions): readonly PendingCommandEntry[] {
  const [version, setVersion] = useState(0);

  useEffect(() => pendingCommandRegistry.subscribe(() => setVersion((current) => current + 1)), []);

  useEffect(() => {
    if (snapshot) pendingCommandRegistry.reconcileSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (status !== "live" || subscriptionId === null) return;
    // 当前 session 与 createSession(null bucket) 可并行查询；registry 内部各自 single-flight。
    const targets: Array<string | null> = sessionId === null ? [null] : [sessionId, null];
    void Promise.all(
      targets.map((target) =>
        pendingCommandRegistry.reconcileSession(target, (params) => layer.queryCommands(params)),
      ),
    ).catch((error) => {
      logger.warn("[v4-pending-command] 重连对账失败，保留账本等待下次连接", error);
    });
  }, [layer, sessionId, status, subscriptionId]);

  // version 是 registry 的窄订阅信号；不把整份账本复制进 React state。
  void version;
  const scoped = pendingCommandRegistry.listRecoverable(sessionId);
  const recoverableCreates = pendingCommandRegistry
    .listRecoverable(null)
    .filter((entry) => isPendingCommandForWorkspace(entry, workspacePath, workspaceIdentity));
  // null bucket 只表示 createSession 尚未绑定 session，不表示它没有 workspace。
  // 每个 pane 都订阅同一 registry，因此必须在展示/消费前按 workspace identity 隔离。
  return sessionId === null ? recoverableCreates : [...scoped, ...recoverableCreates];
}
