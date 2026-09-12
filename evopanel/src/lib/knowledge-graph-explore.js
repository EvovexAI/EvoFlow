/**
 * Knowledge graph exploration helpers — pathfinding, hulls, freshness, persistence.
 */

export function linkId(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/** BFS shortest path on undirected adjacency Map<id, Set<id>> */
export function findShortestPath(adjacency, startId, endId) {
  if (!startId || !endId || startId === endId) return startId ? [startId] : [];
  if (!adjacency.has(startId) || !adjacency.has(endId)) return [];
  const queue = [startId];
  const prev = new Map([[startId, null]]);
  while (queue.length) {
    const cur = queue.shift();
    if (cur === endId) break;
    for (const n of adjacency.get(cur) || []) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!prev.has(endId)) return [];
  const path = [];
  let cur = endId;
  while (cur != null) {
    path.push(cur);
    cur = prev.get(cur);
  }
  path.reverse();
  return path;
}

/** Enumerate simple paths up to maxDepth / maxPaths (DFS). */
export function findAllPaths(adjacency, startId, endId, { maxDepth = 6, maxPaths = 12 } = {}) {
  const results = [];
  const stack = [[startId]];
  while (stack.length && results.length < maxPaths) {
    const path = stack.pop();
    const last = path[path.length - 1];
    if (last === endId) {
      results.push(path);
      continue;
    }
    if (path.length > maxDepth) continue;
    for (const n of adjacency.get(last) || []) {
      if (path.includes(n)) continue;
      stack.push([...path, n]);
    }
  }
  results.sort((a, b) => a.length - b.length);
  return results;
}

/** Monotone chain convex hull. Points: [{x,y}, ...] → hull ring (closed). */
export function convexHull(points) {
  const pts = (points || [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 1) return pts;
  if (pts.length === 2) return [...pts, pts[0]];

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  if (hull.length) hull.push(hull[0]);
  return hull;
}

/** Expand hull outward by padding (simple normal offset approximation). */
export function padHull(hull, padding = 20) {
  if (!hull?.length || hull.length < 3) return hull || [];
  // Centroid
  let cx = 0;
  let cy = 0;
  const n = hull.length - 1;
  for (let i = 0; i < n; i++) {
    cx += hull[i].x;
    cy += hull[i].y;
  }
  cx /= n;
  cy /= n;
  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * padding, y: p.y + (dy / d) * padding };
  });
}

export function freshnessTone(modifiedAt, now = Date.now()) {
  if (!modifiedAt) return "stale";
  const t = new Date(modifiedAt).getTime();
  if (!Number.isFinite(t)) return "stale";
  const days = (now - t) / (86400 * 1000);
  if (days <= 7) return "fresh";
  if (days <= 30) return "warm";
  return "stale";
}

export const FRESHNESS_COLORS = {
  fresh: "#20B982",
  warm: "#E9A900",
  stale: "#94A3B8",
};

const FAV_KEY = "evopanel.knowledgeGraph.favorites";
const HIST_KEY = "evopanel.knowledgeGraph.history";

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

export function loadFavorites(vaultId) {
  const all = readStore(FAV_KEY, {});
  return Array.isArray(all[vaultId]) ? all[vaultId] : [];
}

export function saveFavorites(vaultId, paths) {
  const all = readStore(FAV_KEY, {});
  all[vaultId] = [...new Set(paths)].slice(0, 200);
  writeStore(FAV_KEY, all);
}

export function toggleFavorite(vaultId, path) {
  const list = loadFavorites(vaultId);
  const next = list.includes(path) ? list.filter((p) => p !== path) : [path, ...list];
  saveFavorites(vaultId, next);
  return next;
}

export function loadHistory(vaultId) {
  const all = readStore(HIST_KEY, {});
  return Array.isArray(all[vaultId]) ? all[vaultId] : [];
}

export function pushHistory(vaultId, entry) {
  const path = entry?.path || entry?.id;
  if (!path) return loadHistory(vaultId);
  const prev = loadHistory(vaultId).filter((e) => (e.path || e.id) !== path);
  const next = [{ path, name: entry.name || entry.title || path, at: Date.now() }, ...prev].slice(0, 40);
  const all = readStore(HIST_KEY, {});
  all[vaultId] = next;
  writeStore(HIST_KEY, all);
  return next;
}

/** First ~3 paragraphs from markdown for preview. */
export function previewMarkdown(content, maxParas = 3, maxChars = 480) {
  const text = String(content || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
  if (!text) return "";
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  let out = paras.slice(0, maxParas).join("\n\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

export async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

export function dirnameOf(path) {
  const p = String(path || "").replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

export function joinPath(root, rel) {
  const r = String(root || "").replace(/[/\\]+$/, "");
  const relPath = String(rel || "").replace(/^[/\\]+/, "");
  if (!r) return relPath;
  const sep = r.includes("\\") ? "\\" : "/";
  return `${r}${sep}${relPath.replace(/\//g, sep)}`;
}
