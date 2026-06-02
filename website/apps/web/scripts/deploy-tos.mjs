/**
 * Upload `out/` to Volcano Engine TOS (after `pnpm build:static`).
 *
 * Required env: TOS_ACCESS_KEY_ID, TOS_SECRET_ACCESS_KEY, TOS_ENDPOINT, TOS_REGION, TOS_BUCKET
 * Optional: TOS_PREFIX (object key prefix, no leading slash), TOS_DRY_RUN=1
 * HTML objects are uploaded with Content-Disposition: inline (see website/README.md for custom-domain requirements).
 *
 * Aliases: VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY are accepted for AK/SK.
 */
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Load TosClient via CJS require — avoids ESM/CJS interop on GitHub Actions where
 * `import * as X` / default import can yield a non-callable namespace.
 */
function loadTosClientCtor() {
  const mod = require("@volcengine/tos-sdk");
  if (typeof mod === "function") return mod;
  if (typeof mod?.TosClient === "function") return mod.TosClient;
  if (typeof mod?.TOS === "function") return mod.TOS;
  if (typeof mod?.default === "function") return mod.default;
  if (mod?.default && typeof mod.default === "object") {
    if (typeof mod.default.TosClient === "function") return mod.default.TosClient;
    if (typeof mod.default.default === "function") return mod.default.default;
  }
  throw new Error(
    "[deploy-tos] @volcengine/tos-sdk: could not resolve TosClient (check pnpm install / lodash hoist)",
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "out");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function requireEnv(name, fallback) {
  const v = (fallback ?? process.env[name])?.trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function *walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield *walkFiles(full);
    else if (ent.isFile()) yield full;
  }
}

function normalizePrefix(p) {
  if (!p) return "";
  return p
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\\/g, "/");
}

function cacheControlFor(relPosix) {
  if (relPosix.includes("/_next/static/")) {
    return "public, max-age=31536000, immutable";
  }
  if (relPosix.endsWith(".html")) {
    // HTML must revalidate after each deploy so it never references deleted chunk hashes.
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=3600";
}

/** Upload hashed assets before HTML so a partial deploy never serves new HTML + missing chunks. */
function uploadSortKey(relPosix) {
  if (relPosix.includes("/_next/static/")) return `0/${relPosix}`;
  if (relPosix.endsWith(".html")) return `2/${relPosix}`;
  return `1/${relPosix}`;
}

/** 对象元数据：HTML 显式 inline，避免部分访问链路按「附件」处理（仍需绑定自定义域名，见 website/README.md）。 */
function putObjectInput(filePath, relPosix, key, bucket) {
  const ext = path.extname(filePath).toLowerCase();
  const input = {
    bucket,
    key,
    body: createReadStream(filePath),
    contentType: mimeFor(filePath),
    cacheControl: cacheControlFor(relPosix),
  };
  if (ext === ".html" || ext === ".htm") {
    input.contentDisposition = "inline";
  }
  return input;
}

async function main() {
  if (!fs.existsSync(OUT)) {
    throw new Error(`Static output not found: ${OUT}\nRun: pnpm build:static (from repo website/)`);
  }

  const dry = process.env.TOS_DRY_RUN === "1";
  const accessKeyId = process.env.TOS_ACCESS_KEY_ID ?? process.env.VOLC_ACCESS_KEY_ID;
  const accessKeySecret = process.env.TOS_SECRET_ACCESS_KEY ?? process.env.VOLC_SECRET_ACCESS_KEY;
  const prefix = normalizePrefix(process.env.TOS_PREFIX ?? "");

  const files = [...walkFiles(OUT)].sort((a, b) => {
    const ra = path.relative(OUT, a).split(path.sep).join("/");
    const rb = path.relative(OUT, b).split(path.sep).join("/");
    return uploadSortKey(ra).localeCompare(uploadSortKey(rb));
  });
  console.log(`[deploy-tos] ${files.length} files under out/ (static first, html last)`);

  if (dry) {
    console.log("[deploy-tos] DRY RUN — set secrets and omit TOS_DRY_RUN to upload.");
    for (const f of files.slice(0, 8)) {
      console.log("  ", path.relative(OUT, f).split(path.sep).join("/"));
    }
    if (files.length > 8) console.log("  ...");
    return;
  }

  const TosClientCtor = loadTosClientCtor();
  const client = new TosClientCtor({
    accessKeyId: requireEnv("TOS_ACCESS_KEY_ID", accessKeyId),
    accessKeySecret: requireEnv("TOS_SECRET_ACCESS_KEY", accessKeySecret),
    endpoint: requireEnv("TOS_ENDPOINT"),
    region: requireEnv("TOS_REGION"),
  });

  const bucket = requireEnv("TOS_BUCKET");

  let n = 0;
  for (const filePath of files) {
    const relPosix = path.relative(OUT, filePath).split(path.sep).join("/");
    const key = prefix ? `${prefix}/${relPosix}` : relPosix;

    await client.putObject(putObjectInput(filePath, relPosix, key, bucket));

    n++;
    if (n % 80 === 0 || n === files.length) {
      console.log(`[deploy-tos] uploaded ${n}/${files.length}`);
    }
  }

  console.log("[deploy-tos] done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
