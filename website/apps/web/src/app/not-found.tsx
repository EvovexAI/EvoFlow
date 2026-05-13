"use client";

import Link from "next/link";
import { useSiteLocale } from "@/components/locale-provider";

const copy = {
  zh: {
    eyebrow: "信号丢失",
    title: "页面未找到",
    description: "您访问的页面不存在，可能已被移动或从未创建。",
    home: "返回首页",
    about: "关于项目",
  },
  en: {
    eyebrow: "Signal Lost",
    title: "Page not found",
    description:
      "The page you requested doesn\u2019t exist. It may have been moved or never existed.",
    home: "Back to Home",
    about: "About",
  },
};

export default function NotFound() {
  const { locale } = useSiteLocale();
  const t = copy[locale];

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgba(208,188,255,0.06),transparent_70%)]" />
      <div className="relative">
        <p className="font-mono text-[120px] font-bold leading-none tracking-tighter text-foreground/[0.04] md:text-[180px]">
          404
        </p>
        <div className="-mt-14 md:-mt-20">
          <p className="font-label-ui text-[10px] uppercase tracking-[0.3em] text-primary/60">
            {t.eyebrow}
          </p>
          <h1 className="font-display-ui mt-4 text-4xl font-semibold tracking-[-0.06em]">
            {t.title}
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-7 text-foreground-muted">
            {t.description}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              className="rounded-full border border-primary/30 bg-primary/10 px-5 py-2.5 font-label-ui text-[11px] uppercase tracking-[0.15em] text-primary transition-colors hover:bg-primary/20"
              href="/"
            >
              {t.home}
            </Link>
            <Link
              className="rounded-full border border-outline-variant/30 bg-surface-low/50 px-5 py-2.5 font-label-ui text-[11px] uppercase tracking-[0.15em] text-foreground-muted transition-colors hover:bg-surface-high/40"
              href="/about"
            >
              {t.about}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
