import { describe, expect, it } from "vitest";
import {
  anchorActionAfterContentChange,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldTriggerLoadOlder,
  timelineWheelScrollIntent,
} from "../src/zcode-ui/v4/timelineScrollAnchor.js";
import { TimelineRowHeightCache } from "../src/zcode-ui/v4/timelineRowHeightCache.js";
import {
  classifyScrollTopVerdict,
  formatScrollTopVerdict,
} from "../src/react/v4/v4-viewport-scroll-tap.js";

describe("V4 timeline scroll anchor (history upscroll)", () => {
  it("following blocks loadOlder even when scrollTop sits in prefetch band (short soft-cap tail)", () => {
    // 现场：已显示~80/全量2000+，max scrollTop≈300 ≤ 2×视口，跟底中若仍预取
    // → loadOlder↔soft-cap↔scrollToBottom 死循环，发消息后最新不显示。
    expect(
      shouldTriggerLoadOlder({
        scrollTop: 302,
        canLoadOlder: true,
        loadingOlder: false,
        triggerPx: 1230,
        following: true,
      }),
    ).toBe(false);
    expect(
      shouldTriggerLoadOlder({
        scrollTop: 302,
        canLoadOlder: true,
        loadingOlder: false,
        triggerPx: 1230,
        following: false,
      }),
    ).toBe(true);
  });

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

  it("awayFromBottom scroll event must not re-pin following when height collapse clamps near bottom", () => {
    // 结束态上滚：未测高 turn 换入 → scrollHeight 塌缩 → 浏览器钳到贴底几何。
    // 若仍按 isAtBottom 恢复跟随，随后测高 stickToBottom 会把人拽回底部。
    const nearBottom = { scrollTop: 520, viewportHeight: 600, contentHeight: 1150 };
    expect(
      resolveFollowingAfterScroll({
        following: false,
        source: "user",
        userScrollIntent: "awayFromBottom",
        metrics: nearBottom,
      }),
    ).toBe(false);
    // 意图已过期的「假贴底」也不得自动恢复跟随。
    expect(
      resolveFollowingAfterScroll({
        following: false,
        source: "user",
        userScrollIntent: "none",
        metrics: nearBottom,
      }),
    ).toBe(false);
    // 用户明确向下滚回底部时才恢复。
    expect(
      resolveFollowingAfterScroll({
        following: false,
        source: "user",
        userScrollIntent: "towardBottom",
        metrics: nearBottom,
      }),
    ).toBe(true);
  });

  it("cleared height cache falls back to estimate (reasoning layout epoch change)", () => {
    const cache = new TimelineRowHeightCache();
    cache.set("turn-a", 120);
    expect(cache.estimate("turn-a", 72)).toBe(120);
    cache.clear();
    expect(cache.estimate("turn-a", 72)).toBe(72);
  });

  it("overlay top verdict distinguishes no-older vs can-autoload vs loading", () => {
    expect(
      classifyScrollTopVerdict({
        scrollTop: 0,
        clientHeight: 600,
        scrollHeight: 4000,
        hasOlder: false,
        loadingOlder: false,
        firstRowId: 1,
        windowFirstRowId: 1,
      }),
    ).toBe("geom_top_no_older");
    expect(
      classifyScrollTopVerdict({
        scrollTop: 0,
        clientHeight: 600,
        scrollHeight: 4000,
        hasOlder: true,
        loadingOlder: false,
        firstRowId: 1,
        windowFirstRowId: 200,
      }),
    ).toBe("geom_top_can_autoload");
    expect(
      classifyScrollTopVerdict({
        scrollTop: 0,
        clientHeight: 600,
        scrollHeight: 4000,
        hasOlder: true,
        loadingOlder: true,
        firstRowId: 1,
        windowFirstRowId: 200,
      }),
    ).toBe("geom_top_loading");
    expect(formatScrollTopVerdict("geom_top_no_older")).toContain("无更早");
  });
});
