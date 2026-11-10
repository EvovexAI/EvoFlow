import { describe, expect, it } from "vitest";
import {
  COMPACT_TIP_MESSAGE_COUNT,
  shouldShowCompactTip,
} from "../src/react/v4/ConversationCompactTipBanner.js";

describe("shouldShowCompactTip", () => {
  it("hides for short conversations", () => {
    expect(shouldShowCompactTip({ messageCount: 40, pct: 20 })).toBe(false);
    expect(shouldShowCompactTip({ messageCount: 199, pct: 40 })).toBe(false);
  });

  it("shows when message count crosses hundreds threshold", () => {
    expect(
      shouldShowCompactTip({ messageCount: COMPACT_TIP_MESSAGE_COUNT, pct: 10 }),
    ).toBe(true);
    expect(shouldShowCompactTip({ messageCount: 507, pct: 30 })).toBe(true);
  });

  it("shows for high context pct with enough messages", () => {
    expect(shouldShowCompactTip({ messageCount: 90, pct: 80 })).toBe(true);
    expect(shouldShowCompactTip({ messageCount: 20, pct: 90 })).toBe(false);
  });

  it("respects dismiss until count grows again", () => {
    expect(
      shouldShowCompactTip({
        messageCount: 220,
        pct: 40,
        dismissedAtCount: 210,
      }),
    ).toBe(false);
    expect(
      shouldShowCompactTip({
        messageCount: 320,
        pct: 40,
        dismissedAtCount: 210,
      }),
    ).toBe(true);
  });
});
