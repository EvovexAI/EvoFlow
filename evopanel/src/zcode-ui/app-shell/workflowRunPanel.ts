/**
 * workflow run 详情页的纯逻辑：Cancel 可用性、结果/失败面板判定、事件日志行摘要。
 *
 * 抽成纯函数是因为详情页里唯一有"规则"的部分就是这些，而它们全都能被穷举单测，
 * 不必渲染一张 React Flow 画布。组件只负责把这里的结果贴到 DOM 上。
 */
import {
  readWorkflowRunStopReason,
  type WorkflowRunStopReason,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunActor, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunConcurrencyEventLine } from "@/app-shell/workflowRunThrottle.js";

/** 未知事件种类的兜底原文上限：事件日志绝不把整条 journal 灌进 DOM。 */
const UNKNOWN_PAYLOAD_MAX_LENGTH = 200;

/**
 * Cancel 只在 `running` 上可用。
 *
 * 取消走的是既有的 v4 `cancelBackgroundWork {workId: runId}`（三个入口一个实现，
 * 没有第二条 cancel RPC），而它对已终结的任务本来就是 noop——按钮在终态禁用是为了
 * 不给出一个点下去毫无反应的控件，不是为了兜底。run 缺席（被 8-run 上限淘汰或冷启动
 * 尚未投影）时同样不可取消：此时我们对它的在飞状态一无所知。
 */
export function isWorkflowRunCancellable(run: WorkflowRunState | undefined): boolean {
  return run?.status === "running";
}

/**
 * Resume 可用性。**一个信源**：投影 run 的 `resumable` 状态位——由 CLI 在 `run-settled`
 * 载荷上按 resume 门的**同一个谓词**算好（live 与冷回放同一条铸造链），UI 绝不自行按
 * status + failureCode 推导（两处谓词会漂移：按钮亮着但命令被拒）。
 *
 * 投影缺席（被 8-run 上限淘汰）一律不可恢复：宁可少一个按钮，不给出一个点下去必被拒的控件。
 */
export function isWorkflowRunResumable(run: WorkflowRunState | undefined): boolean {
  return run?.resumable === true;
}

type WorkflowRunResultView =
  /** run 不在投影里：不可能有结果可言。 */
  | { kind: "absent" }
  /** pending / running：还没有结果面板。 */
  | { kind: "none" }
  /**
   * 完成。`preview` 本阶段**恒缺席**——脚本产物只在 `RunSettlement.artifact` 里，既不在
   * `run-settled` 事件上（它只携 status 与 error），也不在 journal 里。所以完成态只能指向
   * 会话里那条后台结果轮，绝不编造一个结果视图。schema 保留了该字段，真填上时如实展示。
   */
  | { kind: "completed"; preview?: string }
  /**
   * errored / stopped。`message` 是投影给出的预格式化
   * 原文（schema 里就是一个 string）；`stopReason` 只在 stopped 且投影带该键时在场。
   */
  | {
      kind: "error";
      status: "errored" | "stopped";
      stopReason?: WorkflowRunStopReason;
      message?: string;
    };

export function workflowRunResultView(run: WorkflowRunState | undefined): WorkflowRunResultView {
  if (!run) return { kind: "absent" };
  if (run.status === "errored" || run.status === "stopped") {
    const stopReason = readWorkflowRunStopReason(run);
    return {
      kind: "error",
      status: run.status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(run.error ? { message: run.error } : {}),
    };
  }
  if (run.status === "completed") {
    return { kind: "completed", ...(run.resultPreview ? { preview: run.resultPreview } : {}) };
  }
  return { kind: "none" };
}

/** 事件日志的一条输入（= v4 query 结果里的一项）。 */
export interface WorkflowRunEventItem {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
}

