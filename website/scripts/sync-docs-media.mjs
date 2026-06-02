/**
 * Copy README / docs media into Next.js public/ for the marketing showcase page.
 * Source: repo root docs/assets/{screenshots,plan-supervisor}
 * Target: apps/web/public/media/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.join(__dirname, "..");
const repoRoot = path.join(websiteRoot, "..");
const srcRoot = path.join(repoRoot, "docs", "assets");
const destRoot = path.join(websiteRoot, "apps", "web", "public", "media");

const SUBDIRS = ["screenshots", "plan-supervisor"];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`[sync-docs-media] skip missing: ${srcDir}`);
    return 0;
  }
  let n = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (name === "README.md") continue;
    const src = path.join(srcDir, name);
    const st = fs.statSync(src);
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"].includes(ext)) continue;
    copyFile(src, path.join(destDir, name));
    n++;
  }
  return n;
}

let total = 0;
fs.mkdirSync(destRoot, { recursive: true });
for (const sub of SUBDIRS) {
  total += copyDir(path.join(srcRoot, sub), path.join(destRoot, sub));
}
console.log(`[sync-docs-media] copied ${total} file(s) → ${destRoot}`);
