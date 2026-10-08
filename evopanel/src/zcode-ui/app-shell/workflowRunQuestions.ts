/**
 * 待答问题（升级问答）的纯展示规则。
 *
 * 从 workflowRunPanel.ts 拆出（eslint max-lines 400 行门，与 WorkflowRunSidePaneSections.tsx
 * 同一先例）：那个文件承载详情页既有的四组规则（预算数学、Cancel 可用性、结果判定、事件行
 * 摘要），升级问答是一族新词汇，加在那里正好把它推过门。
 */

const WAITED_MINUTE_MS = 60_000;
const WAITED_HOUR_MS = 60 * WAITED_MINUTE_MS;
const WAITED_DAY_MS = 24 * WAITED_HOUR_MS;

/**
 * 本模块要的那点 intl 能力，就地声明而不是从 workflowRunPanel 借。
 *
 * 它是结构类型，两边各写一份不会漂移（形状由 react-intl 的 formatMessage 决定），而 import
 * 一个类型换来的是一条本不需要的模块依赖——拆文件的目的正是不要那条依赖。
 */
type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * 「这个问题已经等了多久」——读者看到一条待答问题时问的第一件事。
 *
 * 纯函数，`now` 由调用方注入（组件按固定间隔喂新的时刻）：等待中的 run **恰恰不发事件**，
 * 所以不能靠"下一次投影更新时顺手重算"——那会让一个卡了半小时的问题一直显示成"刚刚"。
 *
 * 文案复用既有的 `sidePane.time.*` 族（两个语言都已有），不为同一个意思新造一套键。
 *
 * 三条边界值得记下来：
 *   - `askedAt` 缺席（老 journal 重放出的事件没有这个字段）→ 返回 undefined，整个标签不渲染，
 *     而不是显示一个编出来的"刚刚"。
 *   - 时钟偏斜导致 `askedAt` 落在未来（提问时刻由 CLI 进程铸造，远端会话下与渲染进程根本
 *     不是同一台机器）→ 钳到"刚刚"。负数时长比不显示更糟。
 *   - 阶梯止于"天"：停驻问题按设计可以无限期等下去（不设超时），所以上界必须有个说法。
 */
export function workflowRunQuestionWaitedLabel(
  askedAt: number | undefined,
  now: number,
  formatMessage: FormatMessage,
): string | undefined {
  if (askedAt === undefined || !Number.isFinite(askedAt)) return undefined;
  const elapsed = now - askedAt;
  if (elapsed < WAITED_MINUTE_MS) return formatMessage({ id: "sidePane.time.justNow" });
  if (elapsed < WAITED_HOUR_MS) {
    return formatMessage(
      { id: "sidePane.time.minutesAgo" },
      { count: String(Math.floor(elapsed / WAITED_MINUTE_MS)) },
    );
  }
  if (elapsed < WAITED_DAY_MS) {
    return formatMessage(
      { id: "sidePane.time.hoursAgo" },
      { count: String(Math.floor(elapsed / WAITED_HOUR_MS)) },
    );
  }
  return formatMessage(
    { id: "sidePane.time.daysAgo" },
    { count: String(Math.floor(elapsed / WAITED_DAY_MS)) },
  );
}
