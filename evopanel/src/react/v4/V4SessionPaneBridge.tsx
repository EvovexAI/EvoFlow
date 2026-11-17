// V4SessionPaneBridge — 侧栏 / 小V / 子会话共用的 embedded 时间线桥。
// 正文一律：V4StreamRowsBridge → V4ZCodeTimeline（与主聊同一套）。
// 可挂 bottomDock（ChatComposer），与主聊同轴 sticky 底栏。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { V4StreamRowsBridge, type V4TimelinePayload } from "./V4StreamRowsBridge.js";
import { V4ZCodeTimeline } from "./V4ZCodeTimeline.js";
import { useRightStageTabActive } from "./right-stage-tab-active.js";
import {
  openRightStageForCodeViewerSource,
  showRightStageFromFileLink,
} from "../../lib/right-stage/open-right-stage-file.js";
import { showRightStageBrowserUrl } from "../../lib/right-stage/open-right-stage-browser.js";
import { resolveTimelineWorkspacePath } from "../lib/session-workspace-path.js";
import type { MessageFileLinkTarget } from "@zcode/ui/components/ai-elements/message.js";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";

export type V4SessionPaneBridgeProps = {
  sessionId: string;
  connecting?: boolean;
  /** 归属主会话：文件/预览 tab 挂到同一 sessionKey，避免切会话丢签。 */
  sessionKey?: string | null;
  /**
   * 时间线 scope（审批去重 / 切会话清缓存）。员工过程页应传 proactive 会话 key，
   * 不要用主聊 sessionKey，否则会与左侧主对话串 scope。
   * 缺省回落 sessionKey。
   */
  evoflowSessionKey?: string | null;
  /**
   * 工作区根。缺省时从员工/子会话 context.local_workspace_root 解析，
   * 再回落主聊全局根——相对路径（projects\\…\\x.mp4）才能拼成可点击/可预览的绝对路径。
   */
  workspacePath?: string | null;
  /** 底部输入区（主聊同款 sticky dock）；缺省则只读时间线。 */
  bottomDock?: ReactNode;
  /** 窄栏嵌入（隐藏 turn navigator、空态不居中）。小V / 右栏默认应开。 */
  embedded?: boolean;
  /** 显示面皮肤：default=主聊同款；glass=语音浮层。 */
  surface?: "default" | "glass";
  /**
   * 本地消息条数（小V assistant-store）。与 phase 一起推 draftEmpty；
   * 不传则不据此推断草稿空态。
   */
  localMsgCount?: number;
  /** 显式草稿空态；优先于 localMsgCount 推断。 */
  draftEmpty?: boolean;
  /** 发送瞬间的乐观用户文本（V4 尚未 echo 时补一行）。 */
  optimisticUserText?: string | null;
  /** 行内工具审批（approve / deny / grant_all …）。 */
  onToolApproval?: (
    action: "approve" | "approve_all" | "deny" | "grant_all" | "approve_remember",
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void | Promise<void>;
  /**
   * 与底栏停止按钮同源。驱动末轮「工作中」齿轮（ChatLoading）；
   * 主聊传 selectedTurnBusy，小V/员工侧栏应传同一套 turnBusy。
   */
  sessionBusy?: boolean;
  /**
   * 是否前台。缺省：右栏签内跟签 active；签外 true。
   * 失活 forceMount 签不得抢 V4 focus/authority（对齐 ZCode focused=false）。
   */
  foreground?: boolean;
};

export function V4SessionPaneBridge(props: V4SessionPaneBridgeProps): React.JSX.Element {
  const {
    sessionId,
    connecting,
    sessionKey,
    evoflowSessionKey,
    workspacePath,
    bottomDock,
    embedded = false,
    surface = "default",
    localMsgCount,
    draftEmpty: draftEmptyProp,
    optimisticUserText = null,
    onToolApproval,
    sessionBusy = false,
    foreground: foregroundProp,
  } = props;
  const enabled = Boolean(sessionId);
  const sk = String(sessionKey || "").trim() || undefined;
  const evoSk = String(evoflowSessionKey || sessionKey || "").trim() || undefined;
  const tabActive = useRightStageTabActive();
  const foreground =
    typeof foregroundProp === "boolean"
      ? foregroundProp
      : tabActive == null
        ? true
        : tabActive;

  const [resolvedWorkspacePath, setResolvedWorkspacePath] = useState(() =>
    resolveTimelineWorkspacePath({
      workspacePath,
      evoflowSessionKey: evoSk,
      sessionKey: sk,
    }),
  );

  useEffect(() => {
    const sync = () => {
      setResolvedWorkspacePath(
        resolveTimelineWorkspacePath({
          workspacePath,
          evoflowSessionKey: evoSk,
          sessionKey: sk,
        }),
      );
    };
    sync();
    window.addEventListener("evopanel:session-workspace-updated", sync);
    window.addEventListener("evopanel:session-workspace-changed", sync);
    return () => {
      window.removeEventListener("evopanel:session-workspace-updated", sync);
      window.removeEventListener("evopanel:session-workspace-changed", sync);
    };
  }, [workspacePath, evoSk, sk]);

  const onOpenFileLink = useCallback(
    (target: MessageFileLinkTarget) => {
      showRightStageFromFileLink(
        {
          ...target,
          workspacePath: target.workspacePath || resolvedWorkspacePath || undefined,
        },
        { sessionKey: sk, threadId: sessionId },
      );
    },
    [sk, sessionId, resolvedWorkspacePath],
  );

  const onOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      openRightStageForCodeViewerSource(source, { sessionKey: sk, threadId: sessionId });
    },
    [sk, sessionId],
  );

  const onOpenBrowserUrl = useCallback(
    (url: string) => {
      showRightStageBrowserUrl(url, { sessionKey: sk, threadId: sessionId });
    },
    [sk, sessionId],
  );

  return (
    <V4StreamRowsBridge
      enabled={enabled}
      sessionId={sessionId}
      foreground={foreground}
    >
      {(payload: V4TimelinePayload | null, phase) => {
        const v4RowCount = payload?.snapshot?.rows.totalCount ?? 0;
        const isDraft =
          typeof draftEmptyProp === "boolean"
            ? draftEmptyProp
            : typeof localMsgCount === "number"
              ? localMsgCount === 0 && phase === "ready" && v4RowCount === 0
              : false;
        const windowRows = payload?.snapshot?.rows?.window?.length ?? 0;
        // 对齐主聊 / ZCode：有窗口行就不标 connecting；无行时 connecting|no-thread 才加载。
        // 勿用「!payload && !isDraft」单独成立——ready 瞬间 payload 空一帧会误闪加载。
        const phaseConnecting =
          !isDraft &&
          windowRows === 0 &&
          (phase === "connecting" ||
            phase === "no-thread" ||
            (!sessionId && (localMsgCount ?? 0) > 0));
        return (
          <V4ZCodeTimeline
            payload={payload}
            connecting={Boolean(connecting) || phaseConnecting}
            draftEmpty={isDraft}
            evoflowSessionKey={evoSk}
            embedded={embedded}
            surface={surface}
            focused={foreground}
            optimisticUserText={foreground ? optimisticUserText : null}
            bottomDock={foreground ? bottomDock : undefined}
            workspacePath={resolvedWorkspacePath || undefined}
            onToolApproval={foreground ? onToolApproval : undefined}
            sessionBusy={sessionBusy}
            onOpenFileLink={foreground ? onOpenFileLink : undefined}
            onOpenCodeViewer={foreground ? onOpenCodeViewer : undefined}
            onOpenBrowserUrl={foreground ? onOpenBrowserUrl : undefined}
          />
        );
      }}
    </V4StreamRowsBridge>
  );
}
