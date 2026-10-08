// ============================================================
// 就地生效的修订在转写里的那一行
// ============================================================
// 只改并发上限、run 又在飞时，`AmendWorkflow` 不编译、不铸新 run，只把那条 run 的上限改掉。于是
// 这一行没有卡可画：那条 run 的卡在它启动的那一轮里，再画一张会读成第二次运行；而原来的静态卡
// 会显示编译校验结果，使一次并发设置变更看起来像重新编译和启动了工作流。
//
// 画的就是 GUI「配置」留下的那条设置行（`WorkflowSettingsChangeRow`），一字不差——同一件事由谁
// 发起不该有两种读法。唯一的差别是它**可点**：工具行是模型这一步的落点，用户从这里回到那条 run。

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * 入参里那个数 → 设置轮那一块元数据。两者本来就是同一件事的两种记法（GUI 走轮元数据，工具走
 * 入参），映射到同一个形状之后措辞只剩一份实现。
 *
 * `requested` 是**模型发出的、未经钳制**的数（readWorkflowRetuneCall），而 CLI 会把它钳进
 * `[1, 天花板]`。所以这里把天花板一起交给措辞规则：`workflowSettingsChangeSegments` 对
 * `to >= ceiling` 与 `to` 缺席一视同仁，都念「上限恢复为本机默认」——这正是钳制之后的真相
 * （钳到天花板 = 这条 run 没有自己的界）。于是行上永远不会出现一个大于本机上限的数。
 * 天花板未知（那条 run 已被淘汰出投影、或老 CLI 没发过它）时只能照念请求值，此时它也只可能
 * 偏大不偏小——而「最多 n」本就是个上界陈述，不会把用户往「跑得比实际多」的方向误导。
 *
 * `from` 不填：入参不知道改之前是多少，而这一行的措辞只读 `to`。`predecessorRunId` 同样不填——
 * 就地生效没有前驱（workflow-row-meta.ts）。
 */
function retuneAsAmendMeta(
  requested: number | null,
  ceiling: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(ceiling === undefined ? {} : { ceiling }),
  };
}

export function WorkflowRetuneRow({
  ceiling,
  onOpen,
  requested,
  runId,
}: {
  /** 本机并发天花板（那条 run 的投影读数）；未知时缺席。 */
  ceiling?: number;
  /** 打开这条 run 的详情页；宿主没给（只读展示或功能已关闭）时这一行只是记录。 */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, ceiling)} />;
  if (onOpen === undefined) {
    return (
      <div data-testid="workflow-retune-row" data-workflow-retune-run-id={runId}>
        {row}
      </div>
    );
  }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer rounded-md px-1 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid="workflow-retune-row"
      data-workflow-retune-run-id={runId}
      onClick={onOpen}
      type="button"
    >
      {row}
    </button>
  );
}
