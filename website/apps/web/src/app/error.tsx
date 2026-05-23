"use client";

import { useEffect } from "react";
import Link from "next/link";

const copy = {
  zh: {
    eyebrow: "运行时错误",
    title: "出了点问题",
    fallback: "发生了意外错误，问题已被记录。",
    retry: "重试",
    home: "返回首页",
  },
  en: {
    eyebrow: "Runtime Error",
    title: "Something went wrong",
    fallback: "An unexpected error occurred. The issue has been logged.",
    retry: "Try Again",
    home: "Go Home",
  },
};

function getLocale(): "zh" | "en" {
  if (typeof document === "undefined") return "en";
  return (document.documentElement.getAttribute("data-locale") as "zh" | "en") || "en";
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = copy[getLocale()];

  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgba(208,188,255,0.06),transparent_70%)]" />
      <div className="relative">
        <p className="font-label-ui text-[10px] uppercase tracking-[0.3em] text-red-400/60">
          {t.eyebrow}
        </p>
        <h1 className="font-display-ui mt-4 text-4xl font-semibold tracking-[-0.06em]">
          {t.title}
        </h1>
        <p className="mt-4 max-w-sm text-sm leading-7 text-foreground-muted">
          {error.message || t.fallback}
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <button
            className="rounded-full border border-primary/30 bg-primary/10 px-5 py-2.5 font-label-ui text-[11px] uppercase tracking-[0.15em] text-primary transition-colors hover:bg-primary/20"
            onClick={reset}
            type="button"
          >
            {t.retry}
          </button>
          <Link
            className="rounded-full border border-outline-variant/30 bg-surface-low/50 px-5 py-2.5 font-label-ui text-[11px] uppercase tracking-[0.15em] text-foreground-muted transition-colors hover:bg-surface-high/40"
            href="/"
          >
            {t.home}
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 font-mono text-[10px] text-foreground-muted/30">
            Digest: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
