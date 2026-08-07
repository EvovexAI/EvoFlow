"use client";

import Link from "next/link";
import { siteCopyByLocale, siteLinks, staticPageHref } from "@ai-site/content";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalizedValue, useSiteLocale } from "./locale-provider";
import { useGithubRepoStarsDisplay } from "@/hooks/use-github-repo-stars";
import { useSoundOnNavigate } from "@/hooks/use-sound";
import { Menu, X } from "lucide-react";
import styles from "./site-chrome.module.css";

function isInternalNavActive(pathname: string, href: string): boolean {
  if (href.startsWith("http")) return false;
  if (href.includes("#")) return pathname === href;
  const target = staticPageHref(href);
  const p = pathname.replace(/\/+$/, "") || "/";
  const t = target.replace(/\/+$/, "") || "/";
  if (t === "/") return p === "/";
  return p === t || p.startsWith(`${t}/`);
}

function MobileDrawer({
  items,
  open,
  onClose,
  pathname,
  downloadLabel,
  githubLabel,
}: {
  items: Array<{ href: string; label: string }>;
  open: boolean;
  onClose: () => void;
  pathname: string;
  downloadLabel: string;
  githubLabel: string;
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
      <div className={styles.drawerMask} onClick={onClose} />
      <nav className={styles.drawer}>
        <div className={styles.drawerHead}>
          <span className={styles.logoText}>EvoFlow</span>
          <button className={styles.iconBtn} onClick={onClose} type="button" aria-label="Close menu">
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>
        <div className={styles.drawerBody}>
          {items.map((item) => {
            const isExternal = item.href.startsWith("http");
            const isActive = !isExternal && isInternalNavActive(pathname, item.href);
            const className = `${styles.drawerLink} ${isActive ? styles.drawerLinkActive : ""}`;
            if (isExternal) {
              return (
                <a key={item.href} className={className} href={item.href} rel="noreferrer" target="_blank" onClick={onClose}>
                  {item.label}
                </a>
              );
            }
            return (
              <Link key={item.href} className={className} href={staticPageHref(item.href)} onClick={onClose}>
                {item.label}
              </Link>
            );
          })}
        </div>
        <div className={styles.drawerFoot}>
          <a className={styles.btnGhost} href={siteLinks.github} rel="noreferrer" target="_blank" onClick={onClose}>
            {githubLabel}
          </a>
          <a className={styles.btnDark} href={siteLinks.blog} rel="noreferrer" target="_blank" onClick={onClose}>
            {downloadLabel}
          </a>
          <div className={styles.localeRow}>
            {locales.map((value) => (
              <button
                key={value}
                type="button"
                className={locale === value ? styles.localeActive : styles.localeIdle}
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

function HeaderLocaleText() {
  const { locale, locales, setLocale } = useSiteLocale();
  return (
    <div className={styles.localeDesktop}>
      {locales.map((value, i) => (
        <span key={value} className={styles.localeItem}>
          {i > 0 ? <span className={styles.localeDot}>·</span> : null}
          <button
            type="button"
            className={locale === value ? styles.localeActive : styles.localeIdle}
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
  const githubLabel =
    githubStarsDisplay != null
      ? `${copy.shell.githubLabel} · ${githubStarsDisplay}`
      : copy.shell.githubLabel;
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  useSoundOnNavigate(pathname);

  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLogoClick = useCallback(() => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    if (clickCountRef.current >= 5) {
      clickCountRef.current = 0;
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0;
      }, 1500);
    }
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    [],
  );

  if (pathname === "/terminal" || pathname.startsWith("/r/") || pathname === "/resume") {
    return null;
  }

  return (
    <>
      <header className={`${styles.header} ${scrolled ? styles.headerScrolled : ""}`}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.logo} onClick={handleLogoClick}>
            EvoFlow
          </Link>

          <nav className={styles.navDesktop}>
            {copy.shell.navigation.map((item) => {
              const isExternal = item.href.startsWith("http");
              const isActive = !isExternal && isInternalNavActive(pathname, item.href);
              const className = `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`;
              if (isExternal) {
                return (
                  <a key={item.href} className={className} href={item.href} rel="noreferrer" target="_blank">
                    {item.label}
                  </a>
                );
              }
              return (
                <Link key={item.href} className={className} href={staticPageHref(item.href)}>
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className={styles.headerActions}>
            <HeaderLocaleText />
            <a className={styles.btnGhost} href={siteLinks.github} rel="noreferrer" target="_blank">
              {githubLabel}
            </a>
            <a className={styles.btnDark} href={siteLinks.blog} rel="noreferrer" target="_blank">
              {copy.shell.downloadLabel}
            </a>
          </div>

          <div className={styles.headerMobileActions}>
            <a className={styles.btnDark} href={siteLinks.blog} rel="noreferrer" target="_blank">
              {copy.shell.downloadLabel}
            </a>
            <button
              className={styles.iconBtn}
              onClick={() => setMobileOpen(true)}
              type="button"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </header>
      <div className={styles.headerSpacer} aria-hidden />
      <MobileDrawer
        items={copy.shell.navigation}
        downloadLabel={copy.shell.downloadLabel}
        githubLabel={githubLabel}
        open={mobileOpen}
        onClose={closeMobile}
        pathname={pathname}
      />
    </>
  );
}
