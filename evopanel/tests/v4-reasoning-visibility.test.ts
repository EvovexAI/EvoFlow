import { describe, expect, it } from "vitest";
import {
  isConversationReasoningRowVisible,
  isTrivialReasoningText,
} from "../src/zcode-ui/v4/conversationRowContext.js";
import { shouldAutoCollapseReasoning } from "../src/zcode-ui/components/ai-elements/reasoning.js";

describe("V4 reasoning visibility", () => {
  it("unset messageStreamShowReasoning only keeps firstReasoningRowId", () => {
    // EvoFlow 旧宿主漏传该字段时的真实行为：后续思考全部被滤掉。
    expect(
      isConversationReasoningRowVisible(10, { messageStreamFirstReasoningRowId: 10 }),
    ).toBe(true);
    expect(
      isConversationReasoningRowVisible(11, { messageStreamFirstReasoningRowId: 10 }),
    ).toBe(false);
  });

  it("messageStreamShowReasoning=true keeps every reasoning row", () => {
    expect(
      isConversationReasoningRowVisible(10, {
        messageStreamShowReasoning: true,
        messageStreamFirstReasoningRowId: 10,
      }),
    ).toBe(true);
    expect(
      isConversationReasoningRowVisible(11, {
        messageStreamShowReasoning: true,
        messageStreamFirstReasoningRowId: 10,
      }),
    ).toBe(true);
  });

  it("always default-collapsed: complete boundary may auto-collapse", () => {
    // 思考卡不再跟「显示思考过程」自动展开；完成边界仍可收起，避免占版面。
    expect(
      shouldAutoCollapseReasoning({
        autoCollapseKey: null,
        previousAutoCollapseKey: null,
        userInteracted: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoCollapseReasoning({
        autoCollapseKey: "complete",
        previousAutoCollapseKey: null,
        userInteracted: false,
      }),
    ).toBe(true);
  });

  it("hides punctuation-only reasoning noise like trailing '.'", () => {
    expect(isTrivialReasoningText(".")).toBe(true);
    expect(isTrivialReasoningText("…")).toBe(true);
    expect(isTrivialReasoningText("  ")).toBe(true);
    expect(isTrivialReasoningText("网关已启动")).toBe(false);
  });
});
