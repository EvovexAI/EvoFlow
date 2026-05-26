/** 个人履历私密入口（勿写入站内导航 / sitemap / AI 演示文案） */

export const RESUME_SECRET_SLUG = "h8f2-xK9m-p7wR";

export const RESUME_ACCESS_PASSWORD = "123456";

/** Base64，用作 URL ?k= 简单“解密”参数（刷新后仍有效；不写 sessionStorage） */
export function resumeAccessKeyFromPassword(password: string = RESUME_ACCESS_PASSWORD): string {
  if (typeof btoa !== "undefined") {
    return btoa(password);
  }
  return Buffer.from(password, "utf8").toString("base64");
}

export function verifyResumeAccessKey(key: string | null | undefined): boolean {
  if (!key?.trim()) return false;
  const trimmed = key.trim();
  if (trimmed === RESUME_ACCESS_PASSWORD) return true;
  try {
    const decoded =
      typeof atob !== "undefined"
        ? atob(trimmed)
        : Buffer.from(trimmed, "base64").toString("utf8");
    return decoded === RESUME_ACCESS_PASSWORD;
  } catch {
    return false;
  }
}

export function isPrivateResumePath(pathname: string): boolean {
  const normalized = pathname.replace(/\/$/, "") || "/";
  if (normalized === "/resume") return true;
  return normalized === `/r/${RESUME_SECRET_SLUG}`;
}

/** 带口令参数的完整直链（投递用） */
export function buildResumePrivateUrl(origin = "", withAccessKey = true): string {
  const path = `/r/${RESUME_SECRET_SLUG}`;
  const base = origin ? `${origin.replace(/\/$/, "")}${path}` : path;
  if (!withAccessKey) return base;
  return `${base}?k=${encodeURIComponent(resumeAccessKeyFromPassword())}`;
}
