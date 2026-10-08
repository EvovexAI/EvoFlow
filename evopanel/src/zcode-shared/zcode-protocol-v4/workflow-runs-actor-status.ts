// ============================================================
// actor 三态的**派生**（workflowRuns 归约的一条规则）
// ============================================================
// 纯函数，只从节点与 run 状态推导，不读取时钟或执行 I/O。
//
// 为什么必须派生：引擎的 Boundary C 除了 `actor-created` 之外**不发任何 actor 生命周期事件**，
// 所以「这个子代理在动吗、在等吗、干完了吗」没有事件可搬，只能由它名下节点的相位与 run 的
// 终态推出来。每一条改动了 nodes 或 run.status 的事件之后都要重跑一遍这个函数。

import type { WorkflowRunActor, WorkflowRunState } from "./workflow-runs.js";

/**
 * 键用 `\0` 连接而不是任何可打印字符：siteId 是引擎给的字符串，用 `-` 之类会让
 * ("a-1", 2) 与 ("a", "1-2") 撞车。（源码里写成转义 `\0` 而不是裸 NUL 字节——同一个运行时
 * 字符串，但文件不再是 grep 眼里的二进制。）
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

/**
 * 三态推导：
 *   running   有节点在 executing / repairing / nudged（模型请求已发出、正在跑）
 *   waiting   有 live 节点（queued / dispatched / waiting），或尚无任何节点且 run 未终态
 *   completed 其余：全部节点已结算，或 run 已终态（终态压过一切：一个终态 run 里没有任何人
 *             还在跑或在等，哪怕某个节点的 settled 事件没来得及落下）
 * `dispatched` 归 waiting 而不是 running：它是「会话就绪、首个请求尚未准入」的短暂相位，
 * 真正在跑由 node-executing 说。
 *
 * 状态没变的 actor 保持**引用不变**——键级增量按引用先判一遍"这条变了吗"，这里每次都造新对象
 * 会让每条节点事件都把整张 actors 表搬上线。
 */
export function withDerivedWorkflowActorStatuses(run: WorkflowRunState): WorkflowRunState {
  const executing = new Set<string>();
  const live = new Set<string>();
  const owned = new Set<string>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    owned.add(key);
    switch (node.phase) {
      case "executing":
      case "repairing":
      case "nudged":
        executing.add(key);
        break;
      case "queued":
      case "dispatched":
      case "waiting":
        live.add(key);
        break;
      default:
        break;
    }
  }
  const runLive = run.status === "pending" || run.status === "running";
  return {
    ...run,
    actors: run.actors.map((actor) => {
      const key = actorKey(actor.siteId, actor.ordinal);
      const status: WorkflowRunActor["status"] = !runLive
        ? "completed"
        : executing.has(key)
          ? "running"
          : live.has(key) || !owned.has(key)
            ? "waiting"
            : "completed";
      return actor.status === status ? actor : { ...actor, status };
    }),
  };
}
