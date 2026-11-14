/**
 * Control-first 会话 busy 判定（生命周期四件套第 1 件 / Phase C，对齐 ZCode
 * `isRunning = snapshot.control.canStop`，SessionPane.tsx:1706）。
 *
 * 层级：
 * 1. control.canStop=true → running（**权威**）。宿主 wire 状态（hostExecuting）
 *    只是并集因子，不再否决 canStop——旧实现传 hostExecuting 后 vendor 分支
 *    `canStop && !hostIdle` 把 control 降级成参考，根因是 Phase A 之前快照
 *    control 与增量不同源（刷新/恢复拿到 draft+canStop:false）。后端
 *    set_control_override 落地后 control 可信，枷锁解除。
 * 2. control 终态（completedSuccess/completedInterrupted/error）且宿主 idle →
 *    确定 idle。压 FINISHED 后迟到未收口的 running 工具卡（RESULT 迟到的
 *    陈旧投影）；control 终态 patch 与行 seal 同帧批落盘，无语义窗口。
 * 3. 其余（control 缺失 / phase=draft / 落后帧）→ 行扫描 heuristic 兜底
 *    （resolveLiveExecutionBusyFromSnapshot，vendor 树原样复用，本文件不改 vendor）。
 *
 * 上线顺序安全：后端 Phase A 未上时老快照 draft+canStop=false 落分支 3，
 * 行为与旧实现一致；后端先上则前端未切也只差分支 1/2 的收益。
 *
 * 调用方仍需保留否决位（recovery cooldown / uiTurnSettled）：它们防的是
 * 「用户点停后投影终态晚一拍」，第 2 件（stop 命令面统一）落地前不可删。
 */

import {
  countRunningBackgroundWorks,
  isTerminalControlPhase,
  resolveLiveExecutionBusyFromSnapshot,
} from "../../zcode-ui/v4/live-execution-busy.js";

type ControlBusySnapshot = Parameters<typeof resolveLiveExecutionBusyFromSnapshot>[0];

export function resolveSessionBusyFromControl(
  snapshot: ControlBusySnapshot,
  opts: { hostExecuting?: boolean | null } = {},
): boolean {
  const control = (snapshot as { control?: { canStop?: boolean; phase?: string } | null } | null)
    ?.control;
  const canStop =
    control && typeof control.canStop === "boolean" ? !!control.canStop : null;
  if (canStop !== null) {
    // ① 权威 running：control 说在跑就是在跑（宿主 idle 不否决——宿主晚关的
    //    SSE / 误关的 turnPhase 都该被投影纠正）。
    if (canStop) return true;
    // 后台活优先于收口（vendor 语义：workflow/collab 除外）——② 不得短路它。
    const bgWorks = (
      snapshot as { backgroundWorks?: readonly { status?: string; kind?: string }[] | null } | null
    )?.backgroundWorks;
    if (countRunningBackgroundWorks(bgWorks) > 0) {
      return true;
    }
    // ② 权威终态 + 宿主 idle：确定收口，陈旧 running 卡不再钉齿轮/停止键。
    if (opts.hostExecuting === false && isTerminalControlPhase(control?.phase)) {
      return false;
    }
    // ③ canStop=false 且非终态（draft / 落后帧）：交给 heuristic。
  }
  return resolveLiveExecutionBusyFromSnapshot(snapshot, undefined, {
    hostExecuting: opts.hostExecuting,
  });
}
