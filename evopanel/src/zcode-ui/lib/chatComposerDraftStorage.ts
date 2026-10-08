/**
 * 旧 composer 草稿的 localStorage 持久化清理。
 *
 * store 收尾：composer 草稿的内存态（composerDraftByScopeId）与持久化写入
 * （persistComposerDraft/readPersistedComposerDraft）已随旧 ChatView/composer 删除，
 * v4 composer 不做本地持久化。这里仅保留删除 task 时清理历史版本残留草稿键的
 * janitor 逻辑，避免旧安装升级后 localStorage 里的已删任务草稿永久残留。
 */
import { logger } from "@/logger.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedComposerDraftFile {
  version: 1;
  scopes: Record<string, unknown>;
}

const STORAGE_KEY_PREFIX = "zcode-chat-composer-drafts:v1:";
const ROOT_COMPOSER_DRAFT_SCOPE_ID = "__draft__";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getComposerDraftStorageKey(workspacePath: string, workspaceIdentity?: string) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function readPersistedDraftFile(
  storage: StorageLike | null,
  key: string,
): PersistedComposerDraftFile | null {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(key) ?? null;
  } catch (error) {
    logger.warn("[chatComposerDraftStorage] 读取 composer 草稿持久化失败", {
      error: error instanceof Error ? error.message : String(error),
      key,
    });
  }
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<PersistedComposerDraftFile>;
    if (parsed.version !== 1 || typeof parsed.scopes !== "object" || parsed.scopes === null) {
      return null;
    }
    return { version: 1, scopes: parsed.scopes };
  } catch {
    return null;
  }
}

export function clearPersistedComposerDraft(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
  storage: StorageLike | null = getBrowserStorage(),
) {
  const key = getComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readPersistedDraftFile(storage, key);
  if (!file) {
    return;
  }
  delete file.scopes[taskId ?? ROOT_COMPOSER_DRAFT_SCOPE_ID];
  try {
    if (Object.keys(file.scopes).length === 0) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, JSON.stringify(file));
    }
  } catch (error) {
    logger.warn("[chatComposerDraftStorage] 清理 composer 草稿持久化失败", {
      error: error instanceof Error ? error.message : String(error),
      key,
    });
  }
}
