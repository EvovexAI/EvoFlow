/**
 * Control-first 会话 busy 判定（生命周期四件套第 1 件 / Phase C）单元测试。
 *
 * 契约：control.canStop 是权威（宿主 idle 不否决）；control 终态 + 宿主 idle
 * 直接收口（压陈旧 running 卡）；control 缺失/draft/落后帧回退行扫描 heuristic
 * （与旧实现 resolveLiveExecutionBusyFromSnapshot 逐字段等价）。
 *
 * 运行：npx vitest run tests/control-busy.test.ts
 */
import { describe, expect, it } from "vitest";
import { resolveSessionBusyFromControl } from "../src/react/v4/control-busy.js";
import { resolveLiveExecutionBusyFromSnapshot } from "../src/zcode-ui/v4/live-execution-busy.js";

type Row = { kind?: string; status?: string; state?: string };

function snap(overrides: {
  control?: { canStop?: boolean; phase?: string } | null;
  rows?: Row[];
  backgroundWorks?: { status?: string; kind?: string }[];
}): Record<string, unknown> {
  return {
    control: overrides.control ?? null,
    rows: { window: overrides.rows ?? [] },
    backgroundWorks: overrides.backgroundWorks ?? [],
  };
}

const STREAMING_TEXT: Row = { kind: "assistantText", state: "streaming" };
const RUNNING_TOOL: Row = { kind: "toolCall", status: "running" };
const SEALED_TOOL: Row = { kind: "toolCall", status: "success" };

describe("resolveSessionBusyFromControl — control-first 层级", () => {
  it("① canStop=true → busy（宿主 idle 不否决——旧实现的关键差异）", () => {
    const s = snap({ control: { canStop: true, phase: "running" } });
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: false })).toBe(true);
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: true })).toBe(true);
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: null })).toBe(true);
  });

  it("① canStop=true 且行全收口 → 仍 busy（运行中空档：模型思考期无流式行）", () => {
    // 旧 heuristic：无 streaming 行/活工具 + canStop 被宿主 idle 否决 → false（齿轮早灭）。
    // control-first：模型在跑就是 running。
    const s = snap({
      control: { canStop: true, phase: "running" },
      rows: [SEALED_TOOL],
    });
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: false })).toBe(true);
  });

  it("② control 终态 + 宿主 idle → false（压 FINISHED 后陈旧 running 卡）", () => {
    for (const phase of ["completedSuccess", "completedInterrupted", "error"]) {
      const s = snap({
        control: { canStop: false, phase },
        rows: [RUNNING_TOOL, STREAMING_TEXT],
      });
      expect(resolveSessionBusyFromControl(s as never, { hostExecuting: false })).toBe(false);
    }
  });

  it("② control 终态但宿主在跑 → 保持 heuristic 并集（不单方面收口）", () => {
    const s = snap({
      control: { canStop: false, phase: "completedSuccess" },
      rows: [RUNNING_TOOL],
    });
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: true })).toBe(true);
  });

  it("③ control 缺失 / phase=draft / canStop 非布尔 → heuristic 兜底（与旧实现等价）", () => {
    const legacy = snap({
      control: { canStop: false, phase: "draft" },
      rows: [STREAMING_TEXT],
    });
    // Phase A 之前的快照形状：draft+canStop=false 落 heuristic
    expect(resolveSessionBusyFromControl(legacy as never, { hostExecuting: false })).toBe(
      resolveLiveExecutionBusyFromSnapshot(legacy as never, undefined, { hostExecuting: false }),
    );
    expect(resolveSessionBusyFromControl(legacy as never, { hostExecuting: false })).toBe(true);

    const noControl = snap({ control: null, rows: [STREAMING_TEXT] });
    expect(resolveSessionBusyFromControl(noControl as never, { hostExecuting: null })).toBe(
      resolveLiveExecutionBusyFromSnapshot(noControl as never, undefined, { hostExecuting: null }),
    );

    expect(resolveSessionBusyFromControl(null as never, { hostExecuting: true })).toBe(false);
  });

  it("③ 落后帧（canStop=false 非终态）回退 heuristic：streaming 行仍保活", () => {
    const s = snap({
      control: { canStop: false, phase: "prewarming" },
      rows: [STREAMING_TEXT],
    });
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: true })).toBe(true);
  });

  it("backgroundWorks 照旧计入（workflow/collab 除外，vendor 语义不变）", () => {
    const s = snap({
      control: { canStop: false, phase: "completedSuccess" },
      backgroundWorks: [{ status: "running", kind: "bash" }],
    });
    expect(resolveSessionBusyFromControl(s as never, { hostExecuting: false })).toBe(true);

    const wf = snap({
      control: { canStop: false, phase: "completedSuccess" },
      backgroundWorks: [{ status: "running", kind: "workflow" }],
    });
    expect(resolveSessionBusyFromControl(wf as never, { hostExecuting: false })).toBe(false);
  });
});
