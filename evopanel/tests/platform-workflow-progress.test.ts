import { describe, expect, it } from "vitest";
import {
  isPlatformWorkflowProgressAction,
  mapTaskStatusToWorkflowCardStatus,
  readPlatformWorkflowProgressRef,
  workflowCardKindMessageId,
} from "../src/zcode-ui/ToolCallBlocks/renderers/platformWorkflowProgress.js";

describe("isPlatformWorkflowProgressAction", () => {
  it("accepts run family only", () => {
    expect(isPlatformWorkflowProgressAction("workflow.run")).toBe(true);
    expect(isPlatformWorkflowProgressAction("workflow.resume")).toBe(true);
    expect(isPlatformWorkflowProgressAction("workflow.recover")).toBe(true);
    expect(isPlatformWorkflowProgressAction("workflow.run_status")).toBe(true);
    expect(isPlatformWorkflowProgressAction("workflow.create")).toBe(false);
    expect(isPlatformWorkflowProgressAction("tasks.create")).toBe(false);
  });
});

describe("readPlatformWorkflowProgressRef", () => {
  it("returns null without task id", () => {
    expect(
      readPlatformWorkflowProgressRef({
        action: "workflow.run",
        raw: { rawOutput: JSON.stringify({ ok: true, appId: "App_1" }) },
      }),
    ).toBeNull();
  });

  it("reads mainTaskId from platform_ui openStage", () => {
    const ref = readPlatformWorkflowProgressRef({
      action: "workflow.run",
      raw: {
        display: {
          kind: "platform_ui",
          schemaVersion: 1,
          action: "workflow.run",
          title: "工作流能力指南与演示",
          actions: [
            {
              label: "打开工作流",
              autoOpen: true,
              openStage: {
                kind: "collab-workflow",
                title: "工作流能力指南与演示",
                data: { mainTaskId: "task_abc" },
              },
            },
          ],
        },
        rawOutput: JSON.stringify({
          ok: true,
          task_id: "task_abc",
          runId: "Run_1",
          appId: "App_x",
          name: "工作流能力指南与演示",
        }),
      },
    });
    expect(ref).toEqual({
      mainTaskId: "task_abc",
      name: "工作流能力指南与演示",
      runId: "Run_1",
      appId: "App_x",
    });
  });

  it("falls back to body task_id + app name", () => {
    const ref = readPlatformWorkflowProgressRef({
      action: "workflow.resume",
      raw: {
        rawOutput: JSON.stringify({
          ok: true,
          task_id: "T99",
          run_id: "R2",
          app: { id: "App_y", name: "日报汇总" },
        }),
      },
    });
    expect(ref?.mainTaskId).toBe("T99");
    expect(ref?.name).toBe("日报汇总");
    expect(ref?.runId).toBe("R2");
    expect(ref?.appId).toBe("App_y");
  });

  it("accepts collab-workflow openStage even when input action is empty (V4 display-only)", () => {
    const ref = readPlatformWorkflowProgressRef({
      action: "",
      raw: {
        display: {
          kind: "platform_ui",
          schemaVersion: 1,
          action: "workflow.run",
          title: "结构化产出契约",
          actions: [
            {
              label: "打开工作流",
              autoOpen: true,
              openStage: {
                kind: "collab-workflow",
                title: "结构化产出契约",
                data: { mainTaskId: "2611121107_2b9f" },
              },
            },
          ],
        },
        rawOutput: JSON.stringify({ ok: true, task_id: "2611121107_2b9f" }),
      },
    });
    expect(ref?.mainTaskId).toBe("2611121107_2b9f");
    expect(ref?.name).toBe("结构化产出契约");
  });

  it("accepts collab-workflow openStage without workflow.* action (same as right-stage autoOpen)", () => {
    const ref = readPlatformWorkflowProgressRef({
      action: "tasks.create",
      raw: {
        rawOutput: JSON.stringify({
          ok: true,
          task_id: "T1",
          ui: {
            actions: [
              {
                label: "查看",
                autoOpen: true,
                openStage: { kind: "collab-workflow", data: { mainTaskId: "T1" } },
              },
            ],
          },
        }),
      },
    });
    expect(ref?.mainTaskId).toBe("T1");
  });
});

describe("mapTaskStatusToWorkflowCardStatus", () => {
  it("maps unified statuses", () => {
    expect(mapTaskStatusToWorkflowCardStatus("pending")).toBe("pending");
    expect(mapTaskStatusToWorkflowCardStatus("in_progress")).toBe("running");
    expect(mapTaskStatusToWorkflowCardStatus("completed")).toBe("completed");
    expect(mapTaskStatusToWorkflowCardStatus("failed")).toBe("errored");
    expect(mapTaskStatusToWorkflowCardStatus("cancelled")).toBe("stopped");
  });

  it("maps kind message ids", () => {
    expect(workflowCardKindMessageId("completed")).toBe("chat.toolCall.workflow.card.completed");
    expect(workflowCardKindMessageId("running")).toBe("chat.toolCall.workflow.card.running");
    expect(workflowCardKindMessageId("pending")).toBe("chat.toolCall.workflow.card.started");
  });
});
