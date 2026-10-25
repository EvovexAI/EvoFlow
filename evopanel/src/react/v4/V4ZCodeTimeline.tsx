// V4ZCodeTimeline — 【产品默认聊天渲染面】ZCode ConversationTimeline 宿主装配。
//
// 修「对话里看见什么 / 工具卡 / 轮尾卡 / 侧栏由哪行触发」→ 从这里下钻到
// `zcode-ui/v4/ConversationTurnGroup` 等，不要改旧版 ToolCallList。
//
// 行视图 / 轮分组 / Streamdown / 虚拟化 / 贴底跟随来自 zcode-ui；本文件只做：
// - 数据：V4StreamRowsBridge 原生快照；
// - 上下文：ZCodeIntlProvider + ConversationRowRenderContext；
// - 布局：`@container/conversation` + sticky bottomDock；
// - 分页：canLoadOlder/onLoadOlder。
// connecting 时空态不回落老链路。编辑/重试/fork/反馈 v1 只读投影。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "@/styles-bridge.css";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { ServiceProvider } from "@zcode/ui/hooks/useServices.js";
import { PlatformProvider } from "@zcode/ui/hooks/usePlatform.js";
import { MarkdownTableVariantProvider } from "@zcode/ui/components/ai-elements/markdownTableVariant.js";
import { AssistantCodeCommentFeatureProvider } from "@zcode/ui/AssistantCodeCommentFeatureProvider.js";
import { TooltipProvider } from "@zcode/ui/components/ui/tooltip.js";
import { ConversationTimeline } from "@zcode/ui/v4/ConversationTimeline.js";
import { V4DraftEmptyState } from "./V4DraftEmptyState.js";
import { hasOlderRows } from "@zcode/ui/v4/conversationProjectionStore.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
} from "@zcode/ui/v4/assistantPreviewPptxAutoOpen.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@zcode/ui/lib/assistantPreviewCards.js";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@zcode/ui/components/ai-elements/message.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zcode/ui/lib/codePreviewSettings.js";
import { getPathLeaf } from "@zcode/ui/lib/path.js";
import { logStreamCompareV4PanelDisplay } from "../lib/stream-compare-file-log.js";
import type { IServiceAccessor } from "@zcode/services";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { V4TimelinePayload } from "./V4StreamRowsBridge.js";
import type { ConversationRowRenderContext } from "@zcode/ui/v4/conversationRowContext.js";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";
import { mergeOptimisticUserInputRow } from "./optimisticUserInput.js";
import { V4QueuePanelBridge } from "./V4QueuePanelBridge.js";
import { evoflowStubPlatform } from "../../pages/settings/evoflow-bridge-services.js";
import {
  ToolApprovalPanel,
  type ToolApprovalChoice,
} from "../components/ToolApprovalPanel.js";

/**
 * V4 行内授权何时展示（对齐旧链路 isToolPendingApproval + resolvedIds）：
 * 1. 会话策略关闭授权 UI（grant_all）→ 不展示
 * 2. 本会话已点过批准/拒绝的 toolCallId → 乐观消隐（防重复）
 * 3. 已真正开跑/失败：running / error / cancelled → 不展示
 * 4. status===pendingApproval → 展示
 * 5. 信封 _evoflow_tool.status===pending_approval → 展示（含 status 被误标 success 的镜像滞后；
 *    不要用「success 一律不弹」盖掉尚未审批的当前卡）
 * 6. 信封已是 approved/denied/ok 等 → 不展示
 */
const V4_TOOL_STATUS_EXECUTING_OR_DONE = new Set(["running", "error", "cancelled"]);

/** connecting 态共用，避免 `?? []` 每帧新引用。 */
const EMPTY_V4_ROWS: NonNullable<ConversationSnapshot["rows"]["window"]> = [];

/**
 * 部分服务访问器：fileService / mediaPreviewService 全部走 EvoFlow 沙箱文件通道
 * （GET /api/workspaces/serve-file，按当前会话 thread 解析相对路径）。
 * PreviewPane 需要 fileService.stat / readTextFile / readFileRange /
 * readMediaPreview / readBinaryPreview（Office）、fileWatcherService（PPTX 热刷新，
 * Web 上为 no-op）与 mediaPreviewService.prepare —— ZCode 桌面端是 host RPC，
 * 这里用 HTTP Range / 整档 fetch 等价实现。
 * 挂进 ServiceProvider 后 useWorkspaceServices 返回本访问器。
 * 右侧 PreviewPane（V4PreviewPane）复用同一访问器。
 */
/** 对齐 ZCode fileService：Office 预览硬上限 25MB（ZIP/OLE 需整档）。 */
const EVO_BINARY_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

