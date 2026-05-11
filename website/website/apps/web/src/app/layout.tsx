import type { Metadata, Viewport } from "next";
import { defaultLocale } from "@ai-site/content";
import "./globals.css";
import { Providers } from "./providers";
import { SiteBackground } from "@/components/site-background";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { LiveCursors } from "@/components/live-cursors";
import { LOCALE_COOKIE_NAME, resolveSiteLocale, toHtmlLang } from "@/lib/site-locale";
import { cookies } from "next/headers";
import { siteIdentity } from "@ai-site/content";

const SITE_URL = siteIdentity.siteUrl;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "EvoFlow | Super-agent orchestration",
    template: "%s | EvoFlow",
  },
  description:
    "EvoFlow：多智能体编排、沙箱执行、记忆与上下文治理、Skills/MCP 业务集成；面向工单、运维、内部 Copilot 与企业 RAG 等可观测交付场景。官网说明架构分层、能力矩阵、典型场景与演进节奏。",
  openGraph: {
    type: "website",
    siteName: siteIdentity.publisherName,
    locale: "zh_CN",
    alternateLocale: "en_US",
    url: SITE_URL,
    title: "EvoFlow | Super-agent orchestration",
    description:
      "Multi-agent orchestration, sandboxed execution, memory, Skills and MCP integrations—scenarios, architecture, and roadmap for EvoFlow.",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "EvoFlow" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "EvoFlow | Super-agent orchestration",
    description:
      "EvoFlow: orchestration, sandbox, memory, Skills/MCP—architecture, scenarios, and evolution.",
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "EvoFlow",
  url: SITE_URL,
  description:
    "EvoFlow super-agent stack: orchestration, sandboxed tools, durable memory, Skills and MCP—downloadable builds and docs; star on GitHub for updates. Scenarios include tickets, ops, copilots, and enterprise RAG.",
  author: {
    "@type": "Organization",
    name: siteIdentity.publisherName,
    url: siteIdentity.siteUrl,
    email: siteIdentity.contactEmail,
    sameAs: ["https://github.com/EvovexAI/EvoFlow"],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale =
    process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"
      ? defaultLocale
      : resolveSiteLocale((await cookies()).get(LOCALE_COOKIE_NAME)?.value);

  return (
    <html
      lang={toHtmlLang(locale)}
      data-locale={locale}
      suppressHydrationWarning
      className="h-full font-sans antialiased"
    >
      <body
        className={`min-h-full bg-background font-sans text-foreground${locale === "zh" ? " site-typography-zh" : ""}`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <Providers initialLocale={locale}>
          <SiteBackground />
          <div className="relative flex min-h-full flex-col overflow-x-clip">
            <SiteHeader />
            {children}
            <SiteFooter />
          </div>
          <LiveCursors />
        </Providers>
      </body>
    </html>
  );
}
