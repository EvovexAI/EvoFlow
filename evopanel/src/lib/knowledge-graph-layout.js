/**
 * Knowledge graph layout — two-level cluster packing + community detection.
 * Obsidian / Neo4j Bloom inspired; stable seeded placement.
 */

export const KNOWN_CATEGORY_COLORS = {
  "getting-started": "#4F8EF7",
  guides: "#7C5CFC",
  tutorials: "#E9A900",
  explanation: "#20B982",
  cases: "#F07A3F",
  meta: "#8492A6",
  default: "#94A3B8",
};

export const CATEGORY_LABELS = {
  "getting-started": "Getting Started",
  guides: "Guides",
  tutorials: "Tutorials",
  explanation: "Explanation",
  cases: "Cases",
  meta: "Meta",
  default: "Other",
};

const DYNAMIC_PALETTE = [
  "#5B9FD4",
  "#C47AB0",
  "#6BAE6B",
  "#D4886A",
  "#7A8FBF",
  "#A08CC8",
  "#5AAD9A",
  "#C9A05C",
];

const KNOWN_CATEGORIES = [
  "getting-started",
  "guides",
  "tutorials",
  "explanation",
  "cases",
  "meta",
];

const CORE_NAME_HINTS = [
  "installation",
  "product-overview",
  "agent-system",
  "overview",
  "getting-started",
  "introduction",
  "readme",
  "index",
];

export const EDGE_STRENGTH_PRESETS = {
  sparse: { maxPerNode: 3, maxPerHub: 8, label: "精简" },
  balanced: { maxPerNode: 4, maxPerHub: 10, label: "平衡" },
  full: { maxPerNode: 999, maxPerHub: 999, label: "完整" },
};

export function hashString(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic [0,1) from seed + salt */
export function seededUnit(seed, salt = "") {
  const h = hashString(`${seed}::${salt}`);
  return (h % 100000) / 100000;
}

export function seededSigned(seed, salt = "") {
  return seededUnit(seed, salt) - 0.5;
}

export function formatCategoryLabel(category) {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return String(category || "Other")
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export function getNodeCategory(node) {
  if (node?.community != null && node.community !== "") {
    return String(node.community);
  }
  if (node?.category && KNOWN_CATEGORIES.includes(String(node.category).toLowerCase())) {
    return String(node.category).toLowerCase();
  }
  const path = String(node?.path || node?.id || "")
    .toLowerCase()
    .replace(/\\/g, "/");
  for (const cat of KNOWN_CATEGORIES) {
    if (path.includes(cat)) return cat;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 1) return parts[0];
  return "default";
}

export function getCategoryColor(category, colorCache = null) {
  const key = String(category || "default").toLowerCase();
  if (KNOWN_CATEGORY_COLORS[key]) return KNOWN_CATEGORY_COLORS[key];
  if (colorCache?.has(key)) return colorCache.get(key);
  const color = DYNAMIC_PALETTE[hashString(key) % DYNAMIC_PALETTE.length];
  colorCache?.set(key, color);
  return color;
}

export function isCoreNodeName(name) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/\.(md|mdx)$/, "");
  return CORE_NAME_HINTS.some((h) => n === h || n.includes(h));
}

export function truncateLabel(text, max = 20) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function computePageRank(nodeIds, links, { damping = 0.85, iterations = 24 } = {}) {
  const n = nodeIds.length;
  if (n === 0) return new Map();
  const idSet = new Set(nodeIds);
  const scores = new Map(nodeIds.map((id) => [id, 1 / n]));
  const outDegree = new Map(nodeIds.map((id) => [id, 0]));
  const inbound = new Map(nodeIds.map((id) => [id, []]));

  for (const link of links) {
    const [s, t] = linkEndpoints(link);
    if (!idSet.has(s) || !idSet.has(t) || s === t) continue;
    outDegree.set(s, (outDegree.get(s) || 0) + 1);
    inbound.get(t).push(s);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map();
    let dangling = 0;
    for (const id of nodeIds) {
      if ((outDegree.get(id) || 0) === 0) dangling += scores.get(id) || 0;
    }
    for (const id of nodeIds) {
      let sum = 0;
      for (const src of inbound.get(id) || []) {
        sum += (scores.get(src) || 0) / (outDegree.get(src) || 1);
      }
      next.set(id, (1 - damping) / n + damping * (sum + dangling / n));
    }
    for (const id of nodeIds) scores.set(id, next.get(id));
  }
  return scores;
}

