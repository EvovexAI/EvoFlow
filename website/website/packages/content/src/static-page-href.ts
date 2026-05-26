/**
 * Next `output: export` on TOS / S3-style buckets serves HTML as `…/index.html`.
 * Clean paths like `/docs` do not map to `docs.html` unless the CDN rewrites them.
 * When `trailingSlash: true` (see apps/web/next.config.ts), use trailing slashes on in-app routes.
 */
export function staticPageHref(path: string): string {
  if (typeof process === "undefined" || process.env.NEXT_PUBLIC_STATIC_EXPORT !== "1") {
    return path;
  }
  if (!path.startsWith("/") || path.startsWith("//")) return path;

  let hash = "";
  let query = "";
  let base = path;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) {
    base = path.slice(0, hashIdx);
    hash = path.slice(hashIdx);
  }
  const queryIdx = base.indexOf("?");
  if (queryIdx >= 0) {
    query = base.slice(queryIdx);
    base = base.slice(0, queryIdx);
  }

  if (base === "" || base === "/") return path;

  if (base.endsWith("/")) return path;

  if (/\.[a-z0-9]{1,8}$/i.test(base)) return path;

  return `${base}/${query}${hash}`;
}
