import { cookies } from "next/headers";

const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const password = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!password) throw new Error("ADMIN_BASIC_AUTH_PASSWORD is not set");
  return password;
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Buffer.from(sig).toString("hex");
}

async function hmacVerify(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expected = await hmacSign(payload, secret);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function buildPayload(): string {
  return `admin:authorized`;
}

export async function createAdminSession(): Promise<void> {
  const secret = getSecret();
  const payload = buildPayload();
  const signature = await hmacSign(payload, secret);
  const token = `${payload}.${signature}`;

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function destroyAdminSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function verifyAdminSession(): Promise<boolean> {
  const password = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!password) return false;

  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return false;

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const payload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  return hmacVerify(payload, signature, password);
}

/**
 * Lightweight check for Edge middleware (no cookies() helper).
 * Accepts the raw cookie header string.
 */
export async function verifyAdminCookie(
  cookieValue: string | undefined,
): Promise<boolean> {
  const password = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!password) return false;
  if (!cookieValue) return false;

  const dotIndex = cookieValue.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const payload = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);

  return hmacVerify(payload, signature, password);
}

export { COOKIE_NAME };
