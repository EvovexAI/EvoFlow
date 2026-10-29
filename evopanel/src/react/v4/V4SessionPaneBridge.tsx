// V4SessionPaneBridge — 右侧面板子会话时间线（ZCode drilldown 同机制）。
// 子会话流已被网关镜像进 v4 投影；本组件按 sessionId 订阅。
// 可挂 bottomDock（如员工过程页的 ChatComposer），与主聊同轴 sticky 底栏。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { V4StreamRowsBridge, type V4TimelinePayload } from "./V4StreamRowsBridge.js";
import { V4ZCodeTimeline } from "./V4ZCodeTimeline.js";
import {
  openRightStageForCodeViewerSource,
  showRightStageFromFileLink,
} from "../../lib/right-stage/open-right-stage-file.js";
import { showRightStageBrowserUrl } from "../../lib/right-stage/open-right-stage-browser.js";
import { resolveTimelineWorkspacePath } from "../lib/session-workspace-path.js";
import type { MessageFileLinkTarget } from "@zcode/ui/components/ai-elements/message.js";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";

export function V4SessionPaneBridge(props: {
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
}): React.JSX.Element {
  const { sessionId, connecting, sessionKey, evoflowSessionKey, workspacePath, bottomDock } = props;
  const enabled = Boolean(sessionId);
  const sk = String(sessionKey || "").trim() || undefined;
  const evoSk = String(evoflowSessionKey || sessionKey || "").trim() || undefined;

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
    <V4StreamRowsBridge enabled={enabled} sessionId={sessionId}>
      {(payload: V4TimelinePayload | null) => (
        <V4ZCodeTimeline
          payload={payload}
          connecting={connecting || !payload}
          evoflowSessionKey={evoSk}
          bottomDock={bottomDock}
          workspacePath={resolvedWorkspacePath || undefined}
          onOpenFileLink={onOpenFileLink}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      )}
    </V4StreamRowsBridge>
  );
}
