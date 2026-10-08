/* oxlint-disable eslint(max-lines) -- composer 集中收口输入区 wiring（附件/草稿/历史/mention），拆分会打散收口粒度。 */
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
/**
 * v4 会话 composer（composer parity）。
 *
 * 壳：ChatPromptEditor（Lexical 编辑器 + 动作菜单 + 拖拽反馈 + sticky 底座视觉），
 * 附件预览网格/大图预览/错误提示区一并提供。
 *
 * 芯：全新 v4 wiring——
 * - 路由/状态一律读 v4 投影 snapshot.inputRouting / control / config / usage；
 * - 发送键状态机对齐旧 UI：canSend（有文本或附件+路由允许）/ pending spinner /
 *   running+空草稿 → Stop（v4 stop 命令）/ 暂停队列（choice）→ 发送后弹清空/保留确认框；
 * - 附件全链路见 useComposerAttachments（发送经 v4 sendText attachments）；
 * - mention（@ 文件/画板、# 会话、$ 技能）与 slash 目录全集在 LexicalChatInput 内接线；
 * - 草稿 per-session 持久化（composerDraftStore）+ prompt history（promptHistoryStorage）；
 * - 工具条（模型/思考深度/模式/context usage）见 V4ComposerToolbar。
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_STOP,
  testId,
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ArrowUpIcon,
  ClipboardPenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  ChatErrorBanner,
  resolveChatErrorBannerDisplayMessage,
  shouldSuppressChatErrorBanner,
} from "@/ChatErrorBanner.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { runUserAction, startUserAction } from "@/lib/userActionTelemetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isMediaChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import { resolveChatEnterShortcut } from "@/lib/mobileTextInput.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  readWorkspaceFileDragPayload,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { resolveProviderBaseURL } from "@/lib/registryProviderView.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import { consumeV4ComposerDraftWorkspaceTransferRequest } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

export interface ConversationComposerSendOptions {
  /** 点击发送时复制的配置；null 表示未完成选择，Host 不得从 Session 补齐。 */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** 发送确认框打开时看到的暂停队列 ID；CLI 用它拦截跨端增删竞态。 */
  expectedHeldQueueItemIds?: readonly string[];
  /** 附件命令面：已序列化附件（宿主转 AttachmentRef 后随 v4 sendText/createSession 发送）。 */
  attachments?: AttachmentRef[];
  /** Prompt 文本内携带的上下文附件数量；用于阻止 /goal 等本地命令误消费。 */
  contextAttachmentCount?: number;
  /** renderer-only：ACK accepted 后由 SessionPane 绑定真实 commandId/sessionId。 */
  telemetrySeed?: ConversationPromptTelemetrySeed;
  /** 本次 busy input 的一次性投递覆盖，不改 session 偏好。 */
  requestedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
}

export type ConversationComposerSendResult = "sent" | "blocked" | "confirmationRequired";
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // Workspace 插件详情会卸载聊天 Composer。结构化 mention 必须从共享草稿事实源恢复，
    // 不能只依赖一次性插入事件，否则重挂载时会退化成 canonical 普通文本。
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

export interface ComposerRestoreRequest {
  requestId: number;
  sessionId: string;
  workspaceKey: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;
}

