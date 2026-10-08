import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * 预置看板的取数。
 *
 * 不变式：**看板是 journal 的投影**。这里读的是 `kind = "report"` 且 `artifact_id` 相符的
 * journal 行，纯函数 `applyArtifactItems` 再把它们折成图 / 表 / 瓦片 / 看板——任何表面
 * （侧板小卡、全尺寸 tab、冷恢复）从同一批行得到同一幅图。
 *
 * ```
 * 投影 artifacts[id].itemCount 抬升
 *        │  （刷新信号，可能多算一个——见 3a 的说明）
 *        ▼
 *  workflowRunArtifactData({ afterSequence: 已收到的最后一条的 sequence })
 *        │
 *        ▼  hasMore 为真就继续翻，直到排空
 *   items[] 追加  ──▶  applyArtifactItems  ──▶  折线多一个点
 * ```
 */

/**
 * 一次「翻到排空」最多翻几页。`REPORT_CAPS` 是 256 条 / run，页大小 200，所以正常情形至多
 * 两页；这个上界只是防一个不肯给 `hasMore: false` 的实现把渲染线程锁死。
 */
const MAX_PAGES_PER_DRAIN = 16;

/**
 * 一次拉取途中 `itemCount` 又抬升时，收尾前最多补拉几轮（见 `pendingRef`）。
 * 每一轮都是一次「从本地末尾续上」的增量读，正常情形一轮就排空。
 */
const MAX_FOLLOW_UP_ROUNDS = 8;

interface WorkflowRunArtifactDataState {
  items: readonly ArtifactItem[];
  loading: boolean;
  /** 会话不支持产物取数（老 CLI）：看板画不出来，与「还没有数据」区分。 */
  unavailable: boolean;
  error: string | null;
}

/** 能力缺席的判据同 `useWorkflowRunArtifacts`：跨 JSON-RPC 之后只剩 message 可靠。 */
function isWorkflowRunArtifactDataCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactItems");
}

function emptyState(): WorkflowRunArtifactDataState {
  return { items: [], loading: false, unavailable: false, error: null };
}

export function useWorkflowRunArtifactData(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  /**
   * 刷新信号 = 投影里该 id 的 `itemCount`。抬升即增量拉取；它可能**多算一个**
   * （3a 记录的有意取舍），所以只当「也许还有」用，绝不当条目数用——真正的条数是
   * `items.length`。
   */
  itemCount?: number;
  enabled?: boolean;
}): WorkflowRunArtifactDataState {
  const { workflowRunArtifactData } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactDataState>(emptyState);
  const requestVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  /** 一次拉取途中又来了新的刷新信号：收尾前必须补拉，否则最后那个点永远不出现。 */
  const pendingRef = useRef(false);
  /**
   * 已收到的最后一条的 `sequence`——增量读的游标。
   *
   * 刻意用 ref 而不是从 `state.items` 末尾现读：`setState` 之后 `state` 要到下一次渲染
   * 才更新，而补拉发生在**同一个 async 函数里**，读 state 会拿到上一轮的末尾并把同一段
   * sequence 追加两次。
   */
  const cursorRef = useRef<number | undefined>(undefined);
  /**
   * 上一次据以续拉的 `itemCount`。`undefined` = 这一轮还没定基线（挂载 / 刚切产物），
   * 那一帧的取数归整份重取管，增量 effect 只记下基线就退场——否则每挂载一个看板都会白发
   * 一次必然返回空的增量查询。
   */
  const lastDrainedCountRef = useRef<number | undefined>(undefined);

  const { artifactId, runId, sessionId } = options;
  const enabled =
    options.enabled !== false && sessionId.length > 0 && runId.length > 0 && artifactId.length > 0;

  /**
   * 从游标一路翻到排空。`replace` 是整份重取（切产物 / 切 run），`append` 是增量追加。
   *
   * 单飞门（`inFlightRef`）：`itemCount` 在一次拉取途中再抬升是常态（脚本每轮 report 一次），
   * 重入会让同一段 sequence 被追加两次。被挡下的那一次**不丢弃**，而是记在 `pendingRef` 上，
   * 由正在跑的这一次在收尾前补拉——否则一个 run 的**最后一条** report 会永远画不出来
   * （它之后不会再有 `itemCount` 变化来触发下一次拉取）。
   */
  const drain = useCallback(
    async (mode: "replace" | "append") => {
      if (!enabled) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const requestVersion = ++requestVersionRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        let round = 0;
        let currentMode = mode;
        for (;;) {
          pendingRef.current = false;
          const collected: ArtifactItem[] = [];
          let cursor = currentMode === "append" ? cursorRef.current : undefined;
          for (let page = 0; page < MAX_PAGES_PER_DRAIN; page += 1) {
            const result = await workflowRunArtifactData({
              sessionId,
              runId,
              artifactId,
              ...(cursor === undefined ? {} : { afterSequence: cursor }),
              limit: WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
            });
            if (requestVersion !== requestVersionRef.current) return;
            collected.push(...result.items);
            const lastSequence = result.items.at(-1)?.sequence;
            if (lastSequence !== undefined) cursor = lastSequence;
            if (!result.hasMore || result.items.length === 0) break;
          }
          if (requestVersion !== requestVersionRef.current) return;
          cursorRef.current = cursor;
          const settledMode = currentMode;
          setState((current) => ({
            items: settledMode === "replace" ? collected : [...current.items, ...collected],
            loading: false,
            unavailable: false,
            error: null,
          }));
          round += 1;
          if (!pendingRef.current || round >= MAX_FOLLOW_UP_ROUNDS) break;
          currentMode = "append";
        }
      } catch (caught) {
        if (requestVersion !== requestVersionRef.current) return;
        if (isWorkflowRunArtifactDataCapabilityMissing(caught)) {
          setState((current) => ({
            items: mode === "replace" ? [] : current.items,
            loading: false,
            unavailable: true,
            error: null,
          }));
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] 读取看板条目失败", {
          artifactId,
          error: message,
          runId,
          sessionId,
        });
        setState((current) => ({ ...current, loading: false, error: message }));
      } finally {
        inFlightRef.current = false;
        pendingRef.current = false;
      }
    },
    [artifactId, enabled, runId, sessionId, workflowRunArtifactData],
  );

  // 切产物 / 切 run / 从关到开：先清空再整份重取。别的看板的点绝不能留在这块画布上。
  useEffect(() => {
    requestVersionRef.current += 1;
    cursorRef.current = undefined;
    lastDrainedCountRef.current = undefined;
    setState(emptyState());
    if (!enabled) return;
    void drain("replace");
  }, [drain, enabled]);

  // 增量：`itemCount` 抬升即续拉。
  //
  // 门里**没有**「本地一条都还没有就不拉」这一条：一个在脚本顶部声明、之后每轮才被 report
  // 喂数据的看板，挂载那一刻本地就是空的，用空判据挡下来等于让它永远画不出第一个点。
  // 挂载时那次重复触发由单飞门吞掉（重取 effect 先跑，已经占住了门）。
  const itemCount = options.itemCount ?? 0;
  useEffect(() => {
    if (!enabled) return;
    // 本轮的第一帧：整份重取正在跑，这里只记基线。effect 的声明顺序保证重取那一个先跑。
    if (lastDrainedCountRef.current === undefined) {
      lastDrainedCountRef.current = itemCount;
      return;
    }
    if (itemCount === lastDrainedCountRef.current) return;
    lastDrainedCountRef.current = itemCount;
    void drain("append");
  }, [drain, enabled, itemCount]);

  return useMemo(() => state, [state]);
}
