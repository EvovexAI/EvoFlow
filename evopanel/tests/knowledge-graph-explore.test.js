import { describe, expect, it } from "vitest";
import {
  convexHull,
  findAllPaths,
  findShortestPath,
  freshnessTone,
  padHull,
  previewMarkdown,
} from "../src/lib/knowledge-graph-explore.js";
import { buildAdjacency } from "../src/lib/knowledge-graph-layout.js";

describe("knowledge-graph-explore", () => {
  it("finds shortest path", () => {
    const adj = buildAdjacency([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
    ]);
    expect(findShortestPath(adj, "a", "c")).toEqual(["a", "c"]);
    expect(findShortestPath(adj, "a", "d")).toEqual([]);
  });

  it("enumerates paths", () => {
    const adj = buildAdjacency([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
    ]);
    const paths = findAllPaths(adj, "a", "c", { maxDepth: 4, maxPaths: 10 });
    expect(paths.some((p) => p.length === 2)).toBe(true);
    expect(paths.some((p) => p.join() === "a,b,c")).toBe(true);
  });

  it("builds padded convex hull", () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ]);
    expect(hull.length).toBeGreaterThanOrEqual(4);
    const padded = padHull(hull, 20);
    expect(padded.length).toBe(hull.length);
  });

  it("maps freshness tones", () => {
    const now = Date.now();
    expect(freshnessTone(new Date(now - 2 * 86400000).toISOString(), now)).toBe("fresh");
    expect(freshnessTone(new Date(now - 20 * 86400000).toISOString(), now)).toBe("warm");
    expect(freshnessTone(new Date(now - 200 * 86400000).toISOString(), now)).toBe("stale");
  });

  it("previews markdown paragraphs", () => {
    const md = "Para one.\n\nPara two.\n\nPara three.\n\nPara four.";
    const preview = previewMarkdown(md, 3, 480);
    expect(preview.includes("Para one")).toBe(true);
    expect(preview.includes("Para four")).toBe(false);
  });
});
