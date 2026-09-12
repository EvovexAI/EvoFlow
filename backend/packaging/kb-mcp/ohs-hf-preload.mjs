/**
 * Node --import preload for obsidian-hybrid-search.
 *
 * @huggingface/transformers defaults to https://huggingface.co/ and does NOT
 * honor HF_ENDPOINT. In regions where huggingface.co is unreachable, local
 * Xenova embeddings fail with "fetch failed". Point remoteHost at HF_ENDPOINT
 * (e.g. https://hf-mirror.com) before OHS loads the embedder.
 *
 * OHS also overwrites ``env.cacheDir`` to ``~/.cache/huggingface`` after import.
 * When TRANSFORMERS_CACHE / HF_HOME is set, keep that path via a getter/setter.
 */
import { env } from "@huggingface/transformers";

function normalizeHost(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

const host = normalizeHost(process.env.HF_ENDPOINT || process.env.HF_MIRROR || "");
if (host) {
  env.remoteHost = host;
}

const preferredCache = process.env.TRANSFORMERS_CACHE || process.env.HF_HOME || "";
let cacheDir = preferredCache || env.cacheDir;
if (preferredCache) {
  Object.defineProperty(env, "cacheDir", {
    configurable: true,
    enumerable: true,
    get() {
      return cacheDir;
    },
    set(value) {
      // Keep EvoFlow runtime cache; ignore OHS hardcoded ~/.cache/huggingface.
      cacheDir = preferredCache || value;
    },
  });
  env.useFSCache = true;
}

env.allowRemoteModels = true;
