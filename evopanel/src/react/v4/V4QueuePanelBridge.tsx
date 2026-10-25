// V4QueuePanelBridge — 会话队列面板（对齐 ZCode SessionPane 的 queue 区域装配）。
//
// - 数据：投影 snapshot.queue（服务端 V4ConversationHub 的 `state.updated` queue patch
//   经 vendored apply.ts 键级替换进 snapshot，无需额外订阅）。
// - 操作：deleteQueueItem / editQueueItem / reorderQueueItem / sendQueuedNow /
//   setAutoDrain → transport.sendCommand（CAS 命令带 snapshot.revision，
//   renderer 侧 createCommandEnvelope 负责信封与守卫——勿 import host 的
//   zcodeV4HostCommand，那会把 node:crypto 打进 Vite browser bundle）。
// - rejected/stale 只 warn 不打断：stale 意味着队列被并发推进，下一帧 queue patch
//   会带来权威状态，无需本地回滚。
// - 挂载点：V4ZCodeTimeline bottomDock 内、composer 之上（对齐 SessionPane 布局）。
import { useCallback, useMemo } from "react";
import { ConversationQueuePanel } from "@zcode/ui/v4/ConversationQueuePanel.js";
import { createCommandEnvelope } from "@zcode/ui/v4/commandFactory.js";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import type { CommandPayloadMap, CommandType } from "@zcode/shared/zcode-protocol-v4";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";

export function V4QueuePanelBridge(props: {
  sessionId: string;
  queue: QueueState;
  /** CAS 命令的 baseRevision（= snapshot.revision）。 */
  revision: number;
}): React.JSX.Element | null {
  const { sessionId, queue, revision } = props;

  const send = useCallback(
    async <T extends CommandType>(type: T, payload: CommandPayloadMap[T]) => {
      try {
        const ack = await getEvoflowV4Transport().sendCommand(
          createCommandEnvelope({
            type,
            payload,
            sessionId,
            baseRevision: revision,
          }),
        );
        if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
          console.warn(
            `[v4-queue] command ${type} ${ack.status}` +
              `${ack.reasonCode ? ` (${ack.reasonCode})` : ""}` +
              "（等下一帧 queue patch 收敛）",
          );
        }
      } catch (error) {
        console.warn("[v4-queue] command rejected（等下一帧 queue patch 收敛）:", error);
      }
    },
    [sessionId, revision],
  );

  const onSendNow = useCallback(
    (queueItemId: string) => {
      void send("sendQueuedNow", { queueItemId });
    },
    [send],
  );
  const onDeleteItem = useCallback(
    (queueItemId: string) => {
      void send("deleteQueueItem", { queueItemId });
    },
    [send],
  );
  // onEditItem（撤回 composer）需要接宿主 composer 状态恢复草稿，本批未接——
  // 不传该回调时面板隐藏编辑入口，避免"删除即丢文本"的静默丢失。
  const onMoveItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      void send("reorderQueueItem", { queueItemId, beforeQueueItemId });
    },
    [send],
  );
  const onResume = useCallback(() => send("setAutoDrain", { autoDrain: true }), [send]);

  // 空队列不渲染（绝大多数会话常态），避免 panel 空壳参与布局。
  const visibleItems = useMemo(() => queue.items, [queue.items]);
  if (visibleItems.length === 0) return null;

  return (
    <ConversationQueuePanel
      queue={queue}
      onDeleteItem={onDeleteItem}
      onSendNow={onSendNow}
      onMoveItem={onMoveItem}
      onResume={onResume}
    />
  );
}
