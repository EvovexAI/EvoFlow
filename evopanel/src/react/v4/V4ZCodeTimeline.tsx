// V4ZCodeTimeline — V4 显示区域的正式渲染件：ZCode ConversationTimeline 直接挂载。
//
// 行视图 / 轮分组（工具与正文的排布）/ Streamdown 流式渲染 / 虚拟化 / 贴底跟随 /
// 滚动条对齐全部来自 ZCode 显示区域的正式实现（vendor 树 zcode-ui），本文件只做宿主装配：
// - 数据：V4StreamRowsBridge 交付协议原生快照（rows.window 原样，无行适配）；
// - 上下文：ZCodeIntlProvider（裸挂 zh-CN）+ 稳定引用的 ConversationRowRenderContext；
// - 布局：对齐 SessionPane —— `@container/conversation` + sticky `bottomDock`（输入区
//   在同一滚动视口底部，滚轮到底即输入框，不再在消息区下方留一块空白）；
// - 分页：canLoadOlder/onLoadOlder 接 store 的 rows/range（hasOlderRows 判定）。
// connecting 阶段（已订阅、快照未到）空态不渲染提示文案，只保持 V4 渲染不回落老链路。
// 回调类能力（编辑/重试/fork/反馈）v1 不接——显示侧为只读投影。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "@/styles-bridge.css";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { ServiceProvider } from "@zcode/ui/hooks/useServices.js";
import { PlatformProvider } from "@zcode/ui/hooks/usePlatform.js";
import { MarkdownTableVariantProvider } from "@zcode/ui/components/ai-elements/markdownTableVariant.js";
import { ConversationTimeline } from "@zcode/ui/v4/ConversationTimeline.js";
import { ConversationDraftEmptyState as V4DraftEmptyState } from "@zcode/ui/v4/ConversationDraftEmptyState.js";
import { hasOlderRows } from "@zcode/ui/v4/conversationProjectionStore.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zcode/ui/lib/codePreviewSettings.js";
import { logStreamCompareV4PanelDisplay } from "../lib/stream-compare-file-log.js";
import type { IServiceAccessor } from "@zcode/services";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { V4TimelinePayload } from "./V4StreamRowsBridge.js";
import type { ConversationRowRenderContext } from "@zcode/ui/v4/conversationRowContext.js";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";
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
 * 部分服务访问器：只实现 fileService（产物预览卡的文件存在性校验，走
 * GET /api/workspaces/resolve-target，按当前会话 thread 的沙箱工作区解析相对路径）；
 * 其余服务 undefined，由各调用方降级。挂进 ServiceProvider 后
 * useWorkspaceServices 返回本访问器（AssistantPreviewCards 的 stat 校验因此可用）。
 */
function createEvoflowPartialServices(sessionId: string): IServiceAccessor {
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
    },
    async readMediaPreview(params: { path: string; maxBytes?: number }) {
      // serve-file → dataURL（InlineImageContent 消费 {path, mediaType, dataBase64}）
      const q = new URLSearchParams({ path: params.path });
      if (sessionId) q.set("thread_id", sessionId);
      const resp = await fetch(`/api/workspaces/serve-file?${q.toString()}`);
      if (!resp.ok) throw new Error(`media preview failed: HTTP ${resp.status}`);
      const blob = await resp.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("media read failed"));
        reader.readAsDataURL(blob);
      });
      return {
        path: params.path,
        mediaType: blob.type || "application/octet-stream",
        dataBase64: dataUrl.split(",")[1] ?? "",
        totalBytes: blob.size,
      };
    },
  } as unknown as IServiceAccessor;
}

