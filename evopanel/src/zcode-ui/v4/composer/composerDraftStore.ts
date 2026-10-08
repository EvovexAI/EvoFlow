// composer parity：v4 composer 的 per-session 草稿持久化（新做，轻量 localStorage）。
//
// 旧草稿面（zcodeSessionStore composerDraftByScopeId + chatComposerDraftStorage 写路径）
// 已随 store 收尾删除；本模块是 v4 侧替代——键空间独立（v4 前缀），不与旧键互写，
// 旧键清理仍归 chatComposerDraftStorage 的 janitor。
// 语义：scope = sessionId（draft 态 = "__draft__"）；保存 text + editorStateJson，外部预填在
// Lexical 尚未挂载时额外保存 mention（保证重挂载不降级为纯文本）。
// mode/modelSelection 与正文同 scope 保存；发送只清内容，显式清理才删除整个 scope。
// 附件不入草稿（objectUrl/File 不可序列化，localPath 附件重启后归属难校验——
// 与「v4 composer 不做附件草稿持久化」的裁决一致）。
import { logger } from "@/logger.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

export interface V4ComposerDraft {
  text: string;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  /** 有合法 mode 表示已经初始化；没有模型仍是明确空态，不能按旧文本草稿补默认。 */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  /** 已处理的工具变更，防止重连快照再次覆盖用户选择。 */
  lastPlanTransitionId?: string;
  lastPermissionGrantId?: string;
  modelSelection?: ModelSelection;
  /** 首次分享导入等待公共新任务初始化；不能由空 Session snapshot 抢先填充。 */
  initializeFromNewTask?: true;
  updatedAt: number;
}

interface V4DraftFile {
  version: 1;
  scopes: Record<string, V4ComposerDraft>;
}

const STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
export const V4_DRAFT_SCOPE_ROOT = "__draft__";
const warnedStorageKeys = new Set<string>();

function warnStorageFailure(key: string, error: unknown) {
  if (warnedStorageKeys.has(key)) return;
  warnedStorageKeys.add(key);
  logger.warn("[v4-composer-draft] 草稿持久化访问失败", {
    error: error instanceof Error ? error.message : String(error),
    key,
  });
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getV4ComposerDraftStorageKey(workspacePath: string, workspaceIdentity?: string): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function readDraftFile(key: string): V4DraftFile {
  const storage = getStorage();
  try {
    const raw = storage?.getItem(key);
    if (!raw) return { version: 1, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
      return { version: 1, scopes: {} };
    }
    const scopes = Object.fromEntries(
      Object.entries(parsed.scopes).flatMap(([scopeId, value]) => {
        const draft = readDraft(value);
        return draft ? [[scopeId, draft]] : [];
      }),
    );
    return { version: 1, scopes };
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDraft(value: unknown): V4ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const mode = submissionModeSchema.safeParse(value.mode);
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // 坏 options 不应连带丢掉可确定的模型身份；不读取旧 provider/model/thought 别名。
  const identity = isRecord(value.modelSelection)
    ? modelSelectionSchema.safeParse({
        providerId: value.modelSelection.providerId,
        modelId: value.modelSelection.modelId,
      })
    : null;
  const modelSelection = selection.success
    ? selection.data
    : identity?.success
      ? identity.data
      : undefined;
  const mention = value.mention;
  const hasMention =
    isRecord(mention) &&
    ["id", "category", "label", "value", "markdown"].every(
      (key) => typeof mention[key] === "string",
    ) &&
    ["files", "skills", "commands", "subagents", "whiteboards", "sessions", "plugins"].includes(
      String(mention.category),
    );
  return {
    text: value.text,
    ...(typeof value.editorStateJson === "string"
      ? { editorStateJson: value.editorStateJson }
      : {}),
    ...(hasMention ? { mention: mention as unknown as ComposerMentionPrefill } : {}),
    ...(mode.success ? { mode: mode.data === "plan" ? ("build" as const) : mode.data } : {}),
    ...(typeof value.planEnabled === "boolean"
      ? { planEnabled: value.planEnabled }
      : mode.success
        ? { planEnabled: mode.data === "plan" }
        : {}),
    ...(typeof value.lastPermissionGrantId === "string"
      ? { lastPermissionGrantId: value.lastPermissionGrantId }
      : {}),
    ...(typeof value.lastPlanTransitionId === "string"
      ? { lastPlanTransitionId: value.lastPlanTransitionId }
      : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(value.initializeFromNewTask === true && !mode.success
      ? { initializeFromNewTask: true as const }
      : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function writeDraftFile(key: string, file: V4DraftFile) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    if (Object.keys(file.scopes).length === 0) {
      storage.removeItem(key);
      return true;
    }
    storage.setItem(key, JSON.stringify(file));
    warnedStorageKeys.delete(key);
    return true;
  } catch (error) {
    // 配额/隐私模式失败只降级为不持久化，不影响输入。
    warnStorageFailure(key, error);
    return false;
  }
}

export function readV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): V4ComposerDraft | null {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const draft = readDraftFile(key).scopes[scopeId];
  if (!draft || typeof draft.text !== "string") {
    return null;
  }
  return draft;
}

export function persistV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  draft: Omit<V4ComposerDraft, "updatedAt">,
) {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  if (
    !draft.text.trim() &&
    !draft.editorStateJson &&
    !draft.mention &&
    !draft.mode &&
    !draft.modelSelection &&
    !draft.initializeFromNewTask
  ) {
    delete file.scopes[scopeId];
  } else {
    file.scopes[scopeId] = { ...draft, updatedAt: Date.now() };
  }
  return writeDraftFile(key, file);
}

export function clearV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
) {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  if (!(scopeId in file.scopes)) {
    return true;
  }
  delete file.scopes[scopeId];
  return writeDraftFile(key, file);
}
