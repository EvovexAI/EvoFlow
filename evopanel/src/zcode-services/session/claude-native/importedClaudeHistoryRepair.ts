import { readFile } from "node:fs/promises";
import type {
  ZCodeAgentMcpServer,
  ZCodeSessionImportHistory,
  ZCodeSessionImportMessage,
  ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import { buildImportedClaudeTaskId } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";

interface ImportedClaudeHistoryRepairTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

interface ImportedClaudeHistoryRepairResult {
  traceId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ZCodeSessionImportMessage[];
  source: "legacySnapshot" | "nativeJsonl";
}

interface ImportedClaudeSessionRepairTarget extends ImportedClaudeHistoryRepairTarget {
  mcpServers?: ZCodeAgentMcpServer[];
}

interface ImportedClaudeSessionRepairCreateParams {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  mode: ZCodeSessionStateSnapshot["session"]["mode"];
  model: ZCodeSessionStateSnapshot["settings"]["model"]["current"];
  thoughtLevel?: string;
  persistence: "immediate";
  mcpServers?: ZCodeAgentMcpServer[];
  importedHistory: ZCodeSessionImportHistory;
}

function toImportMessages(
  messages: readonly { role: string; content: string; timestamp?: number }[],
): ZCodeSessionImportMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
      timestamp: message.timestamp,
    }));
}

function countAssistantMessages(messages: readonly ZCodeSessionImportMessage[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

function shouldRepairImportedClaudeSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "runtime" | "session">,
): boolean {
  if (snapshot.session.status === "running" || snapshot.runtime.activeTurnId) {
    return false;
  }
  const hasLegacyFixedMessageIds = snapshot.messages.some((message) =>
    /^msg_import_\d+$/u.test(message.info.messageId),
  );
  if (!snapshot.session.sessionId.startsWith("claude-import-") && !hasLegacyFixedMessageIds) {
    // user-only / assistant-first 只是异常形态，不等于 Claude 导入。
    // 只有稳定导入 taskId 或旧版全局 msg_import_* 污染能证明它属于迁移修复边界，
    // 避免普通 ZCode session 被同名 legacy 备份误回填成 Claude 历史。
    return false;
  }
  const hasAssistant = snapshot.messages.some((message) => message.info.role === "assistant");
  if (!hasAssistant) {
    return true;
  }
  if (snapshot.messages[0]?.info.role === "assistant") {
    return true;
  }
  // 旧协议导入把所有 Claude session 都写成 msg_import_0/msg_import_1。
  // 这些 ID 是全局主键，后续导入会把前一个 session 的消息改绑到新 session，
  // 即使当前快照里有 assistant，也必须按原 Claude jsonl 重新回填，修正串会话和反序。
  return hasLegacyFixedMessageIds;
}

export async function readLegacyImportedClaudeHistory(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
  const snapshotPaths = [
    getLegacyTaskSessionSnapshotPath(target.workspacePath, target.taskId, target.workspaceIdentity),
    getLegacyDeletedTaskSessionSnapshotPath(
      target.workspacePath,
      target.taskId,
      target.workspaceIdentity,
    ),
  ];
  let raw: string | undefined;
  for (const path of snapshotPaths) {
    try {
      raw = await readFile(path, "utf-8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (raw === undefined) return null;

  const parsed = safeParseLegacyTaskSessionFile(JSON.parse(raw) as unknown);
  if (!parsed.success || parsed.data.meta.migrationSource !== "claudeCode") {
    return null;
  }
  const messages = toImportMessages(parsed.data.messages);
  return messages.length > 0
    ? {
        traceId: parsed.data.meta.traceId,
        title: parsed.data.meta.title,
        createdAt: parsed.data.meta.createdAt,
        updatedAt: parsed.data.meta.updatedAt,
        messages,
        source: "legacySnapshot",
      }
    : null;
}

async function readNativeImportedClaudeHistory(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
  const candidates = await claudeNativeSessionImportRepo.scanImportableSessions({
    workspacePath: target.workspacePath,
  });
  const candidate = candidates.find(
    (item) => buildImportedClaudeTaskId(item.workspacePath, item.sessionId) === target.taskId,
  );
  if (!candidate) {
    return null;
  }

  const importedSource = await parseClaudeNativeSessionFile({
    filePath: candidate.sourcePath,
    workspacePath: candidate.workspacePath,
    sessionId: candidate.sessionId,
    sourcePath: candidate.sourcePath,
    fallbackCreatedAt: candidate.createdAt,
    fallbackUpdatedAt: candidate.updatedAt,
  });
  const messages = toImportMessages(importedSource.messages);
  return messages.length > 0
    ? {
        title: importedSource.title,
        createdAt: importedSource.createdAt,
        updatedAt: importedSource.updatedAt,
        messages,
        source: "nativeJsonl",
      }
    : null;
}

async function resolveImportedClaudeHistoryForRepair(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
  const legacyHistory = await readLegacyImportedClaudeHistory(target);
  if (legacyHistory && countAssistantMessages(legacyHistory.messages) > 0) {
    return legacyHistory;
  }

  const nativeHistory = await readNativeImportedClaudeHistory(target);
  if (
    nativeHistory &&
    countAssistantMessages(nativeHistory.messages) >=
      countAssistantMessages(legacyHistory?.messages ?? [])
  ) {
    // 旧版本可能已经把 user-only 的 legacy 备份写坏了。
    // 这时 legacy 不能再作为权威来源，需要按 taskId 反查原 Claude jsonl 重建 assistant。
    return nativeHistory;
  }

  return legacyHistory;
}

export async function repairImportedClaudeSessionSnapshot<T>(params: {
  snapshot: ZCodeSessionStateSnapshot;
  target: ImportedClaudeSessionRepairTarget;
  createSession(input: ImportedClaudeSessionRepairCreateParams): Promise<T>;
  onRepair?(history: ImportedClaudeHistoryRepairResult): void;
}): Promise<T | null> {
  if (!shouldRepairImportedClaudeSnapshot(params.snapshot)) {
    return null;
  }
  const history = await resolveImportedClaudeHistoryForRepair(params.target);
  if (!history) {
    return null;
  }

  params.onRepair?.(history);
  // 早期导入可能已经创建了真实 ZCode session，但没有把 Claude 历史写入
  // zcode-cli sessionStore，或用了全局 msg_import_* 导致串会话。这里统一用同名 sessionId
  // 幂等回填 importedHistory，让 session/read、task snapshot 和远控恢复路径走同一套修复。
  return params.createSession({
    workspacePath: params.target.workspacePath,
    workspaceIdentity: params.target.workspaceIdentity,
    sessionId: params.target.taskId,
    mode: params.snapshot.session.mode,
    model: params.snapshot.settings.model.current,
    thoughtLevel: params.snapshot.settings.thoughtLevel.current,
    persistence: "immediate",
    mcpServers: params.target.mcpServers,
    importedHistory: {
      source: "claudeCode",
      title: history.title,
      createdAt: history.createdAt,
      updatedAt: history.updatedAt,
      messages: history.messages,
    },
  });
}
