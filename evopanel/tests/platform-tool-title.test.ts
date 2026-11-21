/**
 * 平台工具卡标题：对齐电脑控制 —— 中文 title 为主；有 title 不再叠摘要。
 */
import { describe, expect, it } from "vitest";
import {
  buildPlatformToolPrimaryText,
  readPlatformToolTitle,
} from "../src/zcode-ui/ToolCallBlocks/renderers/platform.js";

describe("platform tool title preference", () => {
  it("优先入参 title，其次 name", () => {
    expect(
      readPlatformToolTitle({
        action: "knowledge.ingest",
        args_json: JSON.stringify({ title: "英语大纲", content: "…" }),
      }),
    ).toBe("英语大纲");
    expect(
      readPlatformToolTitle({
        action: "knowledge.create",
        args_json: { name: "单词库" },
      }),
    ).toBe("单词库");
  });

  it("有中文 title 时 primary 只显示标题，并隐藏「平台」前缀", () => {
    const built = buildPlatformToolPrimaryText({
      action: "knowledge.ingest",
      input: {
        action: "knowledge.ingest",
        title: "写入英语大纲",
        args_json: JSON.stringify({ title: "英语大纲" }),
      },
    });
    expect(built.primaryText).toBe("写入英语大纲");
    expect(built.kindDetail).toBeUndefined();
    expect(built.hideKindLabel).toBe(true);
  });

  it("无 title 时回退中文动作短标签，不拼 op/method", () => {
    const built = buildPlatformToolPrimaryText({
      action: "ui.panel",
      input: {
        action: "ui.panel",
        args_json: JSON.stringify({ op: "cdp", method: "Runtime.evaluate" }),
      },
    });
    expect(built.primaryText).toMatch(/主窗口|控制/);
    expect(built.primaryText).not.toContain("Runtime.evaluate");
    expect(built.kindDetail).toBeUndefined();
  });

  it("与 action 同级的 title 优先于 args_json 内字段", () => {
    expect(
      readPlatformToolTitle({
        action: "ui.panel",
        title: "查看主界面字号",
        args_json: JSON.stringify({ op: "cdp", method: "Runtime.evaluate" }),
      }),
    ).toBe("查看主界面字号");
  });

  it("displayTitle 盖过入参", () => {
    expect(
      readPlatformToolTitle(
        { action: "x", args_json: JSON.stringify({ title: "入参标题" }) },
        { displayTitle: "结果标题" },
      ),
    ).toBe("结果标题");
  });

  it("结果 display.title 作主文案且不叠摘要", () => {
    const built = buildPlatformToolPrimaryText({
      action: "knowledge.ingest",
      input: { action: "knowledge.ingest", args_json: "{}" },
      displayTitle: "英语大纲",
    });
    expect(built.primaryText).toBe("英语大纲");
    expect(built.kindDetail).toBeUndefined();
  });
});
