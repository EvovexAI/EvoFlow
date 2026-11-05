import { describe, expect, it } from "vitest";
import {
  buildReadSummaries,
  coerceReadPathList,
} from "../src/zcode-ui/ToolCallBlocks/renderers/read.js";

describe("coerceReadPathList", () => {
  it("keeps a plain path string", () => {
    expect(coerceReadPathList("outputs/cliff_heroine.png")).toEqual([
      "outputs/cliff_heroine.png",
    ]);
  });

  it("expands a real path array", () => {
    expect(
      coerceReadPathList([
        "outputs/cliff_hero.png",
        "outputs/cliff_heroine.png",
      ]),
    ).toEqual(["outputs/cliff_hero.png", "outputs/cliff_heroine.png"]);
  });

  it("expands a JSON array string instead of basename-mangling the blob", () => {
    const blob = JSON.stringify([
      "outputs/cliff_hero.png",
      "outputs/cliff_heroine.png",
    ]);
    expect(coerceReadPathList(blob)).toEqual([
      "outputs/cliff_hero.png",
      "outputs/cliff_heroine.png",
    ]);
    expect(coerceReadPathList(blob).every((path) => !path.includes('"]'))).toBe(true);
  });

  it("best-effort extracts quoted paths from truncated streaming JSON arrays", () => {
    expect(
      coerceReadPathList('["outputs/cliff_hero.png", "outputs/cliff_heroine.png"'),
    ).toEqual(["outputs/cliff_hero.png", "outputs/cliff_heroine.png"]);
  });
});

describe("buildReadSummaries", () => {
  it("renders multiple image paths from read input.path array", () => {
    const summaries = buildReadSummaries({
      toolId: "tc-1",
      toolName: "read",
      kind: "read",
      input: {
        path: ["outputs/cliff_hero.png", "outputs/cliff_heroine.png"],
      },
      status: "completed",
      raw: {},
    });

    expect(summaries.map((summary) => summary.fileName)).toEqual([
      "cliff_hero.png",
      "cliff_heroine.png",
    ]);
  });

  it("renders multiple paths from view_image image_path JSON string", () => {
    const summaries = buildReadSummaries({
      toolId: "tc-2",
      toolName: "view_image",
      kind: "view_image",
      input: {
        image_path: '["a/pack-bloom.png","a/cliff_heroine.png"]',
      },
      status: "completed",
      raw: {},
    });

    expect(summaries.map((summary) => summary.fileName)).toEqual([
      "pack-bloom.png",
      "cliff_heroine.png",
    ]);
  });

  it("does not surface mangled basename ending with quote-bracket", () => {
    const summaries = buildReadSummaries({
      toolId: "tc-3",
      toolName: "read",
      kind: "read",
      input: {
        path: '["tmp/pack-forest.png","tmp/cliff_heroine.png"]',
      },
      status: "completed",
      raw: {},
    });

    expect(summaries.map((summary) => summary.fileName)).toEqual([
      "pack-forest.png",
      "cliff_heroine.png",
    ]);
    expect(summaries.some((summary) => summary.fileName.endsWith('"]'))).toBe(false);
  });
});
