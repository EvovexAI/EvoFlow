import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkflowRunArtifact,
  WorkflowRunArtifactKind,
  WorkflowRunArtifactSummary,
  WorkflowRunArtifactVersion,
} from "@zcode/shared/zcode-protocol-v4";
import { orderArtifactsPrimaryFirst } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * ⚠ 术语：本模块的 artifact 是
 * **脚本经 `artifact.*` 发布给用户看的产出**，不是引擎内部那个「脚本顶层返回值」的同名词。
 */

/**
 * 一个产物的合并视图：活投影的**新鲜元数据** + journal 的**完整元数据**（版本历史与 spec）。
 *
 * 两个来源缺一不可，所以这个类型是它们的并集而不是二选一：
 * - 活投影（`workflowRuns[].artifacts`）刻意只带最新版的元数据——它是一个高频状态键，
 *   带上 spec 与全部版本会让每一帧都重发一遍不会变的东西；
 * - journal 查询带 `versions` 与 `spec`，而**预置看板没有 spec 就画不出来**，
 *   所以哪怕 run 就在活投影里也仍然要查一次 journal。
 */
export interface WorkflowRunArtifactView {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  /** 最新版的字节数（内容产物才有）。 */
  bytes?: number;
  /** 工作区相对的原路径（`file` 才有）——「在工作区显示」按它定位。 */
  sourcePath?: string;
  /** 最新版号。 */
  version: number;
  /** 版本升序；journal 查询缺席（老 CLI / 读失败）时整键缺席，版本步进器随之退化成只有最新版。 */
  versions?: readonly WorkflowRunArtifactVersion[];
  /** 预置看板的 spec；journal 查询缺席时同样缺席，看板卡因此退回「读不到详情」。 */
  spec?: unknown;
  /** 打了这个 id 标签的 report 条数——看板取数 hook 的**刷新信号**。 */
  itemCount: number;
  /** run 的交付物；两个来源任一带上即算。 */
  primary?: true;
}

interface WorkflowRunArtifactsViewState {
  artifacts: readonly WorkflowRunArtifactView[];
  /**
   * 元数据的**主**来源。`live` = run 还在活投影里（此时 journal 只用来补 spec / versions）；
   * `journal` = 冷恢复或被 8-run 上限淘汰，整份清单都来自 journal。
   *
   * 它不是「有没有查过 journal」的标记——两种情形都会查——而是给读者与测试一个可观察的
   * 判据：这份清单是跟着 run 实时长出来的，还是事后从日志里读回来的。
   */
  source: "live" | "journal";
  loading: boolean;
  /** 会话不支持产物查询（老 CLI）：内容产物仍能列出，预置看板画不出来。 */
  unavailable: boolean;
  error: string | null;
  /**
   * 这份清单是**完整的**：活投影在场（它的上界 32 = 引擎的每 run 上限，所以从不被砍），或
   * journal 已经答过。完成卡据它决定 `+N` 写数字还是省略号——通知载荷砍在 8 件，那是**载荷**
   * 的事实，不是这里画的清单的事实；能力缺席（老 CLI）时清单可能确实不全，仍为 false。
   */
  complete: boolean;
}

/**
 * 能力缺席（CLI 没有 `listArtifacts` 那套宿主查询）与「这个 run 没有产物」必须能区分：
 * 前者要让预置卡说「读不到详情」，后者是整区缺席。判据与 `useWorkflowRunJournalSummaries`
 * 同一读法——错误跨 JSON-RPC 之后只剩 message 可靠，所以 reasonCode 与能力名两个模式都收。
 */
function isWorkflowRunArtifactsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactRows");
}

/**
 * 活投影里那组摘要的**形状签名**：`id:kind:version` 逐条拼起来。
 *
 * journal 重查的触发条件用它而不是用整个数组的引用：投影每来一条 `report` 都会造一个新数组
 * （`itemCount` 变了），但条目数变化**不改变**任何产物的版本或 spec——用引用当依赖会让一个
 * 每轮 report 的看板每轮重查一次 journal。反过来，新产物出现与同 id 发布新版都会改这个签名，
 * 而那两件事恰恰**必须**重查（新产物要 spec，新版要 versions）。
 */
function summariesSignature(summaries: readonly WorkflowRunArtifactSummary[] | undefined): string {
  if (summaries === undefined) return "";
  return summaries.map((summary) => `${summary.id}:${summary.kind}:${summary.version}`).join("|");
}