function applyComposerRestoreRequestToComposer({
  appliedRequestId,
  currentSessionId,
  currentWorkspaceKey,
  hasDraftContent,
  inputApi,
  request,
  requestFocus,
  restoreSessionOwnedAttachments,
  restoreDraftConfig,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  currentSessionId: string | null;
  currentWorkspaceKey: string;
  hasDraftContent: boolean;
  inputApi: Pick<LexicalChatInputHandle, "setText"> | null;
  request: ComposerRestoreRequest | null | undefined;
  requestFocus: () => void;
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  restoreDraftConfig?: (config: NonNullable<ComposerRestoreRequest["config"]>) => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (
    request.sessionId !== currentSessionId ||
    request.workspaceKey !== currentWorkspaceKey ||
    hasDraftContent ||
    !inputApi
  ) {
    return appliedRequestId;
  }
  if (!restoreSessionOwnedAttachments(request.attachments)) {
    return appliedRequestId;
  }
  inputApi.setText(request.text);
  updateText(request.text);
  if (request.config) restoreDraftConfig?.(request.config);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

function arePromptHistoryEntriesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** 草稿 scope（sessionId；draft 态 null → "__draft__" scope）。 */
  sessionId?: string | null;
  /** Skill catalog authority；草稿预热完成后为 prewarmSessionId，不改变 task/draft 身份。 */
  skillCatalogSessionId?: string | null;
  /** draft 态无 snapshot，但仍可 createSession 首发。 */
  draftMode?: boolean;
  /** renderer 当前草稿配置意图；只在 draftMode 下覆盖迟到的 prewarm projection。 */
  draftConfig?: Partial<SessionConfigState>;
  /** SessionPane 注入的完整 Draft owner；生产路径不再由编辑器直接覆盖持久记录。 */
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 当前 Composer 是否能构造完整 Submission；空模型或空 Reasoning 时为 false。 */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;
  /** 仅供发送埋点冻结模型维度；包含草稿初始化 config 与显式 intent 的合并值。 */
  telemetryDraftConfig?: Partial<SessionConfigState>;
  /**
   * 空态 contextHeader（m5-composer-parity）：workspace 切换菜单 + Git 分支
   * 切换器，渲染在编辑器上方（旧 ChatViewComposer contextHeaderContent 同位）。
   * 仅草稿态由宿主下发；会话建立后为空。
   */
  contextHeader?: ReactNode;
  /** 居中草稿布局（旧 shouldUseCenteredDraftChatLayout）：收窄 max-w-2xl、去 sticky。 */
  centered?: boolean;
  /**
   * v4 bottom dock 阻塞交互 id。存在时 composer 只隐藏不卸载，保留草稿、附件与编辑器实例。
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  /**
   * 是否在新建任务 / 切换会话 / 挂载后自动把光标聚焦到输入框（默认开）。
   * 竖切多 pane 时由宿主传入 SessionPane.focused，仅焦点 pane 聚焦、后台 pane 不抢焦点。
   */
  autoFocusEnabled?: boolean;
  /** 当前 composer 是否运行在手机 Web 远控壳中。 */
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** SessionPane 从目标 Host 原子读取的选择事实；Composer 不自行解析 Host。 */
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  /** Model Selection 首次读取失败后的显式重试入口。 */
  modelSelectionReload?: () => void;
  /** 草稿态使用预热 session 作附件 transaction 载体。 */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;
  /** 宿主 pane 与 workspace 遮罩共同裁决的真实可见性，仅用于 visible-only telemetry。 */
  telemetryVisible?: boolean;
  /** 点击发送时读取套餐身份；二次确认会继续复用同一份冻结 seed。 */
  readPlanIdentitySnapshot?: () => PlanIdentitySnapshot;
  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  /** 把当前输入文本上抛给父组件（editUserQuery 用 composer 文本作 newText）。 */
  onTextChange?: (text: string) => void;
  /** queue 撤回 admission 读取的完整 composer 占用态；附件包含上传中状态。 */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** 目录选中模型（providerId/modelId）；thought/revision 由宿主从最新投影补齐。 */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
  ) => void;
  /** 选中思考深度；同时带上用户操作时看到的模型，避免异步回流后把 thought 归到另一模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** 打开当前 session 的 Status panel，并直达 Running 明细。 */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * 后台任务入口点击的落点：`"workflow-run"` = 唯一在跑的工作流直达详情页（宿主判定），
   * 缺省 `"panel"` = 展开状态胶囊。入口据此换 tooltip；行为本身在 onOpenRunningBackgroundWorks 里。
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** context usage 面板的 /compact 入口（宿主走 v4 compact 命令）。 */
  onSendCompressionCommand?: (command: string) => void;
  /** v4 会话级错误（snapshot.control.lastError），展示在输入框上方。 */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** 无可用模型横幅的恢复动作；由 SessionPane 注入壳层导航，组件不直接操作 tab。 */
  onOpenModelSettings?: () => void;
  onOpenModelUpgrade?: () => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * 是否监听全局「加入对话」事件（workspace file tree / 画板按钮）。
   * 分屏时仅 primary pane 监听，避免一次点击插入两份。
   */
  listenAddToChatEvents?: boolean;
  /**
   * 外部一次性文本预填请求（Example Prompt 等）。
   * requestId 保证同一文本可连续取回两次时仍能触发回填。
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   * 队列“编辑”在 delete ACK 后把完整未来意图取回输入框。
   * requestId + session/workspace binding 保证幂等且不会串写其他 task。
   */
  composerRestoreRequest?: ComposerRestoreRequest | null;
  onComposerRestoreApplied?: (requestId: number) => void;
  /** 副屏会话不提供 goal 能力；协议层仍会拒绝直接调用。 */
  suppressGoalCommands?: boolean;
  /** App 层本地斜杠命令（如 `/side`），由 SessionPane 按门禁组装后透传。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** 把 composer 的 drop 路由暴露给整个对话 pane / 桌面草稿标题栏。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
}

function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

function ConversationComposerImpl({
  snapshot,
  sessionId = null,
  skillCatalogSessionId = sessionId,
  draftMode = false,
  draftConfig,
  composerDraft,
  updateComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  telemetryDraftConfig,
  contextHeader,
  centered = false,
  blockingRequestId = null,
  disabled = false,
  autoFocusEnabled = true,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  attachmentSessionId = null,
  attachmentPut,
  onRuntimeRestart,
  onRuntimeLifecycle,
  provider,
  telemetryVisible = true,
  readPlanIdentitySnapshot,
  onSendText,
  onTextChange,
  onDraftStateChange,
  onStop,
  onSelectModel,
  onSelectThought,
  onSwitchMode,
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onOpenModelSettings,
  onOpenModelUpgrade,
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  composerRestoreRequest = null,
  onComposerRestoreApplied,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
}: ConversationComposerProps) {
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const draftScopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  // 固定 key 的 SessionPane 会跨 task/draft 复用 composer，旧 picker owner
  // 因此跟着实例进入新 scope。提交新 scope portal 前同步归零，避免菜单闪现一帧；
  // 旧 Radix layer 随后到达的 close 事件由下方 scope guard 丢弃。
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({
      scopeKey: configPickerScopeKey,
      activePicker: null,
    });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // composer 内容为导航 rail 恢复 pointer-events 后，三个 Radix modal
      // picker 的独立 open 状态会在同一次 pointerdown 中竞争，旧 layer 无法可靠 dismiss。
      // 关闭回调可能晚于兄弟 picker 的打开回调，只允许它清理自己，避免误关接管者。
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );
  const [heldQueueConfirmation, setHeldQueueConfirmation] = useState<{
    queueItemIds: readonly string[];
    telemetrySeed: ConversationPromptTelemetrySeed;
    requestedDelivery?: "startNow" | "queue" | "guide";
  } | null>(null);
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // submit 经 ref 读取最新文本/pending，避免回调随每次输入变更引用。
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // 这条线断过一次：composer 原本读一个平行的 sharedContextImport prop，而 SessionPane 从没
  // 传过它（全仓 `sharedContextImport=` 零命中），于是首条消息永远不带 sharedContextRefs。
  // 现在从必然拿到的 snapshot 推导，理由与边界见 resolveAttachableShareContext。
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const reportedErrorKeysRef = useRef(new Set<string>());
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  const enterSubmits = true;
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      setText(next);
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  // ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
  });
  // 对齐旧版 useChatComposer：窗口级 dragover 会在指针进入 ChatView 前预先点亮
  // 整个聊天区与桌面草稿标题栏；workspace payload 的文案优先于系统附件。
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragOverComposer(event);
    },
    [attachmentsApi.handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragLeaveComposer(event);
    },
    [attachmentsApi.handleDragLeaveComposer],
  );
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // 文件树 payload 与 OS File[] 语义不同：只插入 mention，绝不能进入上传队列。
        event.preventDefault();
        attachmentsApi.handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: updateText,
        });
        return;
      }
      attachmentsApi.handleDropComposer(event);
    },
    [attachmentsApi.handleDropComposer, updateText, workspaceIdentity, workspacePath],
  );
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useEffect(() => {
    onDropTargetControllerChange?.(dropTargetController);
    return () => onDropTargetControllerChange?.(null);
  }, [dropTargetController, onDropTargetControllerChange]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const hasAttachments = attachmentsApi.hasAttachments;
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // queue 撤回等待 ACK 时 composer 处于 disabled；此时也要阻止全局 add-to-chat
    // 写入网页上下文，避免权威删除成功后撞上 ACK 窗口内的新草稿。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({ sessionId, workspaceKey });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // ── 草稿 per-session 持久化（切会话/刷新不丢；mention pill 经 editorStateJson 保真）──
  const draftScopeRef = useRef(draftScopeId);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const suppressDraftPersistRef = useRef(false);

  const snapshotDraftOfEditor = useCallback((): {
    text: string;
    editorStateJson?: string;
  } => {
    const currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const editorState = inputApiRef.current?.getEditorState();
      editorStateJson = editorState ? JSON.stringify(editorState.toJSON()) : undefined;
    } catch (error) {
      logger.warn(`[v4-composer] 草稿 editorState 序列化失败: ${String(error)}`);
    }
    return currentText.trim()
      ? { text: currentText, ...(editorStateJson ? { editorStateJson } : {}) }
      : { text: "" };
  }, []);

  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (suppressDraftPersistRef.current) return;
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        updateComposerContent(content);
        return;
      }
    },
    [snapshotDraftOfEditor, updateComposerContent, workspaceIdentity, workspacePath],
  );

  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow]);

  // ── 自动聚焦（新建任务 / 切会话 / 挂载后把光标交还输入框）──
  // 触发源：startDraft 递增的 draftFocusVersion（覆盖 Cmd/Ctrl+N 与所有「新建任务」入口）、
  // sessionId→draftScopeId 变化（切会话/切草稿）、以及挂载。三者置位聚焦意图；因切到需
  // 连接的会话时 composer 短暂 disabled，聚焦意图暂存，待可编辑时兑现一次。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const pendingFocusRef = useRef(false);
  // 本次 focus 是否由程序触发（见 flushPendingFocus），供 send_input_focus 过滤非用户动作。
  const programmaticFocusRef = useRef(false);
  // 发送键与 Enter 共用同一个 form submit；按钮 onClick 早于 submit 触发，
  // 借此区分 send_click 的 send_trigger，读取后立刻复位回默认的 shortcut。
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // 修饰键点击先于 form submit；这里只保存这一拍的 delivery 反转意图，submit 消费后清零。
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // 决策入参经 ref 读取，避免把 autoFocusEnabled/disabled/viewport 灌进 scope effect 依赖，
  // 触发多余的草稿重恢复（disabled 变化本不应重放草稿）。
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: false,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: false,
  };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // 程序性聚焦与用户点击输入框会触发同一个 DOM focus 事件；置位后由 handleEditorFocus
    // 消费，避免把「切会话 / 挂载回焦 / 上下文块移除后回焦」误报成 send_input_focus。
    programmaticFocusRef.current = true;
    // Lexical root 可能晚一帧就绪，聚焦排到下一帧（与草稿回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // queue 撤回等待 ACK 时 composer 处于 disabled；与网页上下文保持同一写入门禁。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  useEffect(() => {
    if (!composerRestoreRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyComposerRestoreRequestToComposer({
        appliedRequestId: appliedComposerRestoreRequestRef.current,
        currentSessionId: sessionId,
        currentWorkspaceKey: workspaceKey,
        hasDraftContent:
          textRef.current.length > 0 ||
          attachmentsApi.attachments.length > 0 ||
          codeCommentContexts.length > 0 ||
          webElementContexts.length > 0 ||
          pptxElementReferences.length > 0 ||
          conversationSelectionReferences.length > 0,
        inputApi: inputApiRef.current,
        request: composerRestoreRequest,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        // 撤回项携带独立 Submission 配置；沿用草稿 owner，一次恢复且保留已处理授权标记。
        restoreDraftConfig: (config) =>
          replaceComposerDraft({
            ...ownerDraftRef.current.draft,
            ...config,
            text: composerRestoreRequest.text,
            editorStateJson: undefined,
            mention: undefined,
          }),
        scheduleDraftPersist,
        updateText,
      });
      const appliedNow =
        nextAppliedRequestId === composerRestoreRequest.requestId &&
        appliedComposerRestoreRequestRef.current !== composerRestoreRequest.requestId;
      appliedComposerRestoreRequestRef.current = nextAppliedRequestId;
      if (appliedNow) onComposerRestoreApplied?.(composerRestoreRequest.requestId);
      return nextAppliedRequestId === composerRestoreRequest.requestId;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    attachmentsApi.attachments.length,
    attachmentsApi.restoreSessionOwnedAttachments,
    codeCommentContexts.length,
    composerRestoreRequest,
    conversationSelectionReferences.length,
    onComposerRestoreApplied,
    replaceComposerDraft,
    requestComposerFocus,
    scheduleDraftPersist,
    sessionId,
    updateText,
    webElementContexts.length,
    pptxElementReferences.length,
    workspaceKey,
  ]);

  // scope 切换：先落旧 scope 草稿，再恢复新 scope（editorStateJson 优先，退纯文本）。
  useEffect(() => {
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (targetChanged && !suppressDraftPersistRef.current) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const previousDraft = snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId === V4_DRAFT_SCOPE_ROOT &&
        draftScopeId === V4_DRAFT_SCOPE_ROOT &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // 项目解绑只改变草稿的 cwd；输入正文、mention editor state 和组件内附件继续保留。
        replaceComposerDraft({ ...ownerDraftRef.current.draft, ...previousDraft });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };

    const draft = transferredDraft ?? composerDraft;
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(`[v4-composer] 草稿 editorState 恢复失败，退纯文本: ${String(error)}`);
          },
        }),
      );
    };
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // 草稿恢复后把光标交还输入框（切会话/切草稿/挂载）；连接中会话待可编辑后兑现。
      requestComposerFocus();
    };
    // Lexical root 可能晚一帧就绪；draft 恢复排到下一帧（与旧 initialValue 回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => cancelAnimationFrame(frame);
    }
    applyDraft();
    return undefined;
    // 依赖收敛到 scope/workspace：draft 恢复只应发生在 scope 切换或 workspace 切换。
  }, [
    draftScopeId,
    persistDraftNow,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateText,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
    replaceComposerDraft,
  ]);

  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // 外部预填和 scope 恢复可能在同一轮发生。若预填 effect 先执行，后续恢复会用旧草稿
  // 覆盖用户刚点的 Example Prompt；因此必须在 scope 恢复之后应用并确认单次插入请求。
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // 新建任务（含已在草稿态重复 Cmd/Ctrl+N，scope 未变）：startDraft 递增 nonce 即重新聚焦。
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // 切到需连接的会话时 disabled=true，聚焦意图 defer；连接完成 disabled→false 时兑现一次。
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // 刷新/关窗前落盘当前草稿。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
    };
  }, [persistDraftNow]);

  // ── prompt history（per-workspace localStorage，↑/↓ 导航由 PromptHistoryPlugin 消费）──
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
  });
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  const hasText = text.trim().length > 0;
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    Boolean(pendingShareContext);
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    Boolean(pendingShareContext);
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice 保留正常发送按钮；提交后由 SessionPane 按 slash 语义决定是否弹确认框。
  // V4 重构时把 guide 当成“不可提交”状态，导致按钮和 Enter 同时失效；
  // guide 是 CLI 已授权的 busy 输入路由，是否最终 steer 或回退 queue 由命令层裁决。
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  const canSend =
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    routingAllowsSend &&
    attachmentsReady &&
    submissionReady;
  // 旧 UI 状态机：streaming + 空草稿 → Stop；有草稿 → 发送键（入队）。
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  const submit = useCallback(
    async (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingTelemetrySeed?: ConversationPromptTelemetrySeed,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) => {
      const trimmed = textRef.current.trim();
      const submittedQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      const hasPendingAttachments = attachmentsApi.attachments.length > 0;
      const currentCodeCommentContexts = getCodeCommentContexts();
      const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
      const currentWebElementContexts = webElementContexts;
      const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContext = pendingShareContext;
      // 草稿首发 accepted 后同一 composer 会原地从 __draft__ promotion 到
      // session scope；若成功清理时再读可变 ref，会误清新 scope，并把首条输入残留在
      // __draft__，下次新建任务又恢复。发送开始时冻结真正提交的 scope。
      const submittedDraft = snapshotDraftOfEditor();
      let cleanupRevision = contentRevisionRef.current;
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      if (
        (!trimmed &&
          !hasPendingAttachments &&
          !hasPendingCodeCommentContexts &&
          !hasPendingWebElementContexts &&
          !hasPendingPptxElementReferences &&
          !hasPendingConversationSelections &&
          !submittedShareContext) ||
        pendingRef.current ||
        !submissionReady ||
        (createSubmissionFromComposer !== undefined && submission === null) ||
        attachmentsApi.hasUnreadyAttachments
      ) {
        return;
      }
      const sendAction = startUserAction({
        featureId: "conversation.composer.message",
        action: "send",
        trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
        workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
      });
      pendingRef.current = true;
      setPending(true);
      // Bug 根因：草稿 intent 只保存用户显式改动，正常继承模型位于冻结初始化 config。
      // prewarm snapshot 尚未到达时若只读 draftConfig，send_btn 会错误落成空模型/glm。
      const telemetryConfig = telemetryDraftConfig ?? snapshotRef.current?.config ?? draftConfig;
      let telemetrySeed: ConversationPromptTelemetrySeed;
      if (existingTelemetrySeed) {
        // 队列二次确认复用首次点击的 seed：不重报 send_click，也不重置发送触发来源，
        // 保证 send_click 与 send_result 严格 1:1。
        telemetrySeed = existingTelemetrySeed;
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, false);
      } else {
        const freshSeed: ConversationPromptTelemetrySeed = {
          sendTime: Date.now(),
          localTtft: !workspaceIdentity?.trim()
            ? getLocalTtftObserver()?.start(
                workspacePath,
                (snapshotRef.current !== null &&
                  snapshotRef.current.inputRouting.mode !== "startNow") ||
                  false,
                trimmed.startsWith("/"),
              )
            : undefined,
          extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
            askMode: telemetryConfig?.mode,
            modelName: telemetryConfig?.model,
            configProvider: telemetryConfig?.provider,
            agentProvider: provider,
            providerBaseURL: resolveProviderBaseURL(telemetryConfig?.provider, modelSelectionView),
            planIdentitySnapshot: readPlanIdentitySnapshot?.(),
          }),
        };
        const sendTrigger = sendTriggerRef.current;
        sendTriggerRef.current = "shortcut";
        // recordSendClick 回填 sendClickId，必须用它的返回值作为后续 seed，
        // 否则落定时拿不到关联键，send_result 会被当成后台任务跳过。
        telemetrySeed =
          conversationTelemetry?.recordSendClick({
            sessionId: sessionId ?? null,
            seed: freshSeed,
            trigger: sendTrigger,
          }) ?? freshSeed;
      }
      let promptHistoryBeforeSend: readonly string[] | null = null;
      let promptHistoryAfterAppend: readonly string[] | null = null;
      let promptHistoryWasPersisted = false;
      let draftSubmissionClaimed = false;
      let editorClearedOptimistically = false;
      const claimSubmittedDraft = () => {
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // 首发 promotion 会在 onSendText 返回前切换 scope 或重建 Composer。
        // 若仍允许旧 scope effect 落盘，新 Composer 会把已经发送的正文当草稿恢复。
        // 提交前先占用并隐藏该草稿；失败路径再恢复，避免用等待时间掩盖竞态。
        suppressDraftPersistRef.current = true;
        updateComposerContent({ text: "" });
        draftSubmissionClaimed = true;
      };
      const restoreSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        // 用户在等待期间已经产生更新时，当前完整正文是更新后的事实；旧失败回包不能覆盖。
        if (contentRevisionRef.current === cleanupRevision) {
          updateComposerContent(submittedDraft);
        }
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
        if (editorClearedOptimistically && contentRevisionRef.current === cleanupRevision) {
          if (submittedDraft.editorStateJson) {
            inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
          } else {
            inputApiRef.current?.setText(submittedDraft.text);
          }
          updateText(submittedDraft.text);
          editorClearedOptimistically = false;
        }
      };
      const finalizeSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
      };
      const rollbackPromptHistory = () => {
        if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
          return;
        }
        const currentPromptHistory = readPromptHistoryEntries(workspacePath);
        if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
          persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
          setPromptHistory(promptHistoryBeforeSend);
          return;
        }
        setPromptHistory(currentPromptHistory);
      };
      try {
        // 二次门禁：只消费预传完成的 ref，不在点击发送时回落上传。
        const readyAttachmentRefs = await attachmentsApi.prepareForSend();
        if (readyAttachmentRefs === null) {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // send_click 已上报，此处不落定会留下无配对的悬空样本，污染成功率分母。
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "attachment_not_ready",
          });
          sendAction.fail({ failureStage: "attachment_not_ready" });
          return;
        }
        // 外部上下文不走协议附件；按 selection -> code comment -> web -> PPTX 的固定尾块顺序
        // 序列化，历史 user row 才能按相反顺序无损解析并隐藏内部 prompt block。
        //
        // 分享 handover 不在这里序列化：share URL 块纯粹是 renderer 自产自销（CLI/shared
        // 里没有任何东西解析它），唯一作用是驱动一个已被产品裁掉的 chip，代价却是把一个
        // share URL 塞进发给模型的正文。模型侧内容由隐藏的 shared_context 消息经
        // inputIntent.sharedContextRefs 注入，与正文无关。
        const promptText = serializeComposerPromptContexts(trimmed, {
          codeComments: currentCodeCommentContexts,
          conversationSelections: currentConversationSelections,
          webElements: currentWebElementContexts,
          pptxElements: currentPptxElementReferences,
        });
        const contextAttachmentCount =
          countComposerPromptContexts({
            codeComments: currentCodeCommentContexts,
            conversationSelections: currentConversationSelections,
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
          }) + (submittedShareContext ? 1 : 0);
        if (trimmed) {
          promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
          promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
          if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
            // 预热首发 accepted 后，SessionPane 会立即 promote 到新 session，
            // draft composer 可能在 await 恢复前卸载；不能把写盘藏在 React state updater 里。
            // 这里继续沿用旧 UI 的 localStorage history，不接 input_history 数据库：
            // 发起真实发送前先同步写盘，若发送失败再恢复到发送前快照。
            persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
            promptHistoryWasPersisted = true;
            setPromptHistory(promptHistoryAfterAppend);
          }
        }
        claimSubmittedDraft();
        if (requestedDelivery === "startNow") {
          // 原子抢占需要等旧 turn 退出并提交新 TurnStarted ACK；
          // 若编辑器也等整条链路才清空，用户会误以为快捷键未生效。
          // 先清空可见正文；命令拒绝时用冻结 editor state 原样恢复。
          inputApiRef.current?.clear();
          updateText("");
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = true;
        }
        const sendResult = await onSendText(promptText, {
          submission,
          telemetrySeed,
          ...(requestedDelivery ? { requestedDelivery } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
          ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
          ...(submittedShareContext
            ? {
                sharedContextRefs: [
                  {
                    kind: "shared_context_import" as const,
                    context_id: submittedShareContext.contextId,
                  },
                ],
              }
            : {}),
        });
        if (sendResult === "blocked") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // 产品 guard 是一次正常拒绝，不应借异常路径表达；回滚发送前暂记的 history，
          // 同时不 clear editor/draft/附件，让用户切换模式后可以直接重试。
          rollbackPromptHistory();
          restoreSubmittedDraft();
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "blocked",
          });
          sendAction.reject({ resultSource: "authority_ack", admissionResult: "rejected" });
          return;
        }
        if (sendResult === "confirmationRequired") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, true);
          rollbackPromptHistory();
          restoreSubmittedDraft();
          const latestQueueItemIds =
            snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
          // 首次提交冻结当前队列；跨端 stale 后用最新投影替换，要求用户重新确认。
          setHeldQueueConfirmation({
            // 标记 queueConfirmed：确认后复用该 seed 落定，send_cost_ms 含用户在弹窗上的停留。
            telemetrySeed: { ...telemetrySeed, queueConfirmed: true },
            ...(requestedDelivery ? { requestedDelivery } : {}),
            queueItemIds:
              latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
          });
          sendAction.noop();
          return;
        }
        setHeldQueueConfirmation(null);
        // 暂存内容只有在发送成功后才移交给 task；失败仍保留为可重试草稿。
        await attachmentsApi.adoptSentAttachments(submittedAttachmentIds);
        // Bug 原因：发送等待期间产生的新正文属于下一次 Submission，旧 ACK 不能清除。
        if (contentRevisionRef.current === cleanupRevision) {
          inputApiRef.current?.clear();
          updateText("");
        }
        attachmentsApi.clearAttachments(submittedAttachmentIds);
        // 与附件相同，只移除本次冻结的引用；等待期间新加入的引用属于下一条消息。
        currentCodeCommentContexts.forEach(removeCodeCommentContext);
        currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
        currentPptxElementReferences.forEach((reference) =>
          removePptxElementReference(reference.id),
        );
        currentConversationSelections.forEach((reference) =>
          removeConversationSelectionReference(reference.id),
        );
        // 发送成功：清本次提交捕获的 scope 草稿；prompt history 已在真实发送前同步写盘，
        // 避免首发 promote 丢失或误清 promotion 后的新 scope。
        finalizeSubmittedDraft();
        sendAction.complete({ resultSource: "authority_ack", admissionResult: "accepted" });
      } catch (error) {
        rollbackPromptHistory();
        restoreSubmittedDraft();
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        // 发送失败草稿保留在输入框（不清空），仅记录原因。
        logger.warn(`[v4-composer] 发送失败: ${String(error)}`);
        // ACK 侧失败已由 SessionPane 落定；能走到这里的是 composer 自身链路异常。
        conversationTelemetry?.settleSendResult({
          seed: telemetrySeed,
          sessionId: sessionId ?? null,
          status: "fail",
          reasonCode: "composer_error",
        });
        sendAction.fail({ failureStage: "composer_send" });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [
      attachmentsApi,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      createSubmissionFromComposer,
      submissionReady,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      onSendText,
      pendingShareContext,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Lexical onChange（首字符也稳定回传，见 LexicalChatInput.TextContentPlugin）。
  const handleEditorChange = useCallback(
    (value: string) => {
      conversationTelemetry?.recordComposerTextChange(value);
      updateText(value);
      // 正文先进入与 mode/model 相同的内存 Draft；防抖只负责补充最新 Lexical JSON。
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [conversationTelemetry, scheduleDraftPersist, updateComposerContent, updateText],
  );

  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // 程序性聚焦不算「点击输入框」；标记一次性消费，之后的手动 focus 照常上报。
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // 编辑器提交（Enter / 发送键 form submit 同路径）。返回 false：编辑器不自行 reset，
  // 由 submit 成功后经 inputApiRef.clear() 清空——失败时草稿留在输入框。
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // inputRouting 在 turn 启动初期可能仍为 startNow，不能用它
      // 推断空闲。组合键始终表达单次反向 delivery；空闲时 CLI 自然 startNow。
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleStopClick = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.composer.message", action: "stop", trigger: "button" },
      operation: onStop,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "stop_generation",
    });
  }, [onStop]);

  // 发送键是 type="submit"，与 Enter 共用 handleEditorSubmit；DOM 事件顺序保证 click 早于
  // submit，故这里只置标记，由 submit() 读取并复位。
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      sendTriggerRef.current = "button";
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  // ── 「加入对话」全局事件（workspace file tree 右键/按钮）→ mention 插入 ──
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [listenAddToChatEvents, updateText, workspaceIdentity, workspacePath]);

  // 动态 placeholder（旧 chatViewPlaceholder 语义）：无历史 → newTask；
  // 有历史空闲 → followUpAsk；有历史处理中 → followUpQueue。
  const placeholder = intl.formatMessage({
    id: resolveChatPlaceholderKey({
      hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
      isTaskProcessing: canStop,
      compactNewTask: false,
    }),
  });
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;

  useEffect(() => {
    if (!visibleError || !conversationTelemetry || !telemetryVisible) return;
    const telemetryKey = [
      visibleError.taskId ?? sessionId ?? "",
      visibleError.code ?? "",
      visibleError.traceId ?? "",
      visibleError.message,
    ].join(":");
    if (reportedErrorKeysRef.current.has(telemetryKey)) return;
    reportedErrorKeysRef.current.add(telemetryKey);
    // 错误只有经过 suppression 后真实进入 render 才曝光；同一 composer mount 相同 key 一次。
    conversationTelemetry.reportVisibleChatError({
      errorKey: telemetryKey,
      displayMessage: resolveChatErrorBannerDisplayMessage(visibleError, intl),
      error: visibleError,
    });
  }, [conversationTelemetry, intl, sessionId, telemetryVisible, visibleError]);

  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () =>
        runUserAction({
          input: {
            featureId: "conversation.composer.attachment",
            action: "add",
            trigger: "button",
          },
          operation: attachmentsApi.openAttachmentPicker,
          completed: { resultSource: "local_commit" },
          failureStage: "attachment_picker",
        }),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, attachmentsApi.openAttachmentPicker],
  );

  // ── 附件预览网格 ──
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  const topContentNode = useMemo(() => {
    if (
      composerAttachments.length === 0 &&
      codeCommentContexts.length === 0 &&
      webElementContexts.length === 0 &&
      pptxElementReferences.length === 0 &&
      conversationSelectionReferences.length === 0
    ) {
      return null;
    }
    return (
      <div className="flex max-w-full flex-col items-start gap-2">
        {composerAttachments.length > 0 ? (
          <Attachments
            variant="inline"
            className="flex max-w-full flex-wrap gap-2"
            data-composer-file-attachments-row="true"
          >
            {orderedComposerAttachments.map((attachment) => {
              const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
              const isMediaAttachment = isMediaChatComposerAttachment(attachment);
              const isVideoAttachment = isVideoChatComposerAttachment(attachment);
              const isPdfAttachment = isPdfChatComposerAttachment(attachment);
              const mediaType = attachment.objectUrl
                ? attachment.mimeType
                : attachment.mimeType.startsWith("image/")
                  ? "application/octet-stream"
                  : attachment.mimeType;
              const canPreviewImageAttachment =
                Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
              const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
              const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
              const fileDisplayDescriptor = resolveFileDisplayDescriptor(
                attachment.localPath ?? attachment.filename,
              );
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              return (
                <Attachment
                  key={attachment.id}
                  variant={isMediaAttachment ? "grid" : "inline"}
                  data-composer-attachment-kind={
                    isVideoAttachment
                      ? "video"
                      : isMediaAttachment
                        ? "image"
                        : isPdfAttachment
                          ? "pdf"
                          : "file"
                  }
                  data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                  data-upload-status={attachment.uploadStatus}
                  className={
                    isMediaAttachment
                      ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                      : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
                  }
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    ...(isClipboardTextAttachment
                      ? {
                          description: intl.formatMessage(
                            {
                              id: "chat.attachments.clipboardText.description",
                            },
                            {
                              lineCount: formatAttachmentLineCount(attachment, locale),
                            },
                          ),
                          displayName: intl.formatMessage({
                            id: "chat.attachments.clipboardText",
                          }),
                          sourceKind: "clipboard-text" as const,
                        }
                      : {}),
                    mediaType,
                    url: attachment.objectUrl ?? "",
                  }}
                  onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                  // 附件支持非图片格式，PDF 走独立 PdfViewer，
                  // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
                  // 图片与视频统一按添加顺序进入发送前 gallery，
                  // 保证同一组媒体可以连续导航。
                  onOpen={
                    canPreviewImageAttachment || canPreviewVideoAttachment
                      ? () => {
                          const previewIndex = composerMediaPreviewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (previewIndex < 0) return;
                          setAttachmentPreviewIndex(previewIndex);
                          setAttachmentPreviewOpen(true);
                        }
                      : canPreviewPdfAttachment
                        ? () => {
                            setPdfAttachmentPreview({
                              filename: attachment.filename,
                              mediaType: "application/pdf",
                              url: attachment.objectUrl,
                            });
                            setPdfAttachmentPreviewOpen(true);
                          }
                        : undefined
                  }
                  openLabel={
                    canPreviewVideoAttachment
                      ? videoAttachmentPreviewTitle
                      : canPreviewImageAttachment
                        ? attachmentPreviewTitle
                        : canPreviewPdfAttachment
                          ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                          : undefined
                  }
                >
                  <div
                    className={cn(
                      "relative shrink-0",
                      isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                    )}
                  >
                    <AttachmentPreview
                      className={cn(
                        isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                      )}
                      fallbackIcon={
                        isClipboardTextAttachment ? (
                          <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <FileDisplayIcon
                            src={fileDisplayDescriptor.fileIconSrc}
                            size={16}
                            className="size-4 shrink-0"
                          />
                        )
                      }
                    />
                    {showUploadStatus && isMediaAttachment ? (
                      <span
                        data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {!isMediaAttachment ? (
                    isClipboardTextAttachment ? (
                      <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                    ) : (
                      <div className="min-w-0 max-w-40 flex-1">
                        <span
                          className="block truncate text-ui-base font-medium text-foreground"
                          title={attachment.filename}
                        >
                          {attachment.filename}
                        </span>
                        <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                          {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                        </span>
                      </div>
                    )
                  ) : null}
                  {showUploadStatus && !isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      title={uploadStatusLabel}
                      className={cn(
                        "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                        attachment.uploadStatus === "failed" && "text-destructive",
                      )}
                    >
                      {attachment.uploadStatus === "uploading"
                        ? `${attachment.uploadProgress}%`
                        : uploadStatusLabel}
                    </span>
                  ) : null}
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      type="button"
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                      aria-label={intl.formatMessage({
                        id: "chat.attachments.upload.retry",
                      })}
                      title={uploadStatusLabel}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        attachmentsApi.retryAttachment(attachment.id);
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-composer-attachment-remove={attachment.id}
                    aria-label={intl.formatMessage({
                      id: "chat.attachments.remove",
                    })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.removeAttachment(attachment.id);
                    }}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {codeCommentContexts.length > 0 ||
        webElementContexts.length > 0 ||
        pptxElementReferences.length > 0 ||
        conversationSelectionReferences.length > 0 ? (
          <div
            className="flex max-w-full flex-wrap items-center gap-2"
            data-composer-context-attachments-row="true"
          >
            <CodeCommentAttachmentChip
              comments={codeCommentContexts}
              onRemove={removeCodeCommentContext}
              onRemoveAll={clearCodeCommentContexts}
            />
            <WebElementContextAttachmentChip
              contexts={webElementContexts}
              onRemove={removeWebElementContext}
              onRemoveAll={clearWebElementContexts}
            />
            <PptxElementReferenceChip
              references={pptxElementReferences}
              onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
              onRemove={removePptxElementReference}
              onRemoveAll={clearPptxElementReferences}
            />
            <ConversationSelectionReferenceChip
              references={conversationSelectionReferences}
              onRemove={removeConversationSelectionReference}
              onRemoveAll={clearConversationSelectionReferences}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    attachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContext,
    removePptxElementReference,
    conversationSelectionReferences,
    pendingShareContext,
    webElementContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // 发送/停止控制簇（对齐旧 ChatViewComposer.submitControlNode 结构：
  // 左侧 model/thought/usage 簇 + 右侧 stop 或 send）。
  // useMemo：composer 随流式 snapshot 高频重渲染，控制簇只在语义依赖变化时重建，
  // 避免每个 token 批次都重建 Tooltip/Select 子树。
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (nextProvider: string, nextModel: string, sourceModel: ModelSelectionSource | null) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () => onSelectModel(nextProvider, nextModel, sourceModel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
          <V4ComposerModelControls
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            modelSelectionView={modelSelectionView}
            modelSelectionState={modelSelectionState}
            modelSelectionReload={modelSelectionReload}
            sessionId={sessionId ?? null}
            phase={composerPhase}
            provider={provider}
            draftMode={draftMode}
            draftConfig={draftConfig}
            usage={composerUsage}
            disabled={disabled}
            activeConfigPicker={activeConfigPicker}
            onConfigPickerOpenChange={handleConfigPickerOpenChange}
            onSelectModel={handleSelectModelTrace}
            onSelectThought={onSelectThought}
            onSwitchMode={onSwitchMode}
            onRecoverCustomModelSelection={onRecoverCustomModelSelection}
            onSendCompressionCommand={onSendCompressionCommand}
          />
        </span>
        {showStopControl ? (
          <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
            <Button
              type="button"
              variant="secondary"
              size="icon-md"
              onClick={handleStopClick}
              data-testid={TID_V4_STOP}
              aria-label={stopTooltipTitle}
            >
              <SquareIcon className="size-4 fill-current" />
              <span className="sr-only">{stopTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip
            title={resolvedSendTooltipTitle}
            shortcut={resolvedSendTooltipShortcut}
            open={Boolean(modifierTooltip) || sendTooltipOpen}
            onOpenChange={setSendTooltipOpen}
          >
            <Button
              type="submit"
              size="icon-md"
              disabled={!canSend}
              onClick={handleSendButtonClick}
              data-testid={TID_V4_COMPOSER_SEND}
              aria-label={resolvedSendTooltipTitle}
              className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // 左下：模式选择 + CUA 入口 + 当前 session 后台任务入口。followupMode 由 app 设置页同步到 CLI，
  // 不在 composer 暴露局部开关；后台入口只消费同一 snapshot，不维护第二份任务状态。
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
        />
        {/* 附件画廊重构曾整段覆盖 leadingActions，误删 CUA 常驻入口。
            入口自身继续负责平台、远程与设置可见性，不在 composer 重复判定。 */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          currentSessionBusy={canStop}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={snapshot?.backgroundWorks ?? []}
          runningSubagentCount={runningSubagentCount}
          onOpen={onOpenRunningBackgroundWorks}
          openTarget={backgroundWorkOpenTarget}
        />
      </>
    ),
    [
      activeConfigPicker,
      canStop,
      disabled,
      draftConfig,
      handleConfigPickerOpenChange,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const isBlockedByInteraction = blockingRequestId !== null;

  // v4 pendingInteractions 是 bottom dock 阻塞态；composer 必须保留挂载，
  // 只在视觉和可访问树中隐藏，避免权限/问答卡片出现时丢失草稿和编辑器内部状态。
  return (
    // 外层 bottom dock 负责 sticky 与横向主列宽度；composer 自身组织错误提示与输入壳。
    // centered（居中草稿布局，m5）：收窄 max-w-2xl（旧
    // getChatViewComposerWidthClassName 的 draft 档），由宿主的居中容器摆位。
    // 有 contextHeader（草稿态）时，内层输入 surface 套旧 ChatViewComposer 同款卡：
    // rounded-2xl bg-surface shadow-xl/5；会话态回落不透明页面底色。
    // 错误横幅虽然排在 contextHeader 前面，但不能与输入区共用同一个圆角 surface，
    // 视觉上会被误认为输入卡标题栏；将 surface 边界收窄到工作区头和编辑器后，桌面与手机
    // Web 仍共享同一 DOM 顺序，同时恢复错误提示与输入卡之间的独立层级。
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* 旧 ChatViewComposer 同款隐藏 file input（web/无 native picker 平台回退）。 */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // 仅展示附件错误会漏掉会话级 lastError，任务失败后也应在输入框上方显示原因。
        // 这里复用旧 ChatErrorBanner 壳，只接收 SessionPane 已归一化后的当前错误。
        // 错误横幅独立于输入 surface，并先于桌面和手机共用的 contextHeader。
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            onDismiss={onDismissError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
          />
        </div>
      ) : null}
      <div
        className={cn(
          "chat-composer-input-surface w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
        )}
      >
        {contextHeader ? (
          // 旧 ChatViewComposer contextHeaderContent 同款包装（workspace 菜单 + Git 分支）。
          <div className="p-1.5 flex min-w-0 flex-wrap items-center gap-0">{contextHeader}</div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={placeholder}
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={pending || !routingAllowsSend || !attachmentsReady || !submissionReady}
          allowSubmitWhenEmpty={
            // 发送按钮已把代码评论视为可发送上下文，但这里曾漏掉同一状态，
            // 导致空文本仅附代码评论时 Enter 被编辑器判为空，必须改点发送按钮。
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ 是 Plugin / 文件 / 对话 / 画板主入口；# 会话与 $ / ¥ / ￥ Skills
          // 仍由 MentionPlugin 保留兼容触发，但不在 + 菜单重复展示。
          showMentionButton
          topContent={topContentNode}
          attachmentAction={attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          // 命令目录必须完整来自 CLI workspace slash catalog；UI 只在
          // secondary pane 按产品能力隐藏 goal，不再追加任何内建命令或别名。
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={appSlashCommands}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          className="p-0"
          onChange={handleEditorChange}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) {
            if (heldQueueConfirmation?.telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(
                heldQueueConfirmation.telemetrySeed.localTtft,
                "cancelled",
              );
            setHeldQueueConfirmation(null);
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                {
                  count: String(heldQueueConfirmation?.queueItemIds.length ?? 0),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ConversationComposer = memo(ConversationComposerImpl);
