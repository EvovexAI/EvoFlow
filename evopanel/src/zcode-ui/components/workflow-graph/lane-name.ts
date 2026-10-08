import { laneClassOf, type LaneClass, type WorkflowLaneData } from "./types.js";
import { formatNamePattern, type NamePattern } from "./name-pattern.js";

/**
 * 车道显示名的唯一策略点。
 *
 * 站点 id（`actor#3`）是**身份**：journal 的 key、hover 标题里的锚、排查问题时的抓手。
 * 显示名是**表现**。两者混在一起时，界面上就会出现一行叫「actor#3」的车道——那是把 key
 * 当名字用。名字的来源只有两个：脚本里写下的名字（原样显示，本地化它就是改作者的话），
 * 以及分析拿不到名字时的本地化兜底。
 *
 * 为什么兜底必须发生在渲染时：投影（flow-elements.ts）是被 memo 住的纯函数，与语言无关；
 * 把本地化文案烘进投影，用户中途切语言时那串文字就成了过期文本（工作区/未解析两条车道
 * 一直在渲染时本地化，正是这个道理）。所以投影只搬数据，文案在这里成型。
 */

/**
 * 决定一条车道显示名所需的全部输入——不含 id：id 是身份，从不参与命名。
 * `LaneHead` 与候选车道引用（`LaneRef`）都满足这个形状，两个调用点因此共用一条策略。
 */
export interface LaneNaming {
  laneClass: LaneClass;
  /** 脚本里 `agent("planner")` 给出的名字；分析拿不到字面量时缺席。 */
  name?: string;
  /**
   * 名字是插值出来的（`` agent(`研究员${i + 1}`) ``）时，模板两端的字面量。排在 `name`
   * 之后、匿名兜底之前：它比「未命名智能体」多说了一件真事，又不是作者原样写下的那个词。
   */
  namePattern?: NamePattern;
  /** 同一张图里并存多条匿名 agent 车道时的 1-based 序号；唯一一条时缺席。 */
  anonymousIndex?: number;
}

/**
 * `IntlInstance["formatMessage"]` 的最小形状。helper 只要这个函数，不碰 React，
 * 于是能用假 formatter 单测策略本身。
 */
export type LaneNameFormatter = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 合成车道不靠名字识别：它们是「什么在这里跑」，文案固定。 */
const NAME_ID_BY_CLASS: Partial<Record<LaneClass, string>> = {
  unresolved: "chat.toolCall.workflow.graph.lane.unresolved",
  workspace: "chat.toolCall.workflow.graph.lane.script",
};

export function laneDisplayName(lane: LaneNaming, formatMessage: LaneNameFormatter): string {
  const classNameId = NAME_ID_BY_CLASS[lane.laneClass];
  if (classNameId !== undefined) return formatMessage({ id: classNameId });
  // 作者原词原样显示：本地化它就是改作者的话。
  if (lane.name !== undefined) return lane.name;
  // 名字是插值出来的：形状仍然是作者的话，所以同样不本地化，只是补一个省略号。
  const patterned = formatNamePattern(lane.namePattern);
  if (patterned !== undefined) return patterned;
  // 编号只在需要区分时才出现：图里只有一条匿名车道，「未命名智能体 1」里的 1 什么也没说。
  return lane.anonymousIndex === undefined
    ? formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
    : formatMessage(
        { id: "chat.toolCall.workflow.graph.lane.anonymousIndexed" },
        { index: lane.anonymousIndex },
      );
}

/**
 * 对一条车道的引用：身份（`id`）加上做显示名所需的全部素材。**从不是拼好的显示串**——
 * 匿名兜底文案在渲染时才由 `laneDisplayName` 成型，见文件头那段。
 */
export interface LaneRef extends LaneNaming {
  id: string;
}

/**
 * 1-based 序号，按车道顺序发给「没有名字的 agent 车道」，且只在并存两条以上时才发：
 * 图里只有一条匿名车道时，「未命名智能体 1」里的 1 没有区分对象，只是噪声。
 *
 * **带 pattern 的车道算「有名字」**，不进这份计数：它头上写着「研究员…」，再挂一个匿名序号
 * 只会让序号与画面上看得见的匿名车道数量对不上。两条 pattern 恰好相同时会撞名——那和两条
 * 都字面叫 `"worker"` 的车道撞名是同一件事，这里不欠新的消歧。
 *
 * 计数与语言无关，所以它属于这一层（并且可单测）；文案本身在渲染时才成型。
 */
function anonymousLaneIndexes(lanes: readonly WorkflowLaneData[]): Map<string, number> {
  const anonymous = lanes.filter(
    (lane) =>
      lane.name === undefined &&
      formatNamePattern(lane.namePattern) === undefined &&
      laneClassOf(lane.id) === "agent",
  );
  if (anonymous.length < 2) return new Map();
  return new Map(anonymous.map((lane, index) => [lane.id, index + 1]));
}

/**
 * 车道 id → 命名素材（不是显示串）。
 *
 * 三个消费者共用这一份：图的名册、step 卡片的候选车道、以及 transcript 下钻的实例选择器。
 * **必须同源**——匿名编号是「图里第几条匿名车道」，各算一次总有一天不相等，表现是选择器里的
 * 「未命名智能体 2」对着图上的「未命名智能体 1」。
 *
 * 它住在这里而不是投影层（flow-elements.ts），是为了让不画图的消费者（下钻解析是纯函数）
 * 不必为一份命名素材把 React Flow 拖进依赖里。图里没有的车道 id 由调用方兜底成
 * `{id, laneClass}`：站点特化之类的将来变化不该让下钻崩掉。
 */
export function laneRefsById(lanes: readonly WorkflowLaneData[]): Map<string, LaneRef> {
  const anonymousIndexes = anonymousLaneIndexes(lanes);
  return new Map(
    lanes.map((lane) => {
      const anonymousIndex = anonymousIndexes.get(lane.id);
      return [
        lane.id,
        {
          id: lane.id,
          laneClass: laneClassOf(lane.id),
          ...(lane.name === undefined ? {} : { name: lane.name }),
          ...(lane.namePattern === undefined ? {} : { namePattern: lane.namePattern }),
          ...(anonymousIndex === undefined ? {} : { anonymousIndex }),
        },
      ];
    }),
  );
}