function viewFromJournal(record: WorkflowRunArtifact): WorkflowRunArtifactView {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
    ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    // journal 的元素不带 bytes（字节挂在版本上），所以从最新版上取。
    ...(() => {
      const latest = record.versions.at(-1);
      return latest?.bytes === undefined ? {} : { bytes: latest.bytes };
    })(),
    version: record.version,
    versions: record.versions,
    itemCount: record.itemCount,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function viewFromSummary(summary: WorkflowRunArtifactSummary): WorkflowRunArtifactView {
  return {
    id: summary.id,
    kind: summary.kind,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.contentType === undefined ? {} : { contentType: summary.contentType }),
    ...(summary.bytes === undefined ? {} : { bytes: summary.bytes }),
    version: summary.version,
    itemCount: summary.itemCount ?? 0,
    ...(summary.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * 合并两个来源。**顺序与身份由活投影决定**（它是 run 正在长出来的那份），journal 只补
 * 活投影刻意不带的字段；journal 里有而活投影里没有的 id 追加在末尾——那是投影上界 32
 * 拒新之后仍然真实存在的产物，丢掉它们等于让一个满额 run 的产物凭空消失。
 *
 * 之后交付物带头（其余仍按首次发布顺序）：活投影按发布顺序 upsert，journal 那条路端口已经
 * 排过，两条路在这里汇成同一个顺序。
 */
function mergeArtifacts(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  return orderArtifactsPrimaryFirst(mergeArtifactSources(live, journal));
}

function mergeArtifactSources(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  if (live === undefined) {
    return journal === undefined ? [] : journal.map(viewFromJournal);
  }
  const byId = new Map((journal ?? []).map((record) => [record.id, record] as const));
  const merged = live.map((summary) => {
    const record = byId.get(summary.id);
    if (record === undefined) return viewFromSummary(summary);
    byId.delete(summary.id);
    // 活投影的版本号更新（journal 查询可能落后一次发布）；spec / versions 只有 journal 有。
    // `itemCount` 也取活投影：它是刷新信号，落后一拍就少画一个点。
    return {
      ...viewFromJournal(record),
      ...viewFromSummary(summary),
      ...(record.versions.length === 0 ? {} : { versions: record.versions }),
      ...(record.spec === undefined ? {} : { spec: record.spec }),
      ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
      ...(record.description === undefined ? {} : { description: record.description }),
    } satisfies WorkflowRunArtifactView;
  });
  return [...merged, ...[...byId.values()].map(viewFromJournal)];
}

/**
 * 一个 workflow run 的产物清单。
 *
 * ```
 * 活投影 workflowRuns[].artifacts ─┐
 *   （新鲜、无 spec、上界 32）      ├─▶ merge ─▶ artifacts[]
 * journal workflowRunArtifacts ───┘
 *   （完整、含 versions + spec）
 * ```
 *
 * journal 查询在**两种情形**下都发：活投影在场时用来补 spec / versions（看板没有 spec 就
 * 画不出来），活投影缺席时它就是唯一来源（冷恢复 / 被 8-run 上限淘汰）。重查的触发是摘要的
 * **形状签名**变化，不是数组引用——见 `summariesSignature`。
 */
export function useWorkflowRunArtifacts(options: {
  sessionId: string;
  runId: string;
  /**
   * 活投影里该 run 的产物摘要。`undefined` = run 不在活投影里（此时 `source` 为 journal）；
   * 空数组 = run 在场且零产物。两者语义不同，调用方不要把前者坍缩成后者。
   */
  live?: readonly WorkflowRunArtifactSummary[];
  enabled?: boolean;
}): WorkflowRunArtifactsViewState {
  const { workflowRunArtifacts } = useV4Conversation();
  const [journal, setJournal] = useState<readonly WorkflowRunArtifact[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求版本号：切 run / 切会话后的迟到响应必须被丢弃，不能污染新 run 的清单。
  const requestVersionRef = useRef(0);

  const enabled =
    options.enabled !== false && options.sessionId.length > 0 && options.runId.length > 0;
  const signature = summariesSignature(options.live);
  const { sessionId, runId } = options;

  const fetchArtifacts = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await workflowRunArtifacts({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setJournal(result.artifacts);
      setUnavailable(false);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunArtifactsCapabilityMissing(caught)) {
        // 能力缺席不是错误：内容产物的卡片仍然从活投影画得出来，只有看板画不了。
        setJournal(undefined);
        setUnavailable(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-artifacts] 读取产物清单失败", { error: message, runId, sessionId });
      setError(message);
    }
  }, [runId, sessionId, workflowRunArtifacts]);

  useEffect(() => {
    // 切 run / 切会话：先丢掉旧 run 的清单再重查。旧产物留在屏幕上比空白危险得多。
    requestVersionRef.current += 1;
    setJournal(undefined);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchArtifacts();
    // signature 是刻意的依赖：新产物出现 / 同 id 发新版都要重查，`itemCount` 变化不重查。
  }, [enabled, fetchArtifacts, signature]);

  return useMemo(
    () => ({
      artifacts: mergeArtifacts(options.live, journal),
      source: options.live === undefined ? "journal" : "live",
      loading,
      unavailable,
      error,
      complete: options.live !== undefined || journal !== undefined,
    }),
    [error, journal, loading, options.live, unavailable],
  );
}
