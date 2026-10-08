import { IMPLICIT_PHASE_ID, UNPHASED_PHASE_ID } from "./types.js";
import type { LaneNameFormatter } from "./lane-name.js";

/**
 * 阶段显示名的唯一策略点，与 lane-name.ts 逐条同构（同一件事只有一套规则）：
 * 作者原词 > 本地化兜底。
 *
 * 兜底必须发生在渲染时：投影是被 memo 住的纯函数、与语言无关，把文案烘进去，用户中途切
 * 语言那串字就过期了。`unphased` 是唯一拿不到 `name` 的阶段——它不是作者写下的词，而是
 * 「首个标记之前的那些 step」，所以它的名字永远本地化。
 */

/** 做一个阶段显示名所需的全部输入——不含 id 之外的身份信息。 */
export interface PhaseNaming {
  id: string;
  /** 脚本里 `phase("preflight")` 给出的名字；`unphased` 没有。 */
  name?: string;
}

export function phaseDisplayName(phase: PhaseNaming, formatMessage: LaneNameFormatter): string {
  if (phase.name !== undefined) return phase.name;
  if (phase.id === UNPHASED_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.unphased" });
  }
  // 无标记脚本的隐式唯一模块（participant-model.ts）：整个脚本就是一个阶段。
  if (phase.id === IMPLICIT_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
  }
  // 到不了这里：`unphased` 之外的阶段都带作者原词。真出现时报 id（身份）而不是「未分组」——
  // 把一个有名字的阶段说成兜底阶段是撒谎，露出 id 至少是可排查的。
  return phase.id;
}

/**
 * display 的阶段名经 `boundGraphText` 截到这么多字符（contracts 的
 * `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS`），运行时的名字（进入记录、实例的出生戳）则带完整
 * 名字（reducer 自己截到同一上界）。
 */
export const DISPLAY_PHASE_NAME_BOUND = 128;

/**
 * display 阶段名 ↔ 运行时阶段名的唯一关联规则是精确匹配，
 * display 名**恰好顶到上界**时才按前缀兜底——前缀只在截断真的发生过时才开，否则「计划」会
 * 误认「计划修复」。时间线的进入记录、`currentPhase` 与实例绑定三处共用它。
 *
 * 任一侧缺席 → false：关联需要两个名字，「无名」不是一个可匹配的名字。无名 display 阶段
 * （`unphased` / 隐式 `workflow`）与无戳实例的配对是另一条规则，由 `phasesOf` 显式处理。
 */
export function phaseNameMatches(
  displayName: string | undefined,
  runtimeName: string | undefined,
): boolean {
  if (displayName === undefined || runtimeName === undefined) return false;
  if (displayName === runtimeName) return true;
  return displayName.length >= DISPLAY_PHASE_NAME_BOUND && runtimeName.startsWith(displayName);
}
