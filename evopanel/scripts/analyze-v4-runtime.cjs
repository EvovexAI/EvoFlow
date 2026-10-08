#!/usr/bin/env node
/* Runtime vs type-only closure analysis.
 * BFS from V4ChatPane through VALUE imports only (files that must be ported as runtime code).
 * Type-only imports are collected separately (modules needing type stubs only).
 */
const fs = require("fs");
const path = require("path");

const V4DIR = path.resolve(__dirname, "..", "src", "react", "v4_verbatim");
const REACT_DIR = path.resolve(__dirname, "..", "src", "react");
const ZCODE_UI = "D:/dev/github/ZCode/packages/ui/src";
const ZCODE_SHARED = "D:/dev/github/ZCode/packages/shared/src";

function parseImports(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  // strip block comments & line comments to avoid false matches
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
  const re = /(?:^|\n)\s*(import|export)\s+(?:(type)\s+)?[^"'`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(clean))) {
    const kw = m[1] || "import";
    const isType = !!m[2] || false;
    const spec = m[3] || m[4] || m[5];
    // detect `import { type X }` or `export type {`
    const frag = clean.slice(Math.max(0, m.index - 5), m.index + 200);
    const typeish = isType || /^\s*(?:import|export)\s+type\s/.test(clean.slice(m.index, m.index + 30)) || /\{\s*type\s/.test(frag.slice(0, 60));
    out.push({ spec, typeOnly: typeish, dynamic: !m[3] === false ? false : !!m[4] });
  }
  return out;
}

function resolveTs(dir, spec) {
  const base = path.join(dir, spec);
  const cands = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base + ".ts",
    base + ".tsx",
    base.replace(/\.js$/, ".d.ts"),
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

function locate(spec, fromFile) {
  if (spec.startsWith(".")) {
    const r = resolveTs(path.dirname(fromFile), spec);
    return r ? { file: r, origin: r.startsWith(V4DIR) ? "v4" : "outside" } : null;
  }
  if (spec.startsWith("@/")) {
    const sub = spec.slice(2);
    const inEvo = resolveTs(REACT_DIR, sub);
    if (inEvo && inEvo.startsWith(V4DIR)) return { file: inEvo, origin: "v4" };
    if (inEvo) return { file: inEvo, origin: "evo-outside" };
    const inZ = resolveTs(ZCODE_UI, sub);
    if (inZ) return { file: inZ, origin: "zcode-ui" };
    return null;
  }
  // bare: lost ./ prefix
  const asLocal = resolveTs(V4DIR, spec) || resolveTs(path.dirname(fromFile), spec);
  if (asLocal && asLocal.startsWith(V4DIR)) return { file: asLocal, origin: "v4-bare" };
  if (spec.startsWith("@zcode/shared")) {
    const sub = spec.replace(/^@zcode\/shared\/?/, "");
    const inS = sub ? resolveTs(ZCODE_SHARED, sub) : path.join(ZCODE_SHARED, "index.ts");
    if (inS && fs.existsSync(inS)) return { file: inS, origin: "zcode-shared" };
  }
  return null;
}

const entry = path.join(V4DIR, "V4ChatPane.tsx");
const queue = [entry];
const ported = new Set();   // runtime files that must exist in EvoFlow
const typeStubs = new Map(); // spec -> Set<importing file>
const pkgs = new Set();

while (queue.length) {
  const f = queue.shift();
  if (ported.has(f)) continue;
  ported.add(f);
  for (const imp of parseImports(f)) {
    const loc = locate(imp.spec, f);
    if (!loc) { pkgs.add(imp.spec); continue; }
    if (loc.origin === "evo-outside") continue; // already in EvoFlow, don't port
    if (imp.typeOnly) {
      if (!typeStubs.has(imp.spec)) typeStubs.set(imp.spec, new Set());
      typeStubs.get(imp.spec).add(path.relative(V4DIR, f));
    } else {
      queue.push(loc.file);
    }
  }
}

console.log("== RUNTIME closure (files to port):", ported.size, "==");
let v4Count = 0, zCount = 0;
for (const f of ported) {
  if (f.startsWith(V4DIR)) v4Count++; else zCount++;
}
console.log("  already in v4_verbatim:", v4Count);
console.log("  to port from ZCode:", zCount);
const byDir = {};
for (const f of ported) {
  if (f.startsWith(V4DIR)) continue;
  const rel = path.relative(ZCODE_UI, f);
  const dir = rel.includes("\\") || rel.includes("/") ? rel.split(/[\\/]/)[0] : "(root)";
  byDir[dir] = (byDir[dir] || 0) + 1;
}
console.log("  ZCode files by top dir:", JSON.stringify(byDir, null, 2));
fs.writeFileSync(path.join(__dirname, "_runtime_closure.json"), JSON.stringify([...ported].sort(), null, 2));

console.log("\n== TYPE-ONLY stub targets:", typeStubs.size, "==");
const stubList = [...typeStubs.entries()].sort();
for (const [spec, users] of stubList) console.log(`${spec}  (${users.size} users)`);
fs.writeFileSync(path.join(__dirname, "_type_stubs.json"), JSON.stringify([...typeStubs.keys()].sort(), null, 2));

console.log("\n== unresolved (npm or missing):", pkgs.size, "==");
console.log([...pkgs].filter(s => !s.includes("\n")).sort().join("\n"));
