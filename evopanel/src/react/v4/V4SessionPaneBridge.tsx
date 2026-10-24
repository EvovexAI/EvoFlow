// V4SessionPaneBridge — 右侧面板的子会话流式查看器（ZCode drilldown 同机制）。
// 子会话（collab 子任务线程 {lead}__sub__{id} / 子代理独立线程）的流早已被网关镜像
// 捕获进 v4 投影——本组件按 childSessionId 建 v4 订阅， readOnly 渲染完整时间线。
import { useCallback } from "react";
import { V4StreamRowsBridge, type V4TimelinePayload } from "./V4StreamRowsBridge.js";
import { V4ZCodeTimeline } from "./V4ZCodeTimeline.js";
import {
  openRightStageForCodeViewerSource,
  showRightStageFromFileLink,
} from "../../lib/right-stage/open-right-stage-file.js";
import type { MessageFileLinkTarget } from "@zcode/ui/components/ai-elements/message.js";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";

export function V4SessionPaneBridge(props: {
  sessionId: string;
  connecting?: boolean;
  /** 归属主会话：文件/预览 tab 挂到同一 sessionKey，避免切会话丢签。 */
  sessionKey?: string | null;
}): React.JSX.Element {
  const { sessionId, connecting, sessionKey } = props;
  const enabled = Boolean(sessionId);
  const sk = String(sessionKey || "").trim() || undefined;

  const onOpenFileLink = useCallback(
    (target: MessageFileLinkTarget) => {
      showRightStageFromFileLink(target, { sessionKey: sk, threadId: sessionId });
    },
    [sk, sessionId],
  );

  const onOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      openRightStageForCodeViewerSource(source, { sessionKey: sk, threadId: sessionId });
    },
    [sk, sessionId],
  );

  return (
    <V4StreamRowsBridge enabled={enabled} sessionId={sessionId}>
      {(payload: V4TimelinePayload | null) => (
        <V4ZCodeTimeline
          payload={payload}
          connecting={connecting || !payload}
          evoflowSessionKey={sk}
          onOpenFileLink={onOpenFileLink}
          onOpenCodeViewer={onOpenCodeViewer}
        />
      )}
    </V4StreamRowsBridge>
  );
}
