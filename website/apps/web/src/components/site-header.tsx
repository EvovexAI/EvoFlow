"use client";

import Link from "next/link";
import { type LocalizedValue, siteCopyByLocale, siteLinks } from "@ai-site/content";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalizedValue, useSiteLocale } from "./locale-provider";
import { useGithubRepoStarsDisplay } from "@/hooks/use-github-repo-stars";
import { useSoundOnNavigate } from "@/hooks/use-sound";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const navLinkClass =
  "text-sm font-normal text-foreground/90 transition-opacity duration-200 hover:opacity-70";

const ctaClassName =
  "inline-flex items-center justify-center rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90";

function HamburgerIcon({ open }: { open: boolean }) {
  const Icon = open ? X : Menu;
  return (
    <Icon
      aria-hidden="true"
      className="h-5 w-5 text-foreground"
      strokeWidth={1.5}
    />
  );
}

function MobileDrawer({
  items,
  open,
  onClose,
  pathname,
  githubCtaText,
}: {
  items: Array<{ href: string; label: string }>;
  open: boolean;
  onClose: () => void;
  pathname: string;
  githubCtaText: string;
}) {
  const { locale, locales, setLocale } = useSiteLocale();

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    onClose();
  }, [pathname, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <nav className="fixed inset-y-0 right-0 z-50 flex w-[min(100vw-3rem,20rem)] flex-col border-l border-outline-variant/20 bg-background animate-[slide-in-right_0.25s_ease]">
        <div className="flex items-center justify-between border-b border-outline-variant/15 px-4 py-3">
          <span className="font-display-ui text-base font-semibold text-foreground">EvoFlow</span>
          <button
            className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-foreground-muted transition-colors hover:text-foreground"
            onClick={onClose}
            type="button"
            aria-label="Close menu"
          >
            <HamburgerIcon open />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          {items.map((item) => {
            const isExternal = item.href.startsWith("http");
            const isActive =
              !isExternal &&
              (pathname === item.href ||
                (item.href !== "/" &&
                  !item.href.includes("#") &&
                  pathname.startsWith(item.href)));
            const linkClass = [
              "flex items-center rounded-md px-3 py-3 text-[15px] font-normal transition-colors",
              isActive ? "bg-surface-high text-foreground" : "text-foreground hover:bg-surface-high/60",
            ].join(" ");
            if (isExternal) {
              return (
                <a
                  key={item.href}
                  className={linkClass}
                  href={item.href}
                  rel="noreferrer"
                  target="_blank"
                  onClick={onClose}
                >
                  {item.label}
                </a>
              );
            }
            return (
              <Link key={item.href} className={linkClass} href={item.href} onClick={onClose}>
                {item.label}
              </Link>
            );
          })}
        </div>
        <div className="border-t border-outline-variant/15 px-4 py-4">
          <a
            className={`${ctaClassName} w-full`}
            href={siteLinks.github}
            rel="noreferrer"
            target="_blank"
            onClick={onClose}
          >
            {githubCtaText}
          </a>
          <div className="mt-4 flex justify-center gap-6 text-sm text-foreground-muted">
            {locales.map((value) => (
              <button
                key={value}
                type="button"
                className={
                  locale === value
                    ? "font-medium text-foreground"
                    : "transition-colors hover:text-foreground"
                }
                onClick={() => setLocale(value)}
              >
                {value === "zh" ? "中文" : "English"}
              </button>
            ))}
          </div>
        </div>
      </nav>
    </>
  );
}

