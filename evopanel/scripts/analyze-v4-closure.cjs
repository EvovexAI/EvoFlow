#!/usr/bin/env node
/* Dependency closure analysis for v4_verbatim.
 * BFS from V4ChatPane.tsx through all static imports,
 * classifying every target:
 *   - internal : file inside v4_verbatim
 *   - bare     : broken self-import (missing ./ prefix)
 *   - bridge   : ../protocol/* (EvoFlow bridge stubs)
 *   - at       : @/x outside v4_verbatim (ZCode ui internals / EvoFlow modules)
 *   - pkg      : npm package
 * For @/ targets we check existence in EvoFlow src/react and ZCode packages/ui/src.
 */
const fs = require("fs");
const path = require("path");

const V4DIR = path.resolve(__dirname, "..", "src", "react", "v4_verbatim");
const REACT_DIR = path.resolve(__dirname, "..", "src", "react");
const ZCODE_UI = "D:/dev/github/ZCode/packages/ui/src";

function walkImports(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  const re = /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    out.push(m[1] || m[2] || m[3]);
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
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

function classify(spec, fromFile) {
  if (spec.startsWith(".")) {
    const resolved = resolveTs(path.dirname(fromFile), spec);
    if (resolved && resolved.startsWith(V4DIR)) return { kind: "internal", resolved };
    if (resolved) return { kind: "relative-outside", resolved };
    return { kind: "relative-missing", spec };
  }
  if (spec.startsWith("@/")) {
    // @/ maps to src/react in EvoFlow, and to packages/ui/src in ZCode
    const sub = spec.slice(2);
    const inEvo = resolveTs(REACT_DIR, sub);
    const inZ = resolveTs(ZCODE_UI, sub);
    if (inEvo && inEvo.startsWith(V4DIR)) return { kind: "internal", resolved: inEvo };
    return { kind: "at", spec, inEvo: !!inEvo, inZcode: !!inZ, zResolved: inZ, evoResolved: inEvo };
  }
  // bare specifier: maybe a v4_verbatim file that lost its ./ prefix
  const asLocal = resolveTs(V4DIR, spec);
  if (asLocal) return { kind: "bare", spec, resolved: asLocal };
  const asRelative = resolveTs(path.dirname(fromFile), spec);
  if (asRelative && asRelative.startsWith(V4DIR)) return { kind: "bare", spec, resolved: asRelative };
  return { kind: "pkg", spec };
}

const entry = path.join(V4DIR, "V4ChatPane.tsx");
const queue = [entry];
const seen = new Set();
const report = { internal: 0, bare: new Set(), bridge: new Set(), at: new Map(), atMissing: new Set(), pkg: new Set(), relativeOutside: new Set() };
const files = [];

while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  files.push(f);
  for (const spec of walkImports(f)) {
    const c = classify(spec, f);
    if (c.kind === "internal") { report.internal++; queue.push(c.resolved); }
    else if (c.kind === "bare") { report.bare.add(spec); queue.push(c.resolved); }
    else if (spec.startsWith("../protocol/")) { report.bridge.add(spec); }
    else if (c.kind === "at") {
      const key = spec;
      if (!report.at.has(key)) report.at.set(key, { inEvo: c.inEvo, inZcode: c.inZcode, zResolved: c.zResolved });
      if (c.inZcode) queue.push(c.zResolved); // follow ZCode side to size the port
      else if (!c.inEvo) report.atMissing.add(key);
    }
    else if (c.kind === "pkg") report.pkg.add(spec);
    else if (c.kind === "relative-outside") { report.relativeOutside.add(spec); queue.push(c.resolved); }
    else report.atMissing.add(spec + " (unresolved relative)");
  }
}

console.log("== closure size ==");
console.log("files reached:", files.length);
console.log("internal edges:", report.internal);
console.log("\n== bare self-imports (need ./ fix):", report.bare.size, "==");
console.log([...report.bare].sort().join("\n"));
console.log("\n== bridge imports (../protocol/*): ==");
console.log([...report.bridge].sort().join("\n"));
console.log("\n== npm packages: ==");
console.log([...report.pkg].sort().join("\n"));
console.log("\n== @/ targets outside v4_verbatim:", report.at.size, "==");
for (const [k, v] of [...report.at.entries()].sort()) {
  console.log(`${k}  [EvoFlow:${v.inEvo ? "Y" : "n"} ZCode:${v.inZcode ? "Y" : "n"}]`);
}
console.log("\n== @/ targets missing in BOTH:", report.atMissing.size, "==");
console.log([...report.atMissing].sort().join("\n"));
fs.writeFileSync(path.join(__dirname, "_closure_files.json"), JSON.stringify(files, null, 2));
