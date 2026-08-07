"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  siteCopyByLocale,
  siteIdentity,
  siteUrlForDisplay,
  staticPageHref,
} from "@ai-site/content";
import { useLocalizedValue, useSiteLocale } from "./locale-provider";
import styles from "./site-chrome.module.css";

const footerExtraByLocale = {
  zh: {
    copyright: `© ${new Date().getFullYear()} Evovex AI，All Rights Reserved.`,
    siteLineLead: "软件官网",
  },
  en: {
    copyright: `© ${new Date().getFullYear()} Evovex AI. All Rights Reserved.`,
    siteLineLead: "Website",
  },
} as const;

export function SiteFooter() {
  const copy = useLocalizedValue(siteCopyByLocale);
  const { locale } = useSiteLocale();
  const pathname = usePathname();
  const extra = footerExtraByLocale[locale] ?? footerExtraByLocale.zh;

  if (pathname === "/terminal" || pathname.startsWith("/r/") || pathname === "/resume") {
    return null;
  }

  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerTop}>
          <div className={styles.footerBrand}>
            <p className={styles.footerBrandName}>{copy.footer.brand}</p>
            <p className={styles.footerTagline}>{copy.footer.tagline}</p>
          </div>

          <div className={styles.footerColumns}>
            {copy.footer.columns.map((col) => (
              <div key={col.title} className={styles.footerCol}>
                <p className={styles.footerColTitle}>{col.title}</p>
                {col.links.map((item) => {
                  const key = `${col.title}:${item.label}:${item.href}`;
                  if (item.href.startsWith("/")) {
                    return (
                      <Link key={key} className={styles.footerLink} href={staticPageHref(item.href)}>
                        {item.label}
                      </Link>
                    );
                  }
                  return (
                    <a
                      key={key}
                      className={styles.footerLink}
                      href={item.href}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {item.label}
                    </a>
                  );
                })}
              </div>
            ))}

            <div className={styles.footerCol}>
              <p className={styles.footerColTitle}>{copy.footer.contactTitle}</p>
              <a className={styles.footerLink} href={`mailto:${siteIdentity.contactEmail}`}>
                {siteIdentity.contactEmail}
              </a>
              <a className={styles.footerLink} href={siteIdentity.siteUrl} rel="noreferrer" target="_blank">
                {copy.footer.communityLabel}
              </a>
            </div>
          </div>
        </div>

        <div className={styles.footerBottom}>
          <p>{extra.copyright}</p>
          <p>
            {extra.siteLineLead}{" "}
            <a href={siteIdentity.siteUrl} rel="noreferrer" target="_blank">
              {siteUrlForDisplay()}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