export interface WorkflowRunEventLine {
  sequence: number;
  type: string;
  /** 已本地化的主标签。 */
  label: string;
  /** 身份与数据（站点实例、actor 名、日志正文、错误原文）；不需要本地化。 */
  detail?: string;
  /** 失败/取消着色；其余一律 default（叠加视图的四值词汇表之外不新增视觉词汇）。 */
  tone: "default" | "failed";
  truncated?: boolean;
}

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{siteId, ordinal}` → `site@ordinal`（与引擎的 refToString 同形，便于和日志对照）。 */
function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** 非空字符串，否则 undefined（joinDetail 会把它整段丢掉，而不是留一截空分隔符）。 */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === "string" && value.message.length > 0 ? value.message : undefined;
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 事件日志里一条 report 条目的**短摘要**（不是 Results 区那份完整预览）。
 *
 * 刻意在这里就地压成一行：事件日志是等宽的一行一条，多行 JSON 会把日志撑开成第二个
 * 产物视图。完整形态（string 原样 / object pretty JSON）由 CLI 侧算好放在
 * `workflowRuns.reports[].preview` 上，Results 区渲染的是那一份。
 */
function reportItemSummary(item: unknown): string | undefined {
  if (item === undefined) return undefined;
  if (typeof item === "string") {
    return item.length > 0 ? truncate(item, UNKNOWN_PAYLOAD_MAX_LENGTH) : undefined;
  }
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? undefined : truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
  } catch {
    // 载荷已在 CLI 侧规范化成可 JSON 序列化的形态；真到不了这里也不能打挂一整页日志。
    return undefined;
  }
}

/** 未知种类的兜底：type + 截断 JSON。既不崩，也不假装认识它。 */
function unknownDetail(payload: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // 载荷已在 CLI 侧规范化成可 JSON 序列化的形态；真到不了这里也不能让一行日志打挂面板。
    return undefined;
  }
  if (serialized === undefined || serialized === "{}") return undefined;
  return truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
}

const EVENT_KEY_PREFIX = "chat.toolCall.workflow.run.event.";

/**
 * 引擎事件 → 可读一行。
 *
 * 词汇表按**引擎实际发出的**种类写：run-started / actor-created / node-queued /
 * node-dispatched / node-repairing / node-nudged / node-settled / usage-updated / log /
 * import-cache-closed / report / escalation-raised / escalation-resolved / run-settled，以及自适应并发的
 * node-waiting / node-executing / concurrency-changed（default 分支先交给同族模块）。后两个由 driver 在执行 ask
 * 的边界内发出（引擎核心不感知升级），但走的是完全相同的两条轨，所以在这里与其余同族。
 * `payload` 是事件对象去掉 `type` 后的其余字段（run service 的映射契约），
 * 所以这里的读法就是引擎的字段名，不做二次重塑。
 *
 * 每个分支都对形状做防御性读取：载荷已经过有界化，深层字段可能被削掉，
 * 而一条读不动的事件绝不能打挂整个事件日志。
 */
export function workflowRunEventLines(
  events: readonly WorkflowRunEventItem[],
  formatMessage: FormatMessage,
): WorkflowRunEventLine[] {
  return events.map((event) => {
    const { payload } = event;
    const base = {
      sequence: event.sequence,
      type: event.type,
      ...(event.truncated ? { truncated: event.truncated as true } : {}),
    };
    const key = (suffix: string) => ({ id: `${EVENT_KEY_PREFIX}${suffix}` });

    switch (event.type) {
      case "run-started":
        // caps 不进这一行：并发度不是可操作信息。
        return { ...base, label: formatMessage(key("runStarted")), tone: "default" };

      case "actor-created": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        return {
          ...base,
          label: formatMessage(key("actorCreated")),
          ...(joinDetail(name, refText(payload.actor)) === undefined
            ? {}
            : { detail: joinDetail(name, refText(payload.actor))! }),
          tone: "default",
        };
      }

      case "node-queued": {
        const kind = typeof payload.kind === "string" ? payload.kind : undefined;
        const detail = joinDetail(refText(payload.instance), kind);
        return {
          ...base,
          label: formatMessage(key("nodeQueued")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-dispatched":
      case "node-nudged": {
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key(event.type === "node-nudged" ? "nodeNudged" : "nodeDispatched")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-repairing": {
        const attempt = typeof payload.attempt === "number" ? String(payload.attempt) : "?";
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key("nodeRepairing"), { attempt }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-settled": {
        const outcome =
          payload.outcome === "ok" ||
          payload.outcome === "failed" ||
          payload.outcome === "cancelled"
            ? payload.outcome
            : undefined;
        const outcomeLabel = outcome
          ? formatMessage({ id: `chat.toolCall.workflow.run.outcome.${outcome}` })
          : "";
        const detail = joinDetail(refText(payload.instance), errorMessage(payload.error));
        return {
          ...base,
          label: formatMessage(key(payload.cached === true ? "nodeSettledCached" : "nodeSettled"), {
            outcome: outcomeLabel,
          }),
          ...(detail === undefined ? {} : { detail }),
          // journal 里 failed 与 cancelled 语义不同，但这一行只需要「这步没成」。
          tone: outcome === "failed" || outcome === "cancelled" ? "failed" : "default",
        };
      }

      case "usage-updated": {
        // 事件直接携带已花总量；权威值在状态头的用量行上。
        const spentTokens =
          typeof payload.spentTokens === "number" ? payload.spentTokens : undefined;
        return {
          ...base,
          label: formatMessage(key("usageUpdated")),
          ...(spentTokens === undefined
            ? {}
            : { detail: `${spentTokens.toLocaleString()} tokens` }),
          tone: "default",
        };
      }

      case "log": {
        const message = typeof payload.message === "string" ? payload.message : undefined;
        return {
          ...base,
          label: formatMessage(key("log")),
          ...(message === undefined ? {} : { detail: message }),
          tone: "default",
        };
      }

      /** 控制流经过了一个 `phase("…")` 标记：给名字与第几次进入（回放导出仍用这条格式化器）。 */
      case "import-cache-closed": {
        // amend-resume 的导入缓存关门：谁的第一笔写入关的门。
        // detail = 子代理名（有则）+ 实例；world.run 关的门没有名字，只有实例。
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(actorName, refText(payload.instance));
        return {
          ...base,
          label: formatMessage(key("importCacheClosed")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "phase-entered": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 1;
        return {
          ...base,
          label: formatMessage(key("phaseEntered")),
          ...(name === undefined ? {} : { detail: ordinal >= 2 ? `${name} · ${ordinal}` : name }),
          tone: "default",
        };
      }

      /**
       * report 与 log 都是 fire-and-forget，但 report **有 site 身份**（`report#N@k` 进 journal），
       * 所以这一行带实例。条目正文另有主场（Results 区的完整预览），这里只给一个短摘要——
       * 事件日志的职责是"引擎发过什么、什么时候"，不是第二个产物视图。
       */
      case "report": {
        const detail = joinDetail(refText(payload.instance), reportItemSummary(payload.item));
        return {
          ...base,
          label: formatMessage(key("report")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      /**
       * 升级问答：actor 撞上真阻塞，把问题升级给主代理，
       * 停在自己那次 ask 里等答案；主代理按 qid 作答后它就地继续。
       *
       * 两行都以 **qid 打头**，尽管 raised 那一行的主角是"谁问了什么"：qid 是这两条事件之间
       * 唯一的关联键，而它们在日志里通常隔着几十行（等待就是这个特性的全部内容）。少了它，
       * 一条 "已作答" 就无从知道答的是上面哪一问。
       *
       * 正文按 detail 列的既有习惯截断（与 report 摘要同一个上限）：事件日志是一行一条，
       * 完整的问题正文另有主场——上面的「待答问题」区。
       */
      case "escalation-raised": {
        const question = typeof payload.question === "string" ? payload.question : undefined;
        // actor 名缺席（匿名 actor）时退回站点实例：这一行宁可说 `actor#1@1`，也不能不说是谁。
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          actorName ?? refText(payload.actor),
          question === undefined ? undefined : truncate(question, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationRaised")),
          ...(detail === undefined ? {} : { detail }),
          // 升级不是失败：actor 没有出错，它在等一个答案。着色留给真正没成的那些行。
          tone: "default",
        };
      }

      case "escalation-resolved": {
        const answer = typeof payload.answer === "string" ? payload.answer : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          answer === undefined ? undefined : truncate(answer, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationResolved")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "run-settled": {
        const status =
          typeof payload.status === "string" && payload.status.length > 0
            ? payload.status
            : undefined;
        const statusLabel = status
          ? formatMessage({ id: `chat.toolCall.workflow.run.status.${status}` })
          : "";
        const detail = errorMessage(payload.error);
        return {
          ...base,
          label: formatMessage(key("runSettled"), { status: statusLabel }),
          ...(detail === undefined ? {} : { detail }),
          tone: status === "errored" || status === "stopped" ? "failed" : "default",
        };
      }

      default: {
        // 并发的四条事件（node-waiting / node-executing / concurrency-changed / run-caps-changed）
        // 住在同族的 workflowRunThrottle.ts（max-lines 门）。
        const concurrencyLine = workflowRunConcurrencyEventLine(event, formatMessage);
        if (concurrencyLine !== undefined) return concurrencyLine;
        // 例如引擎为长上下文压缩预留的 `compaction`（v1 从不发出）。它将来一出现，
        // 这里必须仍给出一条有信息量的行，而不是空白。
        const detail = unknownDetail(payload);
        return {
          ...base,
          label: formatMessage(key("unknown"), { type: event.type }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }
    }
  });
}

// ── Transcript 入口：step 卡片 → actor 实例──

/**
 * 一个可打开的 actor 实例。
 *
 * `siteId` + `ordinal` 是身份（journal 的键），`name` 只是展示；`sessionId` 是那条真实持久
 * 会话的 id，也是嵌套只读 SessionPane 唯一需要的东西。
 *
 * `sessionId` **可缺席**（schema-optional）：进度事件可能先于 actor 会话落库到达，老 run
 * 也可能根本没有；还没启动的槽位
 * 更是从来没有。缺席的实例照样开 tab——tab 的身份是 (runId, siteId, ordinal)，会话 id 只是
 * 随行的订阅目标，缺席时 tab 里是「尚未启动」占位。
 */
export interface WorkflowActorInstance {
  siteId: string;
  ordinal: number;
  name?: string;
  sessionId?: string;
  status: WorkflowRunActor["status"];
}

// ── actor 未启动门──

/**
 * 一个 actor transcript tab 相对「会话是否已经存在」的三种处境。
 *
 * `unknown` 不是错误分支，而是**最常见的长期态**：tab 刻意没有 GC，比 8-run 投影淘汰活得久。
 */
type WorkflowActorStartState = "notStarted" | "started" | "unknown";

/** actor transcript tab 交给门的身份：槽位 + 打开时已知的会话 id（可缺席）。 */
interface WorkflowActorSlotRef {
  runId: string;
  siteId: string;
  ordinal: number;
  actorSessionId?: string;
}

/** 门的裁决：处境 + 该订阅的会话 id（缺席 = 没有可订阅的东西，面板只能占位）。 */
interface WorkflowActorGate {
  state: WorkflowActorStartState;
  sessionId?: string;
}

/**
 * 槽位 → 该 actor 是否已经启动，以及该订阅哪条会话。
 *
 * actor 会话是**懒创建**的：引擎在首个 ask 派发时才 `createActorSession`，所以在那之前
 * 订阅这条会话必然 `fault.subscribe.sessionNotFound`，而投影 store 失败后停在 `error`
 * 只等手动 retry——一个死面板。这个选择器就是那道门。
 *
 * 判定免竞态：`createActorSession` 在首个派发前就 `await` 完了会话落库（`workflow-driver.ts`
 * 的时序由测试钉住），所以**投影里见到 dispatched ⇒ 会话行已存在 ⇒ 订阅必然命中**。
 * 反过来 `queued` 不算启动：持久化顺序的保证挂在派发前，队列里的节点不构成会话存在的证据。
 *
 * 查找按 **(runId, siteId, ordinal)**：tab 可以在 actor 出现之前就开
 * （未启动的药丸），那时没有会话 id 可反查。三值里 `unknown` 与 `notStarted` 的分界仍是要紧
 * 的那条：
 *
 * - actor 不在投影里、tab **有**会话 id → `unknown`，**绝不拦**。run 被 8-run 上限淘汰、
 *   冷恢复后投影为空时，直接订阅是 transcript 唯一的路；拦住它等于把已完结 run 的唯一持久
 *   视图关死。
 * - actor 不在投影里、tab **没有**会话 id → `notStarted`：没有可订阅的东西，占位是诚实的
 *   （脚本还没走到 `agent()`；run 若已被淘汰，这个槽位也确实从未启动过）。
 * - actor 在、一个非 `queued` 节点都没有 → `notStarted`；有 → `started`，订阅目标取投影里的
 *   会话 id，tab 打开时带的作兜底。门读的就是实时投影，首个节点派发即自愈。
 *
 * 记录在案的例外：resume 的完结命中短路直接发 `node-settled`，不经 `ensureSession`，那条
 * actor 会话可能真的不存在。settled 会把门打开、订阅失败，落回既有 error+retry 面板——
 * 那确实是「会话不存在」，既有兜底就是正确答案。
 */
export function workflowActorStartState(
  runs: readonly WorkflowRunState[] | undefined,
  slot: WorkflowActorSlotRef,
): WorkflowActorGate {
  const run = runs?.find((candidate) => candidate.runId === slot.runId);
  const actor = run?.actors.find(
    (candidate) => candidate.siteId === slot.siteId && candidate.ordinal === slot.ordinal,
  );
  const sessionId = actor?.sessionId ?? slot.actorSessionId;
  const withSession = sessionId === undefined ? {} : { sessionId };
  if (run === undefined || actor === undefined) {
    return { state: sessionId === undefined ? "notStarted" : "unknown", ...withSession };
  }
  // 归属按 `siteId` + `ordinal`（journal 的键）比对：序号错了就是另一个实例，而
  // world-read 节点两个字段都缺席，于是从不给任何人开门。
  const started = run.nodes.some(
    (node) =>
      node.actorSiteId === actor.siteId &&
      node.actorOrdinal === actor.ordinal &&
      // `queued` 是唯一**不**证明会话存在的相位。取补集而不是列举 dispatched/repairing/
      // nudged/settled，是为了让将来新增的相位默认开门——与 `unknown` 不拦同一个取向。
      node.phase !== "queued",
  );
  return { state: started ? "started" : "notStarted", ...withSession };
}