export function computeDegreeMap(links) {
  const degree = new Map();
  for (const link of links) {
    const [s, t] = linkEndpoints(link);
    if (s == null || t == null || s === t) continue;
    degree.set(s, (degree.get(s) || 0) + 1);
    degree.set(t, (degree.get(t) || 0) + 1);
  }
  return degree;
}

export function linkEndpoints(link) {
  const s = typeof link.source === "object" ? link.source.id : link.source;
  const t = typeof link.target === "object" ? link.target.id : link.target;
  return [s, t];
}

/**
 * Lightweight Louvain (single-pass modularity) for undirected graphs.
 */
export function louvainCommunities(nodeIds, links) {
  const n = nodeIds.length;
  if (n === 0) return new Map();

  const index = new Map(nodeIds.map((id, i) => [id, i]));
  const community = nodeIds.map((_, i) => i);
  const adj = Array.from({ length: n }, () => new Map());
  let m2 = 0;

  for (const link of links) {
    const [s, t] = linkEndpoints(link);
    if (!index.has(s) || !index.has(t) || s === t) continue;
    const i = index.get(s);
    const j = index.get(t);
    const w = Number(link.weight) || 1;
    adj[i].set(j, (adj[i].get(j) || 0) + w);
    adj[j].set(i, (adj[j].get(i) || 0) + w);
    m2 += w * 2;
  }
  if (m2 <= 0) return new Map(nodeIds.map((id, i) => [id, `c${i}`]));

  const degree = adj.map((row) => {
    let s = 0;
    for (const w of row.values()) s += w;
    return s;
  });

  let improved = true;
  let guard = 0;
  while (improved && guard < 20) {
    improved = false;
    guard += 1;
    for (let i = 0; i < n; i++) {
      const neighWeight = new Map();
      for (const [j, w] of adj[i]) {
        const c = community[j];
        neighWeight.set(c, (neighWeight.get(c) || 0) + w);
      }
      const cur = community[i];
      let best = cur;
      let bestDelta = 0;
      const ki = degree[i];
      for (const [c, kiin] of neighWeight) {
        let tot = 0;
        for (let k = 0; k < n; k++) if (community[k] === c) tot += degree[k];
        if (c === cur) tot -= ki;
        const delta = kiin - (tot * ki) / m2;
        if (delta > bestDelta) {
          bestDelta = delta;
          best = c;
        }
      }
      if (best !== cur && bestDelta > 1e-9) {
        community[i] = best;
        improved = true;
      }
    }
  }

  const remap = new Map();
  let next = 0;
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (!remap.has(c)) remap.set(c, `community-${next++}`);
    out.set(nodeIds[i], remap.get(c));
  }
  return out;
}

/**
 * Edge prune with separate caps for hubs vs normal nodes.
 */
