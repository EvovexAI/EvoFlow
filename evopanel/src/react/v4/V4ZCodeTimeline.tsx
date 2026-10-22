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
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import "@/styles-bridge.css";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { ServiceProvider } from "@zcode/ui/hooks/useServices.js";
import { ConversationTimeline } from "@zcode/ui/v4/ConversationTimeline.js";
import { hasOlderRows } from "@zcode/ui/v4/conversationProjectionStore.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zcode/ui/lib/codePreviewSettings.js";
import { logStreamCompareV4PanelDisplay } from "../lib/stream-compare-file-log.js";
import type { IServiceAccessor } from "@zcode/services";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { V4TimelinePayload } from "./V4StreamRowsBridge.js";
import type { ConversationRowRenderContext } from "@zcode/ui/v4/conversationRowContext.js";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";

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
  } as unknown as IServiceAccessor;
}

export function V4ZCodeTimeline(props: {
  payload: V4TimelinePayload | null;
  /** 已有 threadId 但快照未到（订阅/构建中）。 */
  connecting?: boolean;
  /** EvoFlow 会话 key：stream-compare 落盘目录名（与 sse/v4-recv 同轮对账）。 */
  evoflowSessionKey?: string | null;
  /**
   * EvoFlow 底部输入区：作为 ConversationTimeline sticky bottomDock 挂进同一滚动视口
   * （对齐 ZCode SessionPane），避免 messages 区单独滚动、下方空出「留给输入框」的空白。
   */
  bottomDock?: ReactNode;
  /** 工具卡/文件 chip 点击 → EvoFlow 右侧面板文件预览（ZCode CodeViewerSource 语义）。 */
  onOpenCodeViewer?: (source: import("@zcode/ui/lib/codeViewer.js").CodeViewerSource) => void;
}): React.JSX.Element {
  const { payload, connecting, bottomDock, evoflowSessionKey, onOpenCodeViewer } = props;
  const sessionId = payload?.sessionId ?? "";
  const snapshot: ConversationSnapshot | null = payload?.snapshot ?? null;

  // 宿主保证引用稳定（ConversationRowView/MessageResponse 的 memo 依赖 context 引用）。
  // fetchFileChanges 闭包经 ref 读最新快照水位，rowContext 本身保持跨帧稳定。
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath: "",
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId: sessionId || null,
      onOpenCodeViewer,
      fetchFileChanges: sessionId
        ? async (target) => {
            const snap = snapshotRef.current;
            if (!snap) throw new Error("v4 snapshot not ready");
            return await getEvoflowV4Transport().fileChanges({
              sessionId,
              target,
              baseRevision: snap.seq,
              baseLogEpoch: snap.logEpoch,
            });
          }
        : undefined,
    }),
    [sessionId, onOpenCodeViewer],
  );

  // 访问器按 session 建（thread_id 沙箱解析），会话切换即重建。
  const partialServices = useMemo(
    () => createEvoflowPartialServices(sessionId),
    [sessionId],
  );

  const rows = snapshot?.rows.window ?? [];

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
        对齐 SessionPane 会话壳：
        - zcode-bridge-root：styles-bridge 的 token / 滚动条 / 焦点规则作用域
        - @container/conversation：正文限宽与左侧 turn navigator 的 container query
        - flex min-h-0 flex-1：把 messages-body 的高度约束传给 timeline 滚动层
        - bottomDock：输入区 sticky 在滚动视口底，与正文同轴
      */}
      <div className="zcode-bridge-root @container/conversation relative flex h-full min-h-0 flex-1 flex-col">
        <ServiceProvider services={partialServices}>
        <ConversationTimeline
          rows={rows}
          totalCount={snapshot?.rows.totalCount ?? 0}
          sessionKey={sessionId || "draft"}
          rowContext={rowContext}
          canLoadOlder={snapshot ? hasOlderRows(snapshot) : false}
          loadingOlder={payload?.loadingOlder ?? false}
          onLoadOlder={payload?.onLoadOlder}
          bottomDock={bottomDock}
          // 空草稿：问候与输入框同轴居中（对齐 ZCode SessionPane 草稿态）
          centerEmptyStateWithDock={!connecting && rows.length === 0}
          emptyState={
            // connecting 阶段不渲染任何提示，避免闪「V4 连接中…」
            connecting ? null : (
              <div className="flex h-full items-center justify-center text-ui-base text-foreground-subtlest">
                开始新的对话
              </div>
            )
          }
        />
        </ServiceProvider>
      </div>
    </ZCodeIntlProvider>
  );
}
