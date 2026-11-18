import { describe, expect, it } from "vitest";
import {
  anchorActionAfterContentChange,
  reconcileFollowingForContentAnchor,
  timelineWheelScrollIntent,
} from "../src/zcode-ui/v4/timelineScrollAnchor.js";
import { TimelineRowHeightCache } from "../src/zcode-ui/v4/timelineRowHeightCache.js";

describe("V4 timeline scroll anchor (history upscroll)", () => {
  it("wheel awayFromBottom must release following even when content looks short", () => {
    // 估高偏矮时 scrollHeight≈clientHeight，「看似」不足一屏；上滚意图仍必须解除跟随。
    expect(timelineWheelScrollIntent(-40)).toBe("awayFromBottom");
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        metrics: { scrollTop: 0, viewportHeight: 615, contentHeight: 576 },
        lastObservedScrollTop: 0,
        userScrollIntent: "awayFromBottom",
      }),
    ).toBe(false);
    expect(anchorActionAfterContentChange(false)).toBe("hold");
  });

  it("cleared height cache falls back to estimate (reasoning layout epoch change)", () => {
    const cache = new TimelineRowHeightCache();
    cache.set("turn-a", 120);
    expect(cache.estimate("turn-a", 72)).toBe(120);
    cache.clear();
    expect(cache.estimate("turn-a", 72)).toBe(72);
  });
});