export function pruneEdges(links, { maxPerNode = 4, maxPerHub = 10, hubIds = null } = {}) {
  if (!links?.length) return [];
  const hubs = hubIds instanceof Set ? hubIds : new Set(hubIds || []);

  const scored = links.map((link, idx) => {
    const [s, t] = linkEndpoints(link);
    const weight = Number(link.weight) || 1;
    const affinity = hashString(`${s}|${t}`) % 7;
    return { link, s, t, score: weight * 10 + affinity, idx };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const keptCount = new Map();
  const kept = [];
  const seen = new Set();
  const capFor = (id) => (hubs.has(id) ? maxPerHub : maxPerNode);

  for (const item of scored) {
    if (item.s == null || item.t == null || item.s === item.t) continue;
    const key = item.s < item.t ? `${item.s}::${item.t}` : `${item.t}::${item.s}`;
    if (seen.has(key)) continue;
    const cs = keptCount.get(item.s) || 0;
    const ct = keptCount.get(item.t) || 0;
    if (cs >= capFor(item.s) && ct >= capFor(item.t)) continue;
    if (cs >= capFor(item.s) && !hubs.has(item.t)) continue;
    if (ct >= capFor(item.t) && !hubs.has(item.s)) continue;
    seen.add(key);
    kept.push({
      ...item.link,
      source: item.s,
      target: item.t,
      weight: item.score,
    });
    keptCount.set(item.s, cs + 1);
    keptCount.set(item.t, ct + 1);
  }
  return kept;
}

export function buildAdjacency(links) {
  const adj = new Map();
  const ensure = (id) => {
    if (!adj.has(id)) adj.set(id, new Set());
    return adj.get(id);
  };
  for (const link of links) {
    const [s, t] = linkEndpoints(link);
    if (s == null || t == null || s === t) continue;
    ensure(s).add(t);
    ensure(t).add(s);
  }
  return adj;
}

export function getNeighborRings(nodeId, adjacency, depth = 2) {
  const rings = [new Set([nodeId])];
  const visited = new Set([nodeId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const id of rings[d]) {
      for (const n of adjacency.get(id) || []) {
        if (visited.has(n)) continue;
        visited.add(n);
        next.add(n);
      }
    }
    rings.push(next);
  }
  return { rings, all: visited };
}

/**
 * nodeSize = base + log(1+degree)*scale → tiered radii.
 */
export function computeNodeRadius(degree, { isHub = false, isCenter = false, degreeRank = 0.5 } = {}) {
  const base = 8;
  const raw = base + Math.log1p(Math.max(0, degree)) * 3.4;
  const maxAllowed = base * 3; // 24, hubs may reach 28
  if (isHub || isCenter || degreeRank <= 0.1) {
    return Math.min(28, Math.max(20, Math.min(maxAllowed + 4, raw * 1.2)));
  }
  if (degreeRank <= 0.35 || degree >= 5) {
    return Math.min(17, Math.max(12, raw));
  }
  return Math.min(11, Math.max(7, raw));
}

/**
 * Circle-pack cluster centers with min gap 100–180px. Stable under seed.
 */
export function packClusterCenters(clusters, { gap = 140, seed = 1 } = {}) {
  const items = clusters.map((c, i) => {
    const count = Math.max(1, c.count || 1);
    const radius = Math.max(70, Math.sqrt(count) * 42 + 28);
    return {
      ...c,
      radius,
      // stable initial ring placement
      angle: (i / Math.max(clusters.length, 1)) * Math.PI * 2 + seededSigned(seed, `ang-${c.id}`) * 0.2,
      orbit: 0,
    };
  });

  // Estimate ring radius so islands don't overlap
  let orbit = 0;
  if (items.length === 1) {
    items[0].cx = 0;
    items[0].cy = 0;
  } else {
    const maxR = Math.max(...items.map((c) => c.radius));
    orbit = maxR + gap + 40;
    // Grow orbit until pairwise separation satisfied on ring
    for (let pass = 0; pass < 8; pass++) {
      let ok = true;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const ai = items[i].angle;
          const aj = items[j].angle;
          const d = 2 * orbit * Math.sin(Math.abs(ai - aj) / 2);
          const need = items[i].radius + items[j].radius + gap;
          if (d < need) ok = false;
        }
      }
      if (ok) break;
      orbit *= 1.12;
    }
    for (const c of items) {
      c.cx = Math.cos(c.angle) * orbit;
      c.cy = Math.sin(c.angle) * orbit;
    }
  }

  // Iterative repulsion for residual overlaps
  for (let iter = 0; iter < 40; iter++) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;
        let dist = Math.hypot(dx, dy) || 0.01;
        const need = a.radius + b.radius + gap;
        if (dist < need) {
          const push = ((need - dist) / 2) * 0.55;
          dx /= dist;
          dy /= dist;
          a.cx -= dx * push;
          a.cy -= dy * push;
          b.cx += dx * push;
          b.cy += dy * push;
        }
      }
    }
  }

  return items;
}

/**
 * Assign nodes into knowledge islands and initial positions (stable seed).
 */
export function assignIslandLayout(nodes, {
  seed = 1,
  centerPath = null,
  hubIds = null,
  islandGap = 140,
} = {}) {
  const hubs = hubIds instanceof Set ? hubIds : new Set(hubIds || []);
  const byCluster = new Map();
  for (const n of nodes) {
    const key = n.clusterId || n.category || "default";
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(n);
  }

  const clusterList = [...byCluster.entries()]
    .map(([id, members]) => ({
      id,
      count: members.length,
      color: members[0]?.color || getCategoryColor(id),
      label: formatCategoryLabel(id),
    }))
    .sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)));

  const packed = packClusterCenters(clusterList, { gap: islandGap, seed });
  const packMap = new Map(packed.map((c) => [c.id, c]));

  for (const [cid, members] of byCluster) {
    const island = packMap.get(cid);
    const cx = island?.cx || 0;
    const cy = island?.cy || 0;
    const rMax = (island?.radius || 100) * 0.72;

    members.forEach((node, i) => {
      const angle = (i / Math.max(members.length, 1)) * Math.PI * 2 + seededSigned(seed, node.id) * 0.5;
      const rr = rMax * (0.2 + Math.abs(seededSigned(seed, `${node.id}-r`)) * 0.75);
      node.clusterId = cid;
      node.clusterX = cx + Math.cos(angle) * rr;
      node.clusterY = cy + Math.sin(angle) * rr;
      node.islandCx = cx;
      node.islandCy = cy;
      node.islandRadius = island?.radius || 100;
      node.isHub = hubs.has(node.id);
      node.isCenter = Boolean(centerPath && node.id === centerPath);

      // Hubs stay near island center (not global origin) so islands stay intact
      if (node.isCenter) {
        node.x = cx;
        node.y = cy;
        node.fx = cx;
        node.fy = cy;
      } else if (node.isHub) {
        const ha = seededUnit(seed, `${node.id}-h`) * Math.PI * 2;
        node.x = cx + Math.cos(ha) * 18;
        node.y = cy + Math.sin(ha) * 18;
        node.fx = undefined;
        node.fy = undefined;
      } else {
        node.x = node.clusterX;
        node.y = node.clusterY;
        node.fx = undefined;
        node.fy = undefined;
      }
    });
  }

  return {
    clusters: packed.map((c) => ({
      id: c.id,
      label: c.label,
      color: c.color,
      count: c.count,
      cx: c.cx,
      cy: c.cy,
      radius: c.radius,
    })),
  };
}

