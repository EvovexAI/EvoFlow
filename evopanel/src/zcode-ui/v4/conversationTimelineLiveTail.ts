import type {
  ConversationTurnRenderUnit,
  ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";

export interface ConversationTimelineLiveTailSplit {
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
}

/**
 * running turn 继续放在绝对定位虚拟行里时，正文 DOM 会先长高，
 * ResizeObserver 下一帧才回填 totalSize/scrollTop，导致轮尾 ChatLoading 来回跳。
 * 最后一轮始终放在 normal-flow live tail；其余轮次仍归虚拟列表，只常驻一个尾轮。
 * Bugfix：曾按 isRunning 切换父容器，Stop 后整轮重挂，过程区从透明重新淡入。
 * 以轮次位置决定容器，让终态沿用已有组件；新一轮出现时旧轮才进入虚拟历史。
 *
 * 输入按「历史 + 尾轮」分区：运行中的最后一轮通常是唯一的尾轮 unit，此时虚拟列表直接用
 * 历史数组，引用在流式帧之间不变，virtualizer 与目录不会随每个 token 重建。
 */
export function splitConversationTimelineLiveTail(
  units: ConversationTurnRenderUnitsPartition,
): ConversationTimelineLiveTailSplit {
  const { history, tail } = units;
  const liveUnit = tail.at(-1) ?? history.at(-1);
  if (!liveUnit) {
    return {
      virtualizedUnits: tail.length === 0 ? history : [...history, ...tail],
      liveUnit: null,
      liveUnitIndex: null,
    };
  }
  return {
    virtualizedUnits:
      tail.length === 0
        ? history.slice(0, -1)
        : tail.length === 1
          ? history
          : [...history, ...tail.slice(0, -1)],
    liveUnit,
    liveUnitIndex: history.length + tail.length - 1,
  };
}
