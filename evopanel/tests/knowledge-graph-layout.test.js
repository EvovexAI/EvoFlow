import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  computeNodeRadius,
  computePageRank,
  getNeighborRings,
  getNodeCategory,
  packClusterCenters,
  prepareForceGraphData,
  pruneEdges,
  truncateLabel,
} from "../src/lib/knowledge-graph-layout.js";

describe("knowledge-graph-layout", () => {
  it("detects known and path-segment categories", () => {
    expect(getNodeCategory({ path: "docs/guides/setup.md" })).toBe("guides");
    expect(getNodeCategory({ path: "projects/alpha/readme.md" })).toBe("projects");
    expect(getNodeCategory({ path: "orphan.md" })).toBe("default");
  });

  it("prunes edges with separate hub caps", () => {
    const links = [];
    for (let i = 0; i < 20; i++) {
      links.push({ source: "hub", target: `n${i}`, weight: i + 1 });
    }
    const kept = pruneEdges(links, {
      maxPerNode: 4,
      maxPerHub: 10,
      hubIds: new Set(["hub"]),
    });
    const hubDegree = kept.filter((l) => l.source === "hub" || l.target === "hub").length;
    expect(hubDegree).toBeLessThanOrEqual(10);
    expect(hubDegree).toBeGreaterThan(4);
  });

  it("sizes nodes with log degree and hub tier", () => {
    expect(computeNodeRadius(1, { degreeRank: 0.9 })).toBeGreaterThanOrEqual(7);
    expect(computeNodeRadius(1, { degreeRank: 0.9 })).toBeLessThanOrEqual(11);
    expect(computeNodeRadius(12, { isHub: true, degreeRank: 0 })).toBeGreaterThanOrEqual(20);
    expect(computeNodeRadius(12, { isHub: true, degreeRank: 0 })).toBeLessThanOrEqual(28);
  });

  it("packs clusters with stable separation", () => {
    const packed = packClusterCenters(
      [
        { id: "guides", count: 24, color: "#7C5CFC", label: "Guides" },
        { id: "tutorials", count: 12, color: "#E9A900", label: "Tutorials" },
        { id: "cases", count: 10, color: "#F07A3F", label: "Cases" },
      ],
      { gap: 140, seed: 42 }
    );
    expect(packed).toHaveLength(3);
    for (let i = 0; i < packed.length; i++) {
      for (let j = i + 1; j < packed.length; j++) {
        const d = Math.hypot(packed[i].cx - packed[j].cx, packed[i].cy - packed[j].cy);
        expect(d).toBeGreaterThanOrEqual(packed[i].radius + packed[j].radius + 100 - 1);
      }
    }
    const again = packClusterCenters(
      [
        { id: "guides", count: 24, color: "#7C5CFC", label: "Guides" },
        { id: "tutorials", count: 12, color: "#E9A900", label: "Tutorials" },
        { id: "cases", count: 10, color: "#F07A3F", label: "Cases" },
      ],
      { gap: 140, seed: 42 }
    );
    expect(again[0].cx).toBeCloseTo(packed[0].cx, 5);
  });

  it("builds island layout with category clusters", () => {
    const nodes = [
      { path: "guides/a.md", title: "A" },
      { path: "guides/b.md", title: "B" },
      { path: "cases/c.md", title: "C" },
      { path: "cases/d.md", title: "D" },
      { path: "tutorials/e.md", title: "E" },
    ];
    const edges = [
      { source: "guides/a.md", target: "guides/b.md" },
      { source: "guides/a.md", target: "cases/c.md" },
      { source: "guides/a.md", target: "cases/d.md" },
      { source: "guides/b.md", target: "cases/c.md" },
      { source: "tutorials/e.md", target: "guides/a.md" },
    ];
    const graph = prepareForceGraphData(nodes, edges, { edgeMode: "balanced", hubCount: 1 });
    expect(graph.clusters.length).toBeGreaterThanOrEqual(2);
    const hub = graph.nodes.find((n) => n.id === "guides/a.md");
    expect(hub.isHub).toBe(true);
    expect(hub.radius).toBeGreaterThanOrEqual(12);
    expect(graph.links.every((l) => typeof l.curvature === "number")).toBe(true);
  });

  it("builds 1st and 2nd neighbor rings", () => {
    const adj = buildAdjacency([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "d" },
    ]);
    const { rings, all } = getNeighborRings("a", adj, 2);
    expect(rings[1].has("b")).toBe(true);
    expect(rings[2].has("c")).toBe(true);
    expect(all.has("d")).toBe(false);
  });

  it("ranks denser nodes higher with pageRank", () => {
    const ids = ["a", "b", "c"];
    const pr = computePageRank(ids, [
      { source: "b", target: "a" },
      { source: "c", target: "a" },
    ]);
    expect(pr.get("a")).toBeGreaterThan(pr.get("b"));
  });

  it("truncates long labels", () => {
    expect(truncateLabel("abcdefghijklmnopqrstuvwxyz", 20).endsWith("…")).toBe(true);
  });
});