export function createEvoflowPartialServices(sessionId: string): IServiceAccessor {
  const serveFileUrl = (path: string): string => {
    const q = new URLSearchParams({ path });
    if (sessionId) q.set("thread_id", sessionId);
    return `/api/workspaces/serve-file?${q.toString()}`;
  };
  // IFileService.stat({ path }) —— PreviewPane 传对象；兼容误传裸字符串。
  // Range 探测：从 Content-Range 取总大小；服务端不支持 Range 时退 blob.size。
  const resolveStatPath = (input: string | { path?: string } | null | undefined): string => {
    if (typeof input === "string") return input.trim();
    if (input && typeof input === "object" && typeof input.path === "string") {
      return input.path.trim();
    }
    return "";
  };
  const statFile = async (
    input: string | { path?: string },
  ): Promise<{ path: string; type: "file" | "directory"; size?: number }> => {
    const path = resolveStatPath(input);
    if (!path) throw new Error("file not found: (empty path)");
    const resp = await fetch(serveFileUrl(path), { headers: { Range: "bytes=0-0" } });
    if (resp.status === 404) throw new Error(`file not found: ${path}`);
    if (!resp.ok) throw new Error(`stat failed: HTTP ${resp.status}`);
    const contentRange = resp.headers.get("content-range");
    if (resp.status === 206 && contentRange) {
      const total = Number.parseInt(contentRange.split("/")[1] ?? "", 10);
      if (Number.isFinite(total)) return { path, type: "file", size: total };
    }
    const blob = await resp.blob();
    return { path, type: "file", size: blob.size };
  };
  // Range 读块；200（无 Range 支持）时整档读回后切片。
  const readFileRange = async (params: { path: string; offset: number; length: number }): Promise<Uint8Array> => {
    const { path, offset, length } = params;
    const end = Math.max(offset, offset + Math.max(length, 1) - 1);
    const resp = await fetch(serveFileUrl(path), { headers: { Range: `bytes=${offset}-${end}` } });
    if (resp.status === 404) throw new Error(`file not found: ${path}`);
    // 416：offset 已越界（文件被截断/竞态），按空块返回交给上层判完整性。
    if (resp.status === 416) return new Uint8Array(0);
    if (!resp.ok) throw new Error(`read failed: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (resp.status === 206) return new Uint8Array(buf);
    const whole = new Uint8Array(buf);
    return whole.slice(offset, offset + length);
  };
  const blobToBase64 = async (blob: Blob): Promise<string> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("binary read failed"));
      reader.readAsDataURL(blob);
    });
    return dataUrl.split(",")[1] ?? "";
  };
  const readMediaPreview = async (params: { path: string; maxBytes?: number }) => {
    const resp = await fetch(serveFileUrl(params.path));
    if (resp.status === 404) throw new Error(`file not found: ${params.path}`);
    if (!resp.ok) throw new Error(`media preview failed: HTTP ${resp.status}`);
    const blob = await resp.blob();
    return {
      path: params.path,
      mediaType: blob.type || "application/octet-stream",
      dataBase64: await blobToBase64(blob),
      totalBytes: blob.size,
    };
  };
  // Office 解析器要完整 ZIP/OLE 字节，不能复用文本分块；先做 25MB 上限再整档 base64。
  const readBinaryPreview = async (params: { path: string; maxBytes?: number }) => {
    const maxBytes = Math.min(
      Math.max(1, Math.trunc(params.maxBytes ?? EVO_BINARY_PREVIEW_MAX_BYTES)),
      EVO_BINARY_PREVIEW_MAX_BYTES,
    );
    const path = String(params.path || "").trim();
    const stat = await statFile({ path });
    const size = typeof stat.size === "number" ? stat.size : undefined;
    if (size != null && size > maxBytes) {
      throw new Error(`File is too large to preview: ${path}`);
    }
    const resp = await fetch(serveFileUrl(path));
    if (resp.status === 404) throw new Error(`file not found: ${path}`);
    if (!resp.ok) throw new Error(`binary preview failed: HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (blob.size > maxBytes) {
      throw new Error(`File is too large to preview: ${path}`);
    }
    return {
      path,
      dataBase64: await blobToBase64(blob),
      totalBytes: blob.size,
    };
  };
  return {
    fileService: {
      async checkFilesExist(params: { paths: string[] }) {
        const results = await Promise.all(
          (params?.paths ?? []).map(async (p) => {
            try {
              const q = new URLSearchParams({ path: p });
              if (sessionId) q.set("thread_id", sessionId);
              const resp = await fetch(`/api/workspaces/resolve-target?${q.toString()}`);
              if (!resp.ok) return { path: p, exists: false };
              const data = (await resp.json()) as { exists?: boolean; is_dir?: boolean };
              return { path: p, exists: Boolean(data.exists) && !data.is_dir };
            } catch {
              return { path: p, exists: false };
            }
          }),
        );
        return results;
      },
      // PreviewPane 调 fileService.stat({ path })，必须吃对象形参。
      async stat(params: { path: string }) {
        return statFile(params);
      },
      readFileRange,
      readMediaPreview,
      readBinaryPreview,
      async readTextFile(params: { path: string; offset: number; length: number }) {
        const bytes = await readFileRange(params);
        // NUL 字节启发式判二进制（UTF-8 合法文本不会含 NUL）。
        let isBinary = false;
        for (let i = 0; i < bytes.length; i += 1) {
          if (bytes[i] === 0) {
            isBinary = true;
            break;
          }
        }
        const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const stat = await statFile({ path: params.path });
        const totalBytes = stat.size ?? params.offset + bytes.length;
        return {
          path: params.path,
          content,
          offset: params.offset,
          bytesRead: bytes.length,
          totalBytes,
          truncated: params.offset + bytes.length < totalBytes,
          isBinary,
        };
      },
    },
    mediaPreviewService: {
      // 直接给 serve-file 原始 URL：video/audio 走流式播放（FileResponse 支持 Range）。
      async prepare(params: { path: string; expectedKind?: string }) {
        return { url: serveFileUrl(params.path) };
      },
      async release() {},
    },
    // Web/EvoFlow 无本机 fs.watch：no-op。
    // onDynamicChange(id) 返回「订阅函数」，订阅后再返回 disposable（ZCode Event 形态）。
    fileWatcherService: {
      async watch() {
        return { id: `evo-noop-${Date.now()}` };
      },
      async unwatch() {},
      disposeAll() {},
      onDynamicChange(_id: string) {
        return (_listener: (event: unknown) => void) => ({ dispose() {} });
      },
    },
    async readMediaPreview(params: { path: string; maxBytes?: number }) {
      return readMediaPreview(params);
    },
  } as unknown as IServiceAccessor;
}

export function V4ZCodeTimeline(props: {
  payload: V4TimelinePayload | null;
  /** 已有 threadId 但快照未到（订阅/构建中），或 store failed 占位。 */
  connecting?: boolean;
  /** 投影 store 已 error 且无快照：留在 V4 显示失败态，不回落老面板。 */
  connectionFailed?: boolean;
  /** EvoFlow 会话 key：stream-compare 落盘目录名（与 sse/v4-recv 同轮对账）。 */
  evoflowSessionKey?: string | null;
  /**
   * 窄栏嵌入（小V）：composer 在面板外，禁用空态居中；sessionKey 用 evoflow key 保持稳定，
   * 避免 threadId 从无到有时 timeline 整树 remount 抖动；并隐藏左侧 turn navigator
   * （窄栏空间不够，选历史轮次对小V 多余）。
   */
  embedded?: boolean;
  /**
   * 草稿态（新对话：会话已建但 threadId/首帧快照未到，或刚清空待创建）。
   * 必须让空态与 composer 一起居中，否则点击「+」到 V4 挂载之间输入框会先贴在底部、
   * 再跳到中间。草稿问候语也由本组件提供，不依赖 ZCode 会话壳。
   */
  draftEmpty?: boolean;
  /**
   * 发送瞬间本地已有用户气泡、V4 投影尚未 echo：在窗口尾部补一行合成 userInput，
   * 保持挂在 ConversationTimeline，避免切老面板闪历史。
   */
  optimisticUserText?: string | null;
  /**
   * EvoFlow 底部输入区：作为 ConversationTimeline sticky bottomDock 挂进同一滚动视口
   * （对齐 ZCode SessionPane），避免 messages 区单独滚动、下方空出「留给输入框」的空白。
   */
  bottomDock?: ReactNode;
  /** 工具卡/文件 chip 点击 → EvoFlow 右侧面板文件预览（ZCode CodeViewerSource 语义）。 */
  onOpenCodeViewer?: (source: import("@zcode/ui/lib/codeViewer.js").CodeViewerSource) => void;
  /**
   * Markdown 文件链接点击。未传时回落到 onOpenCodeViewer（type:file），
   * 保证正文里的路径 pill 与工具卡走同一右栏，而不是全屏 modal。
   */
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  /** 复用老授权模块：onToolApprovalStable（approve/deny → wsClient.postToolApproval，
   * 批准后的执行结果经镜像回流成 V4 行）。 */
  onToolApproval?: (
    action: "approve" | "approve_all" | "deny" | "grant_all" | "approve_remember",
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void;
  /** 会话策略已 grant_all / 关闭授权 UI 时不展示行内审批（对齐 toolApprovalUiDisabled）。 */
  toolApprovalUiDisabled?: boolean;
  /** 会话工作区根（绝对路径）：文件 chip/摘要/diff 的路径相对化全依赖它——
   * 传空会让绝对 Windows 路径解析退化（文件名显示成盘符 "D"）。 */
  workspacePath?: string;
  /** 平台子代理任务（threadPanelState.subagentTasks 同源）：keyed by tool_call_id/task_id。 */
  subagentTasks?: Record<string, unknown>;
  /** 点击子代理条目 → 右侧面板查看流式输出全量（transcript 轮询）。 */
  onOpenSubagentTranscript?: (
    taskId: string,
    title: string,
    fallbackText?: string,
    fallbackStatus?: string,
  ) => void;
  /**
   * 对话中自动触发（对齐 ZCode SessionPane onAutoOpenAssistantPptx）：
   * 轮次 running→completedSuccess 边沿 + 预览卡 stat 校验通过后，由
   * AssistantPreviewCards 发起的批量自动打开（pptx 等产物）。
   * 宿主负责逐个 show 进右侧面板并激活第一张。
   */
  onAutoOpenCodeViewers?: (sources: readonly CodeViewerSource[]) => void;
}): React.JSX.Element {
  const {
    payload,
    connecting,
    connectionFailed = false,
    bottomDock,
    evoflowSessionKey,
    embedded = false,
    draftEmpty = false,
    optimisticUserText = null,
    onOpenCodeViewer,
    onOpenFileLink: onOpenFileLinkProp,
    onToolApproval,
    toolApprovalUiDisabled = false,
    workspacePath,
    subagentTasks,
    onOpenSubagentTranscript,
    onAutoOpenCodeViewers,
  } = props;

  // Markdown 路径 pill：优先 onOpenFileLink（宿主应打开右侧「文件」区）；
  // 未传时回落 onOpenCodeViewer(type:file)——宿主 openRightStageForCodeViewerSource 会再分流到 file。
  const onOpenFileLink = useCallback(
    (target: MessageFileLinkTarget) => {
      if (onOpenFileLinkProp) {
        onOpenFileLinkProp(target);
        return;
      }
      if (!onOpenCodeViewer) return;
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(target.path) || target.label || "文件",
        path: target.path,
        ...(target.workspacePath ? { workspacePath: target.workspacePath } : {}),
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        ...(target.workspaceRemoteSessionId
          ? { workspaceRemoteSessionId: target.workspaceRemoteSessionId }
          : {}),
      });
    },
    [onOpenFileLinkProp, onOpenCodeViewer],
  );
  const sessionId = payload?.sessionId ?? "";
  const snapshot: ConversationSnapshot | null = payload?.snapshot ?? null;

  // 宿主保证引用稳定（ConversationRowView/MessageResponse 的 memo 依赖 context 引用）。
  // fetchFileChanges 闭包经 ref 读最新快照水位；待授权列表变时才允许 rowContext 换引用。
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // 访问器按 session 建（thread_id 沙箱解析），会话切换即重建。
  const partialServices = useMemo(
    () => createEvoflowPartialServices(sessionId),
    [sessionId],
  );

  // connecting / 无快照时必须用稳定空数组，否则每 render 新 [] 会让
  // ConversationTimeline 依赖 rows 的 layout effect 空转（叠侧栏开合易触发 #185）。
  const authoritativeRows = snapshot?.rows.window ?? EMPTY_V4_ROWS;
  const rows = useMemo(
    () => mergeOptimisticUserInputRow(authoritativeRows, optimisticUserText),
    [authoritativeRows, optimisticUserText],
  );
  const optimisticRowInjected = rows.length > authoritativeRows.length;
  const displayTotalCount =
    (snapshot?.rows.totalCount ?? authoritativeRows.length) + (optimisticRowInjected ? 1 : 0);

  type PendingApprovalItem = {
    toolCallId: string;
    toolName: string;
    summary: string;
    risk: string;
    title: string;
    args?: Record<string, unknown>;
  };

  // 本会话已点过的 toolCallId（对齐 toolApprovalResolvedIdsRef）；切会话清空。
  const resolvedIdsRef = useRef<Set<string>>(new Set());
  const [resolvedTick, setResolvedTick] = useState(0);
  const resolvedScopeKey = String(evoflowSessionKey || sessionId || "").trim();
  useEffect(() => {
    resolvedIdsRef.current = new Set();
    setResolvedTick((n) => n + 1);
  }, [resolvedScopeKey]);

  // ---- 对话中自动触发（pptx 等产物预览）——对齐 ZCode SessionPane 的
  // assistantPreviewPptxAutoOpenTarget gate：running 边沿武装；completedSuccess
  // 且终态 assistant row 到齐后发布 target，ConversationTurnGroup 命中该轮时
  // AssistantPreviewCards 携 stat 校验后的 sources 发起批量打开；key 去重防重弹。
  const autoOpenedPptxKeysRef = useRef<Set<string>>(new Set());
  const pptxAutoOpenGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] = useState<{
    turnId: string;
    key: string;
  } | null>(null);
  useEffect(() => {
    autoOpenedPptxKeysRef.current = new Set();
  }, [resolvedScopeKey]);
  const onAutoOpenCodeViewersRef = useRef(onAutoOpenCodeViewers);
  onAutoOpenCodeViewersRef.current = onAutoOpenCodeViewers;
  useEffect(() => {
    const enabled = Boolean(onAutoOpenCodeViewers && sessionId && snapshot);
    const result = advanceAssistantPreviewPptxAutoOpenGate(pptxAutoOpenGateRef.current, {
      enabled,
      scopeKey: resolvedScopeKey || sessionId || "draft",
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(rows),
    });
    pptxAutoOpenGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    onAutoOpenCodeViewers,
    resolvedScopeKey,
    sessionId,
    snapshot,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    rows,
  ]);
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!request.sources.length) return;
      if (autoOpenedPptxKeysRef.current.has(request.key)) return;
      autoOpenedPptxKeysRef.current.add(request.key);
      onAutoOpenCodeViewersRef.current?.(request.sources);
    },
    [],
  );

  // 待审批：未点过 + 未开跑/失败 +（pendingApproval 或信封 pending）。
  const pendingApprovals = useMemo(() => {
    if (toolApprovalUiDisabled) return [] as PendingApprovalItem[];
    const out: PendingApprovalItem[] = [];
    const resolved = resolvedIdsRef.current;
    for (const row of rows) {
      if (row.kind !== "toolCall") continue;
      const toolCallId = String(row.toolCallId || "").trim();
      if (!toolCallId || resolved.has(toolCallId)) continue;
      // 已开跑/失败：即使信封还留着 pending_approval 也不再交互
      if (V4_TOOL_STATUS_EXECUTING_OR_DONE.has(row.status)) continue;

      let summary = row.inputText || "";
      let risk = "confirm";
      let title = "需要您的授权";
      let envelopePending = false;
      let envelopeSettled = false;
      try {
        const parsed = JSON.parse(row.output?.text || "{}") as {
          approval?: {
            title?: string;
            summary?: string;
            risk?: string;
            tool_name?: string;
          };
          _evoflow_tool?: { status?: string };
        };
        const metaSt = String(parsed._evoflow_tool?.status || "")
          .trim()
          .toLowerCase()
          .replace(/[_-]/g, "");
        if (metaSt === "pendingapproval") envelopePending = true;
        if (
          metaSt === "approved" ||
          metaSt === "denied" ||
          metaSt === "ok" ||
          metaSt === "error" ||
          metaSt === "blocked" ||
          metaSt === "approvedwaiting" ||
          metaSt === "awaitingotherapproval"
        ) {
          envelopeSettled = true;
        }
        if (parsed.approval) {
          title = parsed.approval.title || title;
          risk = parsed.approval.risk || risk;
          if (parsed.approval.summary) summary = parsed.approval.summary;
        }
      } catch {
        // output.text 非 JSON —— 用 inputText 兜底
      }
      if (envelopeSettled) continue;
      // success + 信封仍 pending：镜像曾把 pending_approval 标成 success，必须仍展示
      if (row.status !== "pendingApproval" && !envelopePending) continue;

      let args: Record<string, unknown> | undefined;
      try {
        const parsedArgs = JSON.parse(row.inputText || "null");
        if (parsedArgs && typeof parsedArgs === "object") {
          args = parsedArgs as Record<string, unknown>;
        }
      } catch {
        // 半截参数 —— 省略 args
      }
      out.push({
        toolCallId,
        toolName: row.toolName,
        summary,
        risk,
        title,
        args,
      });
    }
    return out;
    // resolvedTick：用户点选后强制重算，即使 rows 引用未变
  }, [rows, toolApprovalUiDisabled, resolvedTick]);

  const pendingById = useMemo(() => {
    const map = new Map<string, PendingApprovalItem>();
    for (const item of pendingApprovals) map.set(item.toolCallId, item);
    return map;
  }, [pendingApprovals]);


  // 子代理工具行 ↔ 平台子代理任务：与 ToolCallList 的 resolve 同键
  //（toolCallId/taskId/taskExecId/collabSubtaskId）。命中即子代理调用，
  // 底部入口条可点开右侧全量流式输出。
  const subagentTasksRef = useRef(subagentTasks);
  subagentTasksRef.current = subagentTasks;
  const subagentEntries = useMemo(() => {
    const tasks = subagentTasksRef.current;
    if (!tasks || Object.keys(tasks).length === 0) return []
    const resolve = (toolCallId: string): Record<string, unknown> | undefined => {
      const direct = (tasks as Record<string, Record<string, unknown>>)[toolCallId]
      if (direct) return direct
      return Object.values(tasks as Record<string, Record<string, unknown>>).find(
        (t) =>
          String(t?.taskId || "") === toolCallId ||
          String(t?.taskExecId || "") === toolCallId ||
          String(t?.collabSubtaskId || "") === toolCallId,
      )
    }
    const seen = new Set<string>()
    const out: Array<{
      taskId: string
      label: string
      phase: string
      fallbackText?: string
      fallbackStatus?: string
    }> = []
    for (const row of rows) {
      if (row.kind !== "toolCall") continue
      const task = resolve(row.toolCallId)
      if (!task) continue
      const taskId = String(task.taskExecId || task.taskId || row.toolCallId)
      if (seen.has(taskId)) continue
      seen.add(taskId)
      out.push({
        taskId,
        label: String(task.subagentType || task.description || row.toolName || "子代理"),
        phase: String(task.phase || "running"),
        fallbackText: String(task.liveOutput || task.progressHint || ""),
        fallbackStatus: String(task.phase || "running"),
      })
    }
    return out
  // rows 引用随快照帧变化——条目列表按帧重算（数组小，成本可忽略）
  }, [rows]);
  const subagentEntriesRef = useRef(subagentEntries);
  subagentEntriesRef.current = subagentEntries;
  const onOpenSubagentTranscriptRef = useRef(onOpenSubagentTranscript);
  onOpenSubagentTranscriptRef.current = onOpenSubagentTranscript;

  const markResolved = useCallback((ids: string[]) => {
    let changed = false;
    for (const id of ids) {
      const k = String(id || "").trim();
      if (!k || resolvedIdsRef.current.has(k)) continue;
      resolvedIdsRef.current.add(k);
      changed = true;
    }
    if (changed) setResolvedTick((n) => n + 1);
  }, []);

  const onApprovalChoice = useCallback(
    (item: PendingApprovalItem, choice: ToolApprovalChoice) => {
      const hint = {
        tool_name: item.toolName,
        summary: item.summary,
        args: item.args,
      };
      // 乐观消隐：API 回灌前立刻从行内摘掉，避免重复点选 / 下一帧再弹
      if (choice === "full_access") {
        markResolved(pendingApprovals.map((p) => p.toolCallId));
      } else {
        markResolved([item.toolCallId]);
      }
      if (choice === "deny") {
        onToolApproval?.("deny", item.toolCallId, hint);
        return;
      }
      if (choice === "full_access") {
        onToolApproval?.("grant_all", item.toolCallId, hint);
        return;
      }
      if (choice === "always_project") {
        onToolApproval?.("approve_remember", item.toolCallId, hint);
        return;
      }
      onToolApproval?.("approve", item.toolCallId, hint);
    },
    [onToolApproval, markResolved, pendingApprovals],
  );

  // 审批/拉文件详情都经 ref 读最新值，回调身份保持稳定——否则每帧 SSE
  // 都会换新的 rowContext，ConversationTimeline 整树 memo 失效 → 对话区闪烁。
  const pendingByIdRef = useRef(pendingById);
  pendingByIdRef.current = pendingById;
  const onApprovalChoiceRef = useRef(onApprovalChoice);
  onApprovalChoiceRef.current = onApprovalChoice;

  // Agent/Task 工具卡「在右侧打开」：toolCallId → subagentTasks 联出任务身份后
  // 打开右侧 transcript 面板（transcript API 轮询 + liveOutput 兜底）。
  // 与 subagentEntries 同一套解析键（taskId/taskExecId/collabSubtaskId/toolCallId）。
  const onOpenSubagentToolCall = useCallback(
    (toolCallId: string) => {
      const open = onOpenSubagentTranscriptRef.current;
      if (!open) return
      const tasks = subagentTasksRef.current
      let entry: Record<string, unknown> | undefined
      if (tasks && Object.keys(tasks).length > 0) {
        entry = (tasks as Record<string, Record<string, unknown>>)[toolCallId]
        if (!entry) {
          entry = Object.values(tasks as Record<string, Record<string, unknown>>).find(
            (t) =>
              String(t?.taskId || '') === toolCallId ||
              String(t?.taskExecId || '') === toolCallId ||
              String(t?.collabSubtaskId || '') === toolCallId,
          )
        }
      }
      // 无流事件命中（刷新后/跨进程）时用 toolCallId 本身查 transcript API：
      // 普通子代理的 task_id 就是 tool_call_id，终态快照通常仍可取到。
      const taskId = String(
        entry?.taskExecId || entry?.taskId || toolCallId,
      ).trim()
      const label = String(
        entry?.subagentType || entry?.description || '子代理',
      ).trim()
      open(
        taskId,
        label,
        String(entry?.liveOutput || entry?.progressHint || ''),
        String(entry?.phase || 'running'),
      )
    },
    [],
  );
  const onOpenSubagentToolCallRef = useRef(onOpenSubagentToolCall);
  onOpenSubagentToolCallRef.current = onOpenSubagentToolCall;

  const renderToolCallApproval = useCallback((toolCallId: string) => {
    const item = pendingByIdRef.current.get(toolCallId);
    if (!item) return null;
    return (
      <div className="msg-tool-approval-inline" data-tool-call-id={toolCallId}>
        <ToolApprovalPanel
          toolName={item.toolName}
          summary={item.summary}
          autoFocus
          onConfirm={(choice) => onApprovalChoiceRef.current(item, choice)}
        />
      </div>
    );
  }, []);

  const fetchFileChanges = useCallback(
    async (
      target: { rowId: number; entityId: string },
      _options?: { cachePolicy?: string; fileChangesState?: string },
    ) => {
      if (!sessionId) throw new Error("v4 session not ready");
      const snap = snapshotRef.current;
      if (!snap) throw new Error("v4 snapshot not ready");
      return await getEvoflowV4Transport().fileChanges({
        sessionId,
        target,
        baseRevision: snap.seq,
        baseLogEpoch: snap.logEpoch,
      });
    },
    [sessionId],
  );

  // 队列面板：bottomDock 内 composer 之上（对齐 SessionPane 布局）。
  // queue 引用只在 queue patch 到达时变化（键级整体替换），memo 不跟流式帧抖动。
  const queueState = snapshot?.queue ?? null;
  const dockWithQueue = useMemo(() => {
    if (!sessionId || !queueState || queueState.items.length === 0) return bottomDock;
    return (
      <>
        <V4QueuePanelBridge
          sessionId={sessionId}
          queue={queueState}
          revision={snapshot?.revision ?? 0}
        />
        {bottomDock}
      </>
    );
  }, [sessionId, queueState, snapshot?.revision, bottomDock]);

  // 审批列表变化时强制相关工具行重绘（rowContext 本身保持稳定，靠 tick 推一次）
  const approvalRenderKey = pendingApprovals.map((p) => p.toolCallId).join(",");

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath: workspacePath ?? "",
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId: sessionId || null,
      onOpenCodeViewer,
      // 与 onOpenCodeViewer 一并注入：正文 Markdown 路径 pill / Preview Card 共用右栏。
      onOpenFileLink: onOpenCodeViewer || onOpenFileLinkProp ? onOpenFileLink : undefined,
      fetchFileChanges: sessionId ? fetchFileChanges : undefined,
      // 贴在对应 bash/工具卡下方，不用底部浮层
      renderToolCallApproval,
      // Agent/Task 工具卡摘要行「在右侧打开」入口 → 右侧子代理实时输出面板。
      // 经 ref 读最新 prop，保持回调身份稳定（rowContext memo 依赖整树闪烁）。
      onOpenSubagentToolCall: (toolCallId: string) => {
        if (onOpenSubagentTranscriptRef.current) {
          onOpenSubagentToolCallRef.current(toolCallId)
        }
      },
      // 对话中自动触发：预览卡终态批量打开（pptx 等）+ gate target 下发
      onAutoOpenAssistantPptx: onAutoOpenCodeViewers ? handleAutoOpenAssistantPptx : undefined,
      assistantPreviewPptxAutoOpenTarget,
    }),
    // approvalRenderKey：仅在待审批集合变化时换 context，让工具行挂上/摘掉面板；
    // 不跟每帧 rows/snapshot 绑定，避免展开「文件已更改」时整区闪。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: approvalRenderKey gates refresh
    [sessionId, onOpenCodeViewer, onOpenFileLink, onOpenFileLinkProp, fetchFileChanges, renderToolCallApproval, workspacePath, approvalRenderKey, onAutoOpenCodeViewers, handleAutoOpenAssistantPptx, assistantPreviewPptxAutoOpenTarget],
  );

  // stream-compare：页面画什么 → 同轮目录 v4-ui-display.log（排查发送后白屏/无回复）。
  // 依赖 snapshot.seq + totalCount：流式每帧 seq 变就会落盘；sig 去重避免同内容刷盘。
  useEffect(() => {
    logStreamCompareV4PanelDisplay({
      sessionKey: evoflowSessionKey ? String(evoflowSessionKey) : undefined,
      threadId: sessionId || undefined,
      connecting: Boolean(connecting),
      phase: connecting ? "connecting" : snapshot ? "ready" : "no-snapshot",
      rows: rows as ReadonlyArray<Record<string, unknown>>,
      totalCount: snapshot?.rows.totalCount ?? rows.length,
      loadingOlder: payload?.loadingOlder ?? false,
    });
  }, [
    connecting,
    evoflowSessionKey,
    sessionId,
    snapshot?.seq,
    snapshot?.revision,
    snapshot?.rows.totalCount,
    rows,
    payload?.loadingOlder,
  ]);

  // 行数增长不再打 [v4-life] ui_render：首帧/路径切换由 V4StreamRowsBridge 记一次即可。

  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      {/*
        MessageFileLink / useFileContextActions 强依赖 PlatformProvider；
        EvoFlow 无桌面 window.zcode，挂 stub，避免 markdown 整段降级为纯文本。
      */}
      <PlatformProvider platform={evoflowStubPlatform}>
      <MarkdownTableVariantProvider value="evoflow">
      {/*
        ControlHintTooltip（复制等消息动作）默认 standalone=false，依赖祖先 TooltipProvider。
        ZCode Root 有共享 Provider；EvoFlow 只嵌 ConversationTimeline，需在此补一层（同分享只读时间线）。
      */}
      <TooltipProvider delayDuration={0}>
      {/*
        ::code-comment{...} 指令卡片总开关（ZCode desktop 也恒开）：
        ConversationTurnGroup 据此把助手正文里的指令投影成行内代码评审卡
        （流式期间只隐藏指令原文，终态才落卡，卡片点击走 onOpenCodeViewer）。
      */}
      <AssistantCodeCommentFeatureProvider enabled>
      {/*
        对齐 SessionPane 会话壳：
        - zcode-bridge-root：styles-bridge 的 token / 滚动条 / 焦点规则作用域
        - @container/conversation：正文限宽与左侧 turn navigator 的 container query
        - flex min-h-0 flex-1：把 messages-body 的高度约束传给 timeline 滚动层
        - bottomDock：输入区 sticky 在滚动视口底，与正文同轴
      */}
      <div
        className="zcode-bridge-root @container/conversation relative flex h-full min-h-0 flex-1 flex-col"
        data-v4-embedded={embedded ? "true" : undefined}
      >
        <ServiceProvider services={partialServices}>
        <ConversationTimeline
          rows={rows}
          totalCount={displayTotalCount}
          // 嵌入态用 evoflowSessionKey，避免 threadId 晚到时 sessionKey 从 draft→uuid 整树 remount
          sessionKey={
            embedded
              ? String(evoflowSessionKey || sessionId || "draft")
              : sessionId || "draft"
          }
          rowContext={rowContext}
          canLoadOlder={snapshot ? hasOlderRows(snapshot) : false}
          loadingOlder={payload?.loadingOlder ?? false}
          onLoadOlder={payload?.onLoadOlder}
          bottomDock={dockWithQueue}
          // 小V 窄栏：隐藏左侧轮次导航，把宽度留给正文（主对话不变）
          hideTurnNavigator={embedded}
          // 嵌入态 composer 在面板外：空态不要跟不存在的 dock 居中，否则发消息瞬间整栏跳布局。
          // 仅真正的草稿空态（draftEmpty）才居中——对齐 ZCode SessionPane 的 isDraft。
          // 切勿用 rows.length===0：打开有历史会话时 connecting/hydration 期间也会 0 行，
          // 会把输入框误抬到中间，看起来像「空会话」。
          centerEmptyStateWithDock={embedded ? false : draftEmpty}
          emptyState={
            draftEmpty ? (
              <div data-testid="v4-draft-empty" className="w-full">
                <V4DraftEmptyState />
              </div>
            ) : connectionFailed ? (
              <div
                data-testid="v4-connection-failed"
                className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-ui-base text-foreground-subtlest"
                role="alert"
              >
                <span>对话连接失败</span>
                <span className="text-ui-sm">正在自动重试，也可切换会话后重开</span>
              </div>
            ) : connecting ? (
              // 有历史会话也会先 connecting：用安静加载态占位，避免整片空白，
              // 也不要居中草稿问候（draftEmpty 已排除 connecting）。
              <div
                data-testid="v4-connecting"
                className="flex h-full items-center justify-center text-ui-base text-foreground-subtlest"
                aria-busy="true"
                aria-live="polite"
              >
                加载中…
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-ui-base text-foreground-subtlest">
                开始新的对话
              </div>
            )
          }
        />
        </ServiceProvider>
        {subagentEntriesRef.current.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex flex-col items-center gap-1.5 px-4">
            {subagentEntriesRef.current.map((entry) => (
              <button
                key={entry.taskId}
                type="button"
                className="pointer-events-auto flex w-full max-w-2xl items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-left text-xs shadow-md hover:bg-hover"
                onClick={() =>
                  onOpenSubagentTranscriptRef.current?.(
                    entry.taskId,
                    entry.label,
                    entry.fallbackText,
                    entry.fallbackStatus,
                  )
                }
              >
                <span
                  className={
                    "rounded px-1.5 py-0.5 text-[10px] " +
                    (entry.phase === "running"
                      ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")
                  }
                >
                  {entry.phase === "running" ? "执行中" : "已完成"}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{entry.label}</span>
                <span className="shrink-0 text-[10px] text-foreground-subtlest">
                  查看流式输出 →
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      </AssistantCodeCommentFeatureProvider>
      </TooltipProvider>
      </MarkdownTableVariantProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>
  );
}
