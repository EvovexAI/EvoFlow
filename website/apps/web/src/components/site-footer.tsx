"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type LocalizedValue, siteCopyByLocale, siteIdentity, siteUrlForDisplay } from "@ai-site/content";
import { useLocalizedValue } from "./locale-provider";

const footerExtraByLocale: LocalizedValue<{
  copyright: string;
  siteLineLead: string;
}> = {
  zh: {
    copyright: `© ${new Date().getFullYear()} ${siteIdentity.publisherName}。保留所有权利。`,
    siteLineLead: "软件官网：",
  },
  en: {
    copyright: `© ${new Date().getFullYear()} ${siteIdentity.publisherName}. All rights reserved.`,
    siteLineLead: "Site:",
  },
};

export function SiteFooter() {
  const copy = useLocalizedValue(siteCopyByLocale);
  const extra = useLocalizedValue(footerExtraByLocale);
  const pathname = usePathname();
  const navLinkClass =
    "py-1.5 font-body-ui text-sm font-normal tracking-normal text-foreground-muted transition-colors duration-300 hover:text-primary";

  if (pathname === "/terminal" || pathname === "/resume") {
    return null;
  }

  return (
    <footer className="border-t border-outline-variant/20 bg-surface-lowest">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-10 md:px-6">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="font-display-ui text-lg font-semibold tracking-[-0.04em] text-primary">
              {copy.footer.brand}
            </p>
            <p className="mt-2 max-w-xl font-body-ui text-sm font-normal leading-relaxed tracking-normal text-foreground-muted">
              {copy.footer.tagline}
            </p>
          </div>

          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <div className="flex flex-col gap-1">
              {copy.footer.links.map((item) => {
                const linkKey = `${item.label}:${item.href}`;
                if (item.href.startsWith("/")) {
                  return (
                    <Link key={linkKey} className={navLinkClass} href={item.href}>
                      {item.label}
                    </Link>
                  );
                }
                return (
                  <a
                    key={linkKey}
                    className={navLinkClass}
                    href={item.href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-outline-variant/10 pt-6">
          <p className="font-body-ui text-xs font-normal tracking-normal text-foreground-muted/60">
            {extra.copyright}
          </p>
          <p className="mt-2 font-body-ui text-xs font-normal tracking-normal text-foreground-muted/60">
            <span>{extra.siteLineLead}</span>{" "}
            <a
              className="underline-offset-2 hover:text-primary hover:underline"
              href={siteIdentity.siteUrl}
              rel="noreferrer"
              target="_blank"
            >
              {siteUrlForDisplay()}
            </a>
            {" · "}
            <a
              className="underline-offset-2 hover:text-primary hover:underline"
              href={`mailto:${siteIdentity.contactEmail}`}
            >
              {siteIdentity.contactEmail}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
