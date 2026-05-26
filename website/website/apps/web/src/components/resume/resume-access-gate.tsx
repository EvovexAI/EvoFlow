"use client";

import { RESUME_ACCESS_PASSWORD, verifyResumeAccessKey } from "@/lib/resume-access";
import { useSiteLocale } from "@/components/locale-provider";
import { useLayoutEffect, useState } from "react";

type GateStatus = "pending" | "locked" | "unlocked";

function GatePending() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-foreground-muted">
      …
    </div>
  );
}

/** 仅 URL ?k= 可自动解锁；不读写 sessionStorage，刷新须重新输入口令 */
function accessFromUrlKey(searchKey: string | null): GateStatus {
  return verifyResumeAccessKey(searchKey) ? "unlocked" : "locked";
}

function stripAccessKeyFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("k")) return;
  url.searchParams.delete("k");
  const next = url.pathname + url.search + url.hash;
  window.history.replaceState(window.history.state, "", next);
}

function ResumeAccessGateInner({ children }: { children: React.ReactNode }) {
  const { locale } = useSiteLocale();

  const [status, setStatus] = useState<GateStatus>("pending");
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  useLayoutEffect(() => {
    const searchKey = new URLSearchParams(window.location.search).get("k");
    const next = accessFromUrlKey(searchKey);
    setStatus(next);
    if (next === "unlocked" && searchKey) {
      stripAccessKeyFromUrl();
    }
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() === RESUME_ACCESS_PASSWORD || verifyResumeAccessKey(input.trim())) {
      setStatus("unlocked");
      setError(false);
      stripAccessKeyFromUrl();
      return;
    }
    setError(true);
  };

  if (status === "pending") {
    return <GatePending />;
  }

  if (status === "unlocked") {
    return <>{children}</>;
  }

  const copy =
    locale === "en"
      ? {
          title: "Access code required",
          hint: "Enter the access code. Links with ?k= unlock once; refreshing requires the code again.",
          placeholder: "Access code",
          submit: "Continue",
          wrong: "Incorrect code.",
        }
      : {
          title: "需要访问口令",
          hint: "请输入口令。带 ?k= 的链接可自动进入；刷新页面后须重新输入。",
          placeholder: "访问口令",
          submit: "进入",
          wrong: "口令不正确。",
        };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-outline-variant/35 bg-surface-low/90 p-8 shadow-xl"
        onSubmit={onSubmit}
      >
        <h1 className="font-display-ui text-center text-xl font-semibold tracking-[-0.03em] text-foreground">
          {copy.title}
        </h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-foreground-muted">{copy.hint}</p>
        <input
          autoComplete="off"
          className="mt-6 w-full rounded-lg border border-outline-variant/40 bg-background px-4 py-3 text-center text-sm tracking-widest text-foreground outline-none focus:border-primary/50"
          name="code"
          placeholder={copy.placeholder}
          spellCheck={false}
          type="password"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(false);
          }}
        />
        {error ? (
          <p className="mt-2 text-center text-xs text-red-400">{copy.wrong}</p>
        ) : null}
        <button
          className="mt-6 w-full rounded-full border border-primary bg-primary/12 py-3 text-sm font-semibold text-foreground hover:bg-primary/20"
          type="submit"
        >
          {copy.submit}
        </button>
      </form>
    </div>
  );
}

export function ResumeAccessGate({ children }: { children: React.ReactNode }) {
  return <ResumeAccessGateInner>{children}</ResumeAccessGateInner>;
}