function annotateLinks(links, nodeById) {
  const pairCount = new Map();
  for (const link of links) {
    const [s, t] = linkEndpoints(link);
    const key = s < t ? `${s}::${t}` : `${t}::${s}`;
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }
  const pairIdx = new Map();
  for (const link of links) {
    const [s, t] = linkEndpoints(link);
    const key = s < t ? `${s}::${t}` : `${t}::${s}`;
    const idx = pairIdx.get(key) || 0;
    pairIdx.set(key, idx + 1);
    const total = pairCount.get(key) || 1;
    const ns = nodeById.get(s);
    const nt = nodeById.get(t);
    link.crossCluster = Boolean(ns && nt && ns.clusterId !== nt.clusterId);
    // Fan multi-edges / bidirectional stagger
    const bend = ((hashString(`${s}->${t}`) % 9) - 4) * 0.03;
    const multi = total > 1 ? (idx - (total - 1) / 2) * 0.08 : 0;
    link.curvature = (link.crossCluster ? 0.18 : 0.1) + bend + multi;
  }
}

/**
 * @param {'sparse'|'balanced'|'full'} edgeMode
 */
export function prepareForceGraphData(rawNodes, rawEdges, {
  edgeMode = "balanced",
  compact = false,
  centerPath = null,
  hubCount = 3,
  layoutSeed = null,
  showAllEdges = false,
} = {}) {
  const colorCache = new Map();
  const contentSeed =
    layoutSeed != null
      ? layoutSeed
      : hashString(
          (rawNodes || [])
            .map((n) => n.path || n.id)
            .sort()
            .join("|")
        );

  const nodes = (rawNodes || []).map((n) => {
    const id = n.path || n.id;
    const category = getNodeCategory(n);
    return {
      id,
      ...n,
      name: n.title || n.path?.split(/[/\\]/).pop() || n.id,
      category,
      clusterId: category,
      color: getCategoryColor(category, colorCache),
      radius: 8,
      val: 4,
      degree: 0,
      pageRank: 0,
      degreeRank: 1,
      isCore: false,
    };
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const rawLinks = (rawEdges || [])
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
    .map((e) => ({
      source: e.source,
      target: e.target,
      weight: Number(e.weight) || 1,
      type: e.type || "wikilink",
    }));

  // Prefer path categories; fall back to Louvain when categories collapse
  const catSet = new Set(nodes.map((n) => n.category));
  const meaningfulCats = [...catSet].filter((c) => c !== "default");
  if (meaningfulCats.length < 2 && nodes.length >= 8) {
    const communities = louvainCommunities(
      nodes.map((n) => n.id),
      rawLinks
    );
    for (const n of nodes) {
      const cid = communities.get(n.id) || n.category;
      n.clusterId = cid;
      n.color = getCategoryColor(cid.startsWith("community-") ? n.category : cid, colorCache);
    }
  } else {
    for (const n of nodes) n.clusterId = n.category;
  }

  const fullDegree = computeDegreeMap(rawLinks);
  const ranked = [...nodes].sort(
    (a, b) => (fullDegree.get(b.id) || 0) - (fullDegree.get(a.id) || 0)
  );
  const hubIds = new Set();
  if (centerPath) hubIds.add(centerPath);
  const autoHubs = Math.min(
    Math.max(hubCount, 3),
    Math.max(3, Math.ceil(nodes.length * 0.12))
  );
  for (const n of ranked.slice(0, autoHubs)) hubIds.add(n.id);

  const preset = EDGE_STRENGTH_PRESETS[edgeMode] || EDGE_STRENGTH_PRESETS.balanced;
  const links =
    showAllEdges || edgeMode === "full"
      ? rawLinks.map((l) => ({ ...l }))
      : pruneEdges(rawLinks, {
          maxPerNode: compact ? Math.min(3, preset.maxPerNode) : preset.maxPerNode,
          maxPerHub: compact ? Math.min(8, preset.maxPerHub) : preset.maxPerHub,
          hubIds,
        });

  const degreeMap = computeDegreeMap(links.length ? links : rawLinks);
  const pageRank = computePageRank(
    nodes.map((n) => n.id),
    links.length ? links : rawLinks
  );

  const degSorted = [...nodes].sort(
    (a, b) => (degreeMap.get(b.id) || 0) - (degreeMap.get(a.id) || 0)
  );
  const rankOf = new Map(degSorted.map((n, i) => [n.id, i / Math.max(nodes.length - 1, 1)]));

  for (const n of nodes) {
    n.degree = degreeMap.get(n.id) || fullDegree.get(n.id) || 0;
    n.pageRank = pageRank.get(n.id) || 0;
    n.degreeRank = rankOf.get(n.id) ?? 1;
    n.isHub = hubIds.has(n.id);
    n.isCore = isCoreNodeName(n.name) || isCoreNodeName(n.path);
    n.radius = computeNodeRadius(n.degree, {
      isHub: n.isHub,
      isCenter: centerPath && n.id === centerPath,
      degreeRank: n.degreeRank,
    });
    n.val = n.radius / 2;
    if (centerPath && n.id === centerPath) {
      n.isCenter = true;
      n.color = "#E86B8A";
    }
  }

  const { clusters } = assignIslandLayout(nodes, {
    seed: contentSeed,
    centerPath,
    hubIds,
    islandGap: compact ? 110 : 150,
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  annotateLinks(links, nodeById);

  const adjacency = buildAdjacency(links);
  const fullAdjacency = buildAdjacency(rawLinks);

  const legend = clusters.map((c) => ({
    category: c.id,
    label: c.label,
    color: c.color,
    count: c.count,
  }));

  return {
    nodes,
    links,
    allLinks: rawLinks,
    adjacency,
    fullAdjacency,
    clusters,
    legend,
    hubIds,
    layoutSeed: contentSeed,
    edgeMode,
    stats: {
      nodeCount: nodes.length,
      edgeCount: links.length,
      rawEdgeCount: rawLinks.length,
      pruned: Math.max(0, rawLinks.length - links.length),
    },
  };
}

/** Force presets — slower decay so islands fully expand */
export function getForcePreset(mode = "explorer") {
  if (mode === "compact") {
    return {
      linkDistance: (link) => (link.crossCluster ? 200 : 90),
      linkStrength: (link) => (link.crossCluster ? 0.05 : 0.55),
      chargeStrength: -380,
      collidePad: 12,
      clusterStrength: 0.22,
      islandRepel: 0.04,
      centerStrength: 0.015,
      alphaDecay: 0.012,
      velocityDecay: 0.32,
      warmupTicks: 60,
      cooldownTicks: 280,
      fitPadding: 56,
    };
  }
  if (mode === "note") {
    return {
      linkDistance: (link) => (link.crossCluster ? 180 : 100),
      linkStrength: (link) => (link.crossCluster ? 0.08 : 0.5),
      chargeStrength: -480,
      collidePad: 12,
      clusterStrength: 0.2,
      islandRepel: 0.05,
      centerStrength: 0.02,
      alphaDecay: 0.014,
      velocityDecay: 0.28,
      warmupTicks: 70,
      cooldownTicks: 260,
      fitPadding: 52,
    };
  }
  // explorer / large / category
  return {
    linkDistance: (link) => (link.crossCluster ? 260 : 120),
    linkStrength: (link) => (link.crossCluster ? 0.04 : 0.45),
    chargeStrength: -620,
    collidePad: 14,
    clusterStrength: 0.28,
    islandRepel: 0.06,
    centerStrength: 0.012,
    alphaDecay: 0.008,
    velocityDecay: 0.26,
    warmupTicks: 120,
    cooldownTicks: 420,
    fitPadding: 64,
  };
}

/** @deprecated 产品统一始终播动效，不再跟随系统「减少动态效果」 */
export function prefersReducedMotion() {
  return false
}
