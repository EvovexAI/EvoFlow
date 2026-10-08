// V4 会话数据层的传输接缝（依赖注入）。
// desktop 走 preload/MessagePort，web 走 ws relay——数据层对两者零感知，
// 这是「依赖注入解决 desktop/web 兼容」原则在 v4 数据层的落点。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationRowTarget,
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
  SubscribeParams,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  ConversationResyncParams,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

/**
 * 一条 host 连接上的 v4 conversation 传输面。
 * 跨 workspace 分屏 = UI shell 持 Map<workspaceKey, ConversationTransport>，
 * 每条连接各配一个 SessionDataLayer。
 */
export interface ConversationTransport {
  /** v4/conversation/subscribe。connectionId 由传输实现补齐，不进 UI 层。 */
  subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult>;
  /** store 写入 ACK subscriptionId 后激活，并按原序释放 ACK 前 notification。 */
  activate(subscriptionId: string): void;
  /** 活跃订阅 same-sub recovery；topic/connection/profile 由 host owned registry 反查。 */
  resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  /** v4/conversation/unsubscribe。 */
  unsubscribe(subscriptionId: string): Promise<void>;
  /** v4/command。 */
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  /** v4/commands/query：重连后按 commandId 与 CLI 权威事实对账。 */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult>;
  /** v4/conversation/rowsRange（loadOlder）：按游标向上取一窗历史行。 */
  rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  /** v4/conversation/plans：当前有效分支里的全部终态计划。 */
  plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult>;
  /** v4/conversation/workflowRunEvents：workflow run 的事件日志分页（cursor = journal sequence）。 */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** v4/conversation/workflowRuns：workflow run 枚举（journal-backed 的重启后发现面）。 */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * v4/conversation/workflowRunArtifacts：workflow run 的**用户面产物**清单（冷恢复的 durable 读法）。
   *
   * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出（文件 / markdown / 预置看板），
   * 不是 run 的顶层返回值。
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** v4/conversation/workflowRunArtifactData：预置看板的条目分页（cursor = journal sequence）。 */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** v4/conversation/workflowRunArtifactRead：内容产物的字节，一次一块（≤ 512 KiB）。 */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /**
   * v4/conversation/workflowRunWorkspace：workflow run 的脚本 transcript 清单
   * （files.* / git.* / world.run 的 journal 行，不带正文）。
   */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** v4/conversation/workflowRunNodeResult：一个工作区节点的有界正文（展开时才取）。 */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** v4/conversation/fileChanges：按 turn row 展开文件摘要详情与只读 diff。 */
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  /** v4/conversation/fileRewindPreview：按 turn row 预览 workspace-only 文件撤销。 */
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** UI 高层附件上传；production wire 为 begin/chunk/commit/abort。 */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  /** 已发送 image/video 高层读取；Desktop 本地视频可返回已授权 URL，其余循环小块。 */
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /** 已发送 PDF 的授权 range 读取；不会把完整文件先读入 renderer。 */
  attachmentReadRange(
    params: ConversationAttachmentReadParams & { offset: number; limit: number },
  ): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    totalBytes: number;
    nextOffset: number | null;
  }>;
  /** 注册下行帧监听（v4/conversation/frame），返回解除函数。 */
  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void;
  /** physical assembly 原子失败；projection 保持不变，由 store 发起 single-flight resync。 */
  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void;
  /** CLI runtime 或承载 proxy 换代；transport 已先清 ownership/barrier/assembler。 */
  onRuntimeRestart(listener: (reason?: "runtimeRestart" | "transportReplaced") => void): () => void;
  /**
   * CLI runtime 存活态。unavailable 在 workspace-dispose 当场到达（此时新 runtime 尚不存在，
   * 不可重订阅）；available 在新进程 spawn 时到达，与 onRuntimeRestart 同刻同义。
   *
   * onRuntimeRestart 只在新进程 spawn 时才发，而 agent 是懒启动——CUA Helper 就绪
   * 触发 dispose 后没人拉起 agent，换代通知因此永不到达，草稿预热会话不重建、附件卡在
   * waitingSession，直到用户手动点一次发送才被踹活。dispose 当场可观测的只有本事件。
   *
   * 消费方按 sessionsIndexStore 的既定模式二选一订阅（有本方法就不订阅 onRuntimeRestart），
   * 避免同一次换代被两条通道各处理一次。承载方未暴露 runtime lifecycle 时本方法不存在。
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

export interface ConversationAttachmentReadParams {
  sessionId: string;
  ref: string;
  /** 仅用于决定是否查询 Desktop local video source；最终 MIME 仍由 CLI 权威返回。 */
  mediaType?: string;
  /** 新 row 有稳定 identity；旧 snapshot 缺失时保持 ref-only 兼容。 */
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  /** Dialog 关闭、切换或卸载时停止后续分块请求。 */
  signal?: AbortSignal;
}

/** conversation topic key（与 CLI 侧 parseConversationTopic 对偶），从协议包再导出。 */
export { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
