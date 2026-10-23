// V4SessionPaneBridge — 右侧面板的子会话流式查看器（ZCode drilldown 同机制）。
// 子会话（collab 子任务线程 {lead}__sub__{id} / 子代理独立线程）的流早已被网关镜像
// 捕获进 v4 投影——本组件按 childSessionId 建 v4 订阅， readOnly 渲染完整时间线。
import { V4StreamRowsBridge, type V4TimelinePayload } from "./V4StreamRowsBridge.js";
import { V4ZCodeTimeline } from "./V4ZCodeTimeline.js";

export function V4SessionPaneBridge(props: {
  sessionId: string;
  connecting?: boolean;
}): React.JSX.Element {
  const { sessionId, connecting } = props;
  const enabled = Boolean(sessionId);
  return (
    <V4StreamRowsBridge enabled={enabled} sessionId={sessionId}>
      {(payload) => (
        <V4ZCodeTimeline payload={payload} connecting={connecting || !payload} />
      )}
    </V4StreamRowsBridge>
  );
}
