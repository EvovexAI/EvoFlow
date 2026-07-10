"use client";

import { siteLinks } from "@ai-site/content";
import { useCallback, useEffect, useState } from "react";

const CACHE_KEY = "evoflow-github-stars-v1";
const CACHE_MS = 5 * 60 * 1000;

type CachePayload = { count: number; ts: number };

function readCache(): CachePayload | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachePayload;
    if (typeof parsed.count !== "number" || typeof parsed.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(count: number) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ count, ts: Date.now() } satisfies CachePayload));
  } catch {
    /* quota / private mode */
  }
}

function formatStars(count: number, locale: string): string {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}

/**
 * Fetches public GitHub repo stargazers count (browser → api.github.com).
 * Cached ~5 min in sessionStorage; refreshes when cache expires on tab focus.
 * Not truly push-realtime; good enough for marketing header without a backend token.
 */
export function useGithubRepoStarsDisplay(locale: string): string | null {
  const [count, setCount] = useState<number | null>(null);

  const fetchStars = useCallback(async () => {
    try {
      const res = await fetch(siteLinks.githubRepoApiUrl, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { stargazers_count?: unknown };
      const count = data.stargazers_count;
      if (typeof count !== "number" || count < 0) return;
      writeCache(count);
      setCount(count);
    } catch {
      /* network / CORS */
    }
  }, []);

  useEffect(() => {
    const hit = readCache();
    const stale = !hit || Date.now() - hit.ts >= CACHE_MS;
    if (stale) void fetchStars();
    else if (hit) setCount(hit.count);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const h = readCache();
      if (!h || Date.now() - h.ts >= CACHE_MS) void fetchStars();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchStars]);

  return count != null ? formatStars(count, locale) : null;
}
