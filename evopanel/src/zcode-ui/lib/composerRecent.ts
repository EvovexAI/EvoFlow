import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { logger } from "@/logger.js";

// 沿用旧 key，读取时兼容只保存 ModelSelection 的历史记录。
const COMPOSER_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ComposerRecent {
  readonly modelSelection?: ModelSelection;
  readonly mode?: SubmissionMode;
}

let submissionSequence = 0;
const acceptedSequences = new WeakMap<StorageLike, Map<string, number>>();

function resolveComposerRecentKey(workspacePath: string, workspaceIdentity?: string): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${COMPOSER_RECENT_KEY_PREFIX}:${workspaceKey}`;
}

export function readComposerRecent(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): ComposerRecent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(resolveComposerRecentKey(workspacePath, workspaceIdentity));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    // 两个叶子独立校验：模型过期或坏数据不能连带丢掉合法权限，反之亦然。
    const selection = modelSelectionSchema.safeParse(
      "modelSelection" in record ? record.modelSelection : record,
    );
    const mode = submissionModeSchema.safeParse("mode" in record ? record.mode : undefined);
    if (!selection.success && !mode.success) return null;
    return {
      ...(selection.success ? { modelSelection: selection.data } : {}),
      ...(mode.success ? { mode: mode.data } : {}),
    };
  } catch {
    return null;
  }
}

/** 发起真实 Submission 时捕获；返回函数只在 accepted ACK 后调用。 */
export function captureComposerRecentSubmission(
  workspacePath: string,
  submission: { readonly modelSelection: ModelSelection; readonly mode: SubmissionMode },
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): () => void {
  if (!storage) return () => {};
  const key = resolveComposerRecentKey(workspacePath, workspaceIdentity);
  const mode = submissionModeSchema.safeParse(submission.mode);
  const modelSelection = normalizeSparseModelSelection(submission.modelSelection);
  if (!mode.success || !modelSelection) {
    // Recent 是发送后的附带偏好；输入异常时只放弃记录，不能阻断权威 command。
    logger.warn("[ComposerRecent] 最近提交配置格式无效，跳过偏好记录", {
      workspacePath,
      workspaceIdentity,
    });
    return () => {};
  }
  const sequence = ++submissionSequence;
  const recent = {
    modelSelection,
    mode: mode.data,
  };
  let accepted = acceptedSequences.get(storage);
  if (!accepted) {
    accepted = new Map();
    acceptedSequences.set(storage, accepted);
  }
  return () => {
    // 只保存模型会让首发迁移 Root 后丢失权限；两个字段必须一起保存。
    // 同一 Renderer 内按发起顺序取最近已接纳提交，防止跨 Pane 的迟到 ACK 回写旧偏好。
    // 未接纳候选不推进水位，也不改变草稿或 CLI 的输入队列。
    if (sequence <= (accepted.get(key) ?? 0)) return;
    accepted.set(key, sequence);
    try {
      storage.setItem(key, JSON.stringify(recent));
    } catch (error) {
      // 权威发送已经接纳，本地偏好写入失败不能把它报告成发送失败。
      logger.warn("[ComposerRecent] 保存最近提交配置失败", {
        workspacePath,
        workspaceIdentity,
        error,
      });
    }
  };
}

export function resolveDraftInitialModelSelection(
  view: ModelSelectionView | null,
  recent: ModelSelection | null,
): { readonly selection: ModelSelection | null; readonly invalidated: boolean } {
  // Registry 尚未到达时不能把已有草稿意图误判为失效；先原样保留，等同一 Hook
  // 收到 View 后再做语义校验。
  if (!view) return { selection: recent, invalidated: false };
  if (recent) {
    const model = findModel(view, recent);
    if (!model) return { selection: null, invalidated: true };
    const reasoning = recent.options?.reasoningLevel;
    if (
      reasoning === undefined ||
      !model.config.optionSpecs.reasoningLevel.values.includes(reasoning)
    ) {
      // 仍保留 Provider/Model 身份，但清空失效档位；Composer 不弹泛化通知，
      // 让空的 Reasoning 控件直接要求用户作出新的明确选择。
      return {
        selection: { providerId: recent.providerId, modelId: recent.modelId },
        invalidated: true,
      };
    }
    return { selection: recent, invalidated: false };
  }
  return {
    selection:
      view.preferredSelection && isSelectionInView(view, view.preferredSelection)
        ? view.preferredSelection
        : null,
    invalidated: recent !== null,
  };
}

function isSelectionInView(view: ModelSelectionView, selection: ModelSelection): boolean {
  const model = findModel(view, selection);
  if (!model) return false;
  const reasoning = selection.options?.reasoningLevel;
  const reasoningSpec = model.config.optionSpecs.reasoningLevel;
  return reasoning !== undefined && reasoningSpec.values.includes(reasoning);
}

function findModel(view: ModelSelectionView, selection: ModelSelection) {
  return view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
}

function normalizeSparseModelSelection(selection: ModelSelection): ModelSelection | null {
  const candidate =
    selection && typeof selection === "object" && !Array.isArray(selection) ? selection : null;
  const options = candidate?.options;
  const normalizedOptions =
    options?.reasoningLevel !== undefined ? { reasoningLevel: options.reasoningLevel } : {};
  const parsed = modelSelectionSchema.safeParse({
    providerId: candidate?.providerId,
    modelId: candidate?.modelId,
    ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
