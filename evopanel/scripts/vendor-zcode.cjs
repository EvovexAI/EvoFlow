#!/usr/bin/env node
/* Vendor ZCode frontend packages into evopanel/src for the v4 shell migration.
 *
 * Copies (verbatim, all file types):
 *   ZCode/packages/ui/src       -> evopanel/src/zcode-ui
 *   ZCode/packages/shared/src   -> evopanel/src/zcode-shared
 *   ZCode/packages/rpc/src      -> evopanel/src/zcode-rpc
 *   ZCode/packages/provider/src -> evopanel/src/zcode-provider
 *   ZCode/packages/services/src -> evopanel/src/zcode-services
 *
 * A manifest with the source git revision is written next to this script so the
 * vendored snapshot stays traceable. Re-running the script refreshes the copies.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ZCODE = "D:/dev/github/ZCode";

const PACKAGES = [
  ["packages/ui/src", "src/zcode-ui"],
  ["packages/shared/src", "src/zcode-shared"],
  ["packages/rpc/src", "src/zcode-rpc"],
  ["packages/provider/src", "src/zcode-provider"],
  ["packages/provider-node/src", "src/zcode-provider-node"],
  ["packages/services/src", "src/zcode-services"],
  ["packages/model-option-map/src", "src/zcode-model-option-map"],
];

// zcode-cua 是预编译占位包（js + d.ts + exports map，无 src）。
// 作为 file: 依赖安装（pnpm add file:./vendor/zcode-cua），借 node 解析拿到 exports 映射。
const FILE_PACKAGES = [["packages/zcode-cua", "vendor/zcode-cua"]];

function gitRev(dir) {
  try {
    return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "unknown (not a git repo)";
  }
}

const revision = gitRev(ZCODE);
let totalFiles = 0;
const stats = {};

for (const [srcRel, dstRel] of PACKAGES) {
  const src = path.join(ZCODE, srcRel);
  const dst = path.join(ROOT, dstRel);
  if (!fs.existsSync(src)) {
    console.error(`[vendor] missing source: ${src}`);
    process.exit(1);
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, dereference: true });
  const count = execSync(`git ls-files "${srcRel}"`, { cwd: ZCODE, encoding: "utf8" })
    .split("\n")
    .filter(Boolean).length;
  // git ls-files misses untracked files; count on disk instead.
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n++;
    }
  })(dst);
  stats[dstRel] = n;
  totalFiles += n;
  console.log(`[vendor] ${srcRel} -> ${dstRel} (${n} files)`);
}

for (const [srcRel, dstRel] of FILE_PACKAGES) {
  const src = path.join(ZCODE, srcRel);
  const dst = path.join(ROOT, dstRel);
  if (!fs.existsSync(src)) {
    console.error(`[vendor] missing source: ${src}`);
    process.exit(1);
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, dereference: true });
  fs.rmSync(path.join(dst, "node_modules"), { recursive: true, force: true });
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n++;
    }
  })(dst);
  stats[dstRel] = n;
  totalFiles += n;
  console.log(`[vendor] ${srcRel} -> ${dstRel} (${n} files, file: dep — run: pnpm add file:./vendor/zcode-cua)`);
}

const manifest = { source: ZCODE, revision, vendoredAt: new Date().toISOString(), packages: stats };
fs.writeFileSync(path.join(__dirname, "zcode-vendor-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[vendor] done: ${totalFiles} files, revision ${revision.slice(0, 12)}`);
