/**
 * Copy Plan workflow static page + doc assets into Next.js public/.
 * Source: docs/presentations/plan-workflow/, docs/assets/{screenshots,plan-supervisor}
 * Target: apps/web/public/presentations/plan-workflow/, apps/web/public/assets/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.join(__dirname, "..");
const repoRoot = path.join(websiteRoot, "..");
const presentationSrc = path.join(repoRoot, "docs", "presentations", "plan-workflow");
const assetsSrc = path.join(repoRoot, "docs", "assets");
const publicRoot = path.join(websiteRoot, "apps", "web", "public");
const presentationDest = path.join(publicRoot, "presentations", "plan-workflow");
const assetsDest = path.join(publicRoot, "assets");
const ASSET_SUBDIRS = ["screenshots", "plan-supervisor"];
const PRESENTATION_FILES = ["index.html", "styles.css", "main.js"];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyPresentationFiles() {
  if (!fs.existsSync(presentationSrc)) {
    console.warn(`[sync-presentations] skip missing: ${presentationSrc}`);
    return 0;
  }
  let n = 0;
  for (const name of PRESENTATION_FILES) {
    const src = path.join(presentationSrc, name);
    if (!fs.existsSync(src)) {
      console.warn(`[sync-presentations] skip missing file: ${src}`);
      continue;
    }
    copyFile(src, path.join(presentationDest, name));
    n++;
  }
  return n;
}

function copyAssetDir(sub) {
  const srcDir = path.join(assetsSrc, sub);
  const destDir = path.join(assetsDest, sub);
  if (!fs.existsSync(srcDir)) {
    console.warn(`[sync-presentations] skip missing: ${srcDir}`);
    return 0;
  }
  let n = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (name === "README.md") continue;
    const src = path.join(srcDir, name);
    if (!fs.statSync(src).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) continue;
    copyFile(src, path.join(destDir, name));
    n++;
  }
  return n;
}

let total = copyPresentationFiles();
for (const sub of ASSET_SUBDIRS) {
  total += copyAssetDir(sub);
}
console.log(
  `[sync-presentations] synced ${total} file(s) → ${presentationDest} + ${assetsDest}`,
);
