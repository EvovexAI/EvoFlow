"use server";

import { redirect } from "next/navigation";
import { createAdminSession, destroyAdminSession } from "@/lib/admin-auth";

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("password-verify"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const viewA = new Uint8Array(sigA);
  const viewB = new Uint8Array(sigB);
  let mismatch = 0;
  for (let i = 0; i < viewA.length; i++) {
    mismatch |= viewA[i] ^ viewB[i];
  }
  return mismatch === 0;
}

export async function loginAction(
  _prev: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string }> {
  const password = formData.get("password");

  if (typeof password !== "string" || !password) {
    return { error: "请输入密码" };
  }

  const expected = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!expected) {
    return { error: "服务器未配置管理员密码" };
  }

  const isMatch = await constantTimeEqual(password, expected);
  if (!isMatch) {
    await new Promise((r) => setTimeout(r, 500));
    return { error: "密码错误" };
  }

  await createAdminSession();
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await destroyAdminSession();
  redirect("/admin/login");
}