export function V4ZCodeTimeline(props: {
  payload: V4TimelinePayload | null;
  /** 已有 threadId 但快照未到（订阅/构建中）。 */
  connecting?: boolean;
  /** EvoFlow 会话 key：stream-compare 落盘目录名（与 sse/v4-recv 同轮对账）。 */
  evoflowSessionKey?: string | null;
  /**
   * 窄栏嵌入（小V）：composer 在面板外，禁用空态居中；sessionKey 用 evoflow key 保持稳定，
   * 避免 threadId 从无到有时 timeline 整树 remount 抖动；并露出左侧 turn navigator。
   */
  embedded?: boolean;
  /**
   * 草稿态（新对话：会话已建但 threadId/首帧快照未到，或刚清空待创建）。
   * 必须让空态与 composer 一起居中，否则点击「+」到 V4 挂载之间输入框会先贴在底部、
   * 再跳到中间。草稿问候语也由本组件提供，不依赖 ZCode 会话壳。
   */
  draftEmpty?: boolean;
  /**
   * EvoFlow 底部输入区：作为 ConversationTimeline sticky bottomDock 挂进同一滚动视口
   * （对齐 ZCode SessionPane），避免 messages 区单独滚动、下方空出「留给输入框」的空白。
   */
  bottomDock?: ReactNode;
  /** 工具卡/文件 chip 点击 → EvoFlow 右侧面板文件预览（ZCode CodeViewerSource 语义）。 */
  onOpenCodeViewer?: (source: import("@zcode/ui/lib/codeViewer.js").CodeViewerSource) => void;
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
}): React.JSX.Element {
  const {
    payload,
    connecting,
    bottomDock,
    evoflowSessionKey,
    embedded = false,
    draftEmpty = false,
    onOpenCodeViewer,
    onToolApproval,
    toolApprovalUiDisabled = false,
    workspacePath,
    subagentTasks,
    onOpenSubagentTranscript,
  } = props;
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
  const rows = snapshot?.rows.window ?? EMPTY_V4_ROWS;

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

  // 审批列表变化时强制相关工具行重绘（rowContext 本身保持稳定，靠 tick 推一次）
  const approvalRenderKey = pendingApprovals.map((p) => p.toolCallId).join(",");

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath: workspacePath ?? "",
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId: sessionId || null,
      onOpenCodeViewer,
      fetchFileChanges: sessionId ? fetchFileChanges : undefined,
      // 贴在对应 bash/工具卡下方，不用底部浮层
      renderToolCallApproval,
    }),
    // approvalRenderKey：仅在待审批集合变化时换 context，让工具行挂上/摘掉面板；
    // 不跟每帧 rows/snapshot 绑定，避免展开「文件已更改」时整区闪。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: approvalRenderKey gates refresh
    [sessionId, onOpenCodeViewer, fetchFileChanges, renderToolCallApproval, workspacePath, approvalRenderKey],
  );

  // stream-compare：页面画什么 → 同轮目录 v4-ui-display.log（排查发送后白屏/无回复）。
  // 依赖 snapshot.seq + windowCount：流式每帧 seq 变就会落盘；sig 去重避免同内容刷盘。
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

  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      {/*
        MessageFileLink / useFileContextActions 强依赖 PlatformProvider；
        EvoFlow 无桌面 window.zcode，挂 stub，避免 markdown 整段降级为纯文本。
      */}
      <PlatformProvider platform={evoflowStubPlatform}>
      <MarkdownTableVariantProvider value="evoflow">
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
          totalCount={snapshot?.rows.totalCount ?? 0}
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
          bottomDock={bottomDock}
          // 嵌入态 composer 在面板外：空态不要跟不存在的 dock 居中，否则发消息瞬间整栏跳布局。
          // 草稿态（新对话、尚无 threadId）必须同样居中：点击「+」后会话创建 + ensure-thread
          // 要 2~3s，期间若退回老面板的底部 dock，用户会看到输入框先在底部、随后跳到中间。
          // 居中条件只认「当前没有可显示的行」：connecting / 等首帧快照期间也必须居中。
          // 若把 connecting 排除在外，新对话会经历 居中 → 贴底 → 再居中 的三段跳。
          centerEmptyStateWithDock={embedded ? false : rows.length === 0}
          emptyState={
            draftEmpty ? (
              <div data-testid="v4-draft-empty" className="w-full">
                <V4DraftEmptyState />
              </div>
            ) : // connecting 阶段不渲染任何提示，避免闪「V4 连接中…」
            connecting ? null : (
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
      </MarkdownTableVariantProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>
  );
}
