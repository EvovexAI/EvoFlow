/**
 * Copy static presentation pages + doc assets into Next.js public/.
 * Sources:
 *   docs/presentations/**  (each folder with index.html, plus shared styles/main.js)
 *   docs/assets/{screenshots,plan-supervisor,guides}
 * Targets:
 *   apps/web/public/presentations/**
 *   apps/web/public/assets/**
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.join(__dirname, "..");
const repoRoot = path.join(websiteRoot, "..");
const presentationsSrc = path.join(repoRoot, "docs", "presentations");
const assetsSrc = path.join(repoRoot, "docs", "assets");
const publicRoot = path.join(websiteRoot, "apps", "web", "public");
const presentationsDest = path.join(publicRoot, "presentations");
const assetsDest = path.join(publicRoot, "assets");
const ASSET_SUBDIRS = ["screenshots", "plan-supervisor", "guides"];
const STATIC_BASENAMES = new Set(["index.html", "styles.css", "main.js"]);

/** getting-started 截图：源文件可为中文名，同步时额外写出 ASCII 别名供网页引用 */
const GETTING_STARTED_ALIASES = {
  "00-主界面设置按钮位置.png": "00-settings-nav.png",
  "01-打开模型设置页面.png": "01-models-page.png",
  "02-模型厂商链接配置.png": "02-add-connection.png",
  "03-点击添加模型-添加模型按钮位置.png": "03-add-model.png",
  "04-模型详细配置信息.png": "04-model-details.png",
  "05-模型验证及设置主模型.png": "05-primary-test.png",
  "06-对话页首条消息.png": "06-first-chat.png",
};

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Recursively copy presentation HTML/CSS/JS under docs/presentations/ */
function syncPresentationTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      n += syncPresentationTree(src, dest);
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (!STATIC_BASENAMES.has(name) && ![".css", ".js", ".html"].includes(ext)) {
      continue;
    }
    copyFile(src, dest);
    n++;
  }
  return n;
}

/** Recursively copy media under docs/assets/{sub}/ (e.g. guides/getting-started/*.png). */
function copyAssetDir(sub) {
  const srcDir = path.join(assetsSrc, sub);
  const destDir = path.join(assetsDest, sub);
  if (!fs.existsSync(srcDir)) {
    console.warn(`[sync-presentations] skip missing: ${srcDir}`);
    return 0;
  }
  let n = 0;
  function walk(relativeDir) {
    const currentSrc = path.join(srcDir, relativeDir);
    const currentDest = path.join(destDir, relativeDir);
    for (const name of fs.readdirSync(currentSrc)) {
      if (name === "README.md") continue;
      const src = path.join(currentSrc, name);
      const rel = relativeDir ? path.join(relativeDir, name) : name;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        walk(rel);
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"].includes(ext)) continue;
      const destPath = path.join(destDir, rel);
      copyFile(src, destPath);
      n++;
      if (sub === "guides" && relativeDir === "getting-started") {
        const alias = GETTING_STARTED_ALIASES[name];
        if (alias) {
          copyFile(src, path.join(destDir, relativeDir, alias));
          n++;
        }
      }
    }
  }
  walk("");
  return n;
}

let total = 0;
if (!fs.existsSync(presentationsSrc)) {
  console.warn(`[sync-presentations] skip missing: ${presentationsSrc}`);
} else {
  total += syncPresentationTree(presentationsSrc, presentationsDest);
}
for (const sub of ASSET_SUBDIRS) {
  total += copyAssetDir(sub);
}
console.log(
  `[sync-presentations] synced ${total} file(s) → ${presentationsDest} + ${assetsDest}`,
);
