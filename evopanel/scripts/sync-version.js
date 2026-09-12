/**
 * 单一版本源：evopanel/VERSION（一行 x.y.z）
 * 同步到 package.json、Cargo.toml、tauri.conf.json、scripts/maintainer/update/latest.json。
 *
 * 用法：
 *   npm run version:sync              # 读 VERSION → 写各处
 *   npm run version:set -- 0.2.3      # 改 VERSION 并同步（推荐发版前）
 *   node scripts/sync-version.js --from-git   # 用当前仓库最新 v* tag
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const semverRe = /^\d+\.\d+\.\d+$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const repoRoot = path.join(root, "..");
const versionFilePath = path.join(root, "VERSION");
const pkgPath = path.join(root, "package.json");

function readVersionFile() {
  if (!fs.existsSync(versionFilePath)) return "";
  return fs.readFileSync(versionFilePath, "utf8").trim();
}

function writeVersionFile(v) {
  fs.writeFileSync(versionFilePath, `${v}\n`, "utf8");
}

function latestGitTag() {
  try {
    const out = execSync("git describe --tags --abbrev=0", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = out.match(/^v?(\d+\.\d+\.\d+)$/i);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function resolveTargetVersion() {
  const cliVer = process.argv.find((a) => a !== "--from-git" && semverRe.test(a.trim()))?.trim();
  if (process.argv.includes("--from-git")) {
    const tagVer = latestGitTag();
    if (!tagVer) {
      console.error("No git tag vX.Y.Z found at repo root");
      process.exit(1);
    }
    return tagVer;
  }
  if (cliVer) return cliVer;
  const fromFile = readVersionFile();
  if (fromFile && semverRe.test(fromFile)) return fromFile;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const fromPkg = String(pkg.version || "").trim();
  if (semverRe.test(fromPkg)) return fromPkg;
  console.error("Set version in evopanel/VERSION or package.json, or pass x.y.z");
  process.exit(1);
}

const v = resolveTargetVersion();
writeVersionFile(v);

let pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = v;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const lockPath = path.join(root, "package-lock.json");
if (fs.existsSync(lockPath)) {
  let lock = fs.readFileSync(lockPath, "utf8");
  lock = lock.replace(
    /("name": "evopanel",\s*\n\s*"version": )"[^"]+"/,
    `$1"${v}"`,
  );
  lock = lock.replace(
    /("": \{\s*\n\s*"name": "evopanel",\s*\n\s*"version": )"[^"]+"/,
    `$1"${v}"`,
  );
  fs.writeFileSync(lockPath, lock);
}

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf8");
if (!/^version = "[^"]+"/m.test(cargo)) {
  console.error("Cargo.toml: expected [package] version line");
  process.exit(1);
}
cargo = cargo.replace(/^version = "[^"]+"/m, `version = "${v}"`);
fs.writeFileSync(cargoPath, cargo);

const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");
const tauri = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
tauri.version = v;
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");

function bumpLatestManifest(latestPath) {
  if (!fs.existsSync(latestPath)) return false;
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  latest.version = v;
  latest.minAppVersion = v;
  if (typeof latest.url === "string") {
    latest.url = latest.url
      .replace(/\/v\d+\.\d+\.\d+\//, `/v${v}/`)
      .replace(/web-\d+\.\d+\.\d+\.zip/, `web-${v}.zip`)
      .replace(/EvoFlow_\d+\.\d+\.\d+_x64-setup\.exe/, `EvoFlow_${v}_x64-setup.exe`);
  }
  if (typeof latest.changelog === "string" && /v\d+\.\d+\.\d+/.test(latest.changelog)) {
    latest.changelog = latest.changelog.replace(/v\d+\.\d+\.\d+/, `v${v}`);
  }
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");
  return true;
}

const maintainerLatest = path.join(
  repoRoot,
  "scripts",
  "maintainer",
  "update",
  "latest.json",
);
if (!bumpLatestManifest(maintainerLatest)) {
  console.warn(
    "No scripts/maintainer/update/latest.json found; create the maintainer draft first.",
  );
}

console.log(
  `Synced version ${v} ← evopanel/VERSION → package.json, Cargo.toml, tauri.conf.json, scripts/maintainer/update/latest.json`,
);