function DebugChip({ pathname, onDismiss }: { pathname: string; onDismiss: () => void }) {
  const locale =
    typeof document !== "undefined"
      ? (document.documentElement.getAttribute("data-locale") ?? "en")
      : "en";

  return (
    <div className="fixed bottom-6 left-6 z-[9998] animate-[slide-up_0.3s_ease]">
      <div className="rounded-2xl border border-white/10 bg-[#0a0a0a]/90 p-4 shadow-[0_8px_40px_rgba(0,0,0,0.6)] backdrop-blur-[20px]">
        <div className="mb-3 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-yellow-400/70">
              debug mode
            </span>
          </div>
          <button
            className="font-mono text-[10px] text-white/20 hover:text-white/60"
            onClick={onDismiss}
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="space-y-1 font-mono text-[11px]">
          <div className="flex items-center gap-3">
            <span className="w-16 text-white/30">route</span>
            <span className="text-yellow-300/80">{pathname}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-white/30">locale</span>
            <span className="text-yellow-300/80">{locale}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-white/30">build</span>
            <span className="text-yellow-300/80">v2.0.26</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-white/30">runtime</span>
            <span className="text-yellow-300/80">next.js edge</span>
          </div>
          <div className="mt-2 border-t border-white/5 pt-2 text-[10px] text-white/20">
            {locale === "zh" ? "你发现了第 2 个彩蛋 🥚" : "You found Easter egg #2 🥚"}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeaderLocaleText() {
  const { locale, locales, setLocale } = useSiteLocale();
  return (
    <div className="hidden items-center gap-1 text-sm text-foreground/70 md:flex">
      {locales.map((value, i) => (
        <span key={value} className="flex items-center gap-1">
          {i > 0 ? <span className="text-foreground/30">·</span> : null}
          <button
            type="button"
            className={
              locale === value
                ? "font-medium text-foreground"
                : "transition-colors hover:text-foreground"
            }
            onClick={() => setLocale(value)}
          >
            {value === "zh" ? "中文" : "EN"}
          </button>
        </span>
      ))}
    </div>
  );
}

export function SiteHeader() {
  const copy = useLocalizedValue(siteCopyByLocale);
  const { locale } = useSiteLocale();
  const githubStarsDisplay = useGithubRepoStarsDisplay(locale);
  const githubCtaText =
    githubStarsDisplay != null
      ? `${copy.shell.githubLabel} · ${githubStarsDisplay}`
      : copy.shell.githubLabel;
  const pathname = usePathname();

  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debugVisible, setDebugVisible] = useState(false);

  const handleLogoClick = useCallback(() => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    if (clickCountRef.current >= 5) {
      clickCountRef.current = 0;
      setDebugVisible(true);
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0;
      }, 1500);
    }
  }, []);

  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    [],
  );

  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  useSoundOnNavigate(pathname);

  if (pathname === "/terminal" || pathname === "/resume") return null;

  return (
    <>
      {debugVisible && <DebugChip onDismiss={() => setDebugVisible(false)} pathname={pathname} />}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-outline-variant/20 bg-background">
        <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between gap-6 px-4 md:h-16 md:px-8">
          <Link
            href="/"
            className="font-display-ui shrink-0 text-lg font-semibold tracking-[-0.04em] text-foreground transition-opacity hover:opacity-80 md:text-xl"
            onClick={handleLogoClick}
          >
            EvoFlow
          </Link>

          <div className="hidden min-w-0 flex-1 items-center justify-end gap-10 md:flex">
            <nav className="flex flex-wrap items-center justify-end gap-x-8 gap-y-1">
              {copy.shell.navigation.map((item) =>
                item.href.startsWith("http") ? (
                  <a
                    key={item.href}
                    className={navLinkClass}
                    href={item.href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link key={item.href} className={navLinkClass} href={item.href}>
                    {item.label}
                  </Link>
                ),
              )}
            </nav>
            <Link
              className={ctaClassName}
              href={siteLinks.github}
              rel="noreferrer"
              target="_blank"
              title={siteLinks.github}
            >
              {githubCtaText}
            </Link>
            <HeaderLocaleText />
            <ThemeToggle />
          </div>

          <div className="flex items-center gap-2 md:hidden">
            <ThemeToggle />
            <a
              className={ctaClassName}
              href={siteLinks.github}
              rel="noreferrer"
              target="_blank"
              title={siteLinks.github}
            >
              {githubCtaText}
            </a>
            <button
              className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-foreground"
              onClick={() => setMobileOpen(true)}
              type="button"
              aria-label="Open menu"
            >
              <HamburgerIcon open={false} />
            </button>
          </div>
        </div>
      </header>
      <MobileDrawer
        items={copy.shell.navigation}
        githubCtaText={githubCtaText}
        open={mobileOpen}
        onClose={closeMobile}
        pathname={pathname}
      />
    </>
  );
}
