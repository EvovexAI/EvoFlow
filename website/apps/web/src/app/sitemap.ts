import type { MetadataRoute } from "next";
import { getAllDocSlugs, platformPagesByLocale, siteIdentity, staticPageHref } from "@ai-site/content";

const SITE_URL = siteIdentity.siteUrl;

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString();

  const docPaths = [
    "/docs",
    ...getAllDocSlugs().map((segs) => `/docs/${segs.join("/")}`),
  ];

  const staticPages = [
    { path: "/", priority: 1.0, changeFrequency: "weekly" as const },
    { path: "/about", priority: 0.8, changeFrequency: "monthly" as const },
    { path: "/presentations/plan-workflow", priority: 0.85, changeFrequency: "monthly" as const },
    { path: "/presentations/guides", priority: 0.85, changeFrequency: "monthly" as const },
    { path: "/presentations/guides/getting-started/models-and-chat", priority: 0.82, changeFrequency: "monthly" as const },
    { path: "/presentations/guides/creation/short-video", priority: 0.8, changeFrequency: "monthly" as const },
    { path: "/showcase", priority: 0.85, changeFrequency: "monthly" as const },
    { path: "/evolution", priority: 0.7, changeFrequency: "weekly" as const },
    { path: "/lab", priority: 0.5, changeFrequency: "monthly" as const },
    ...platformPagesByLocale.zh.lab.experiments.map((e) => ({
      path: `/lab/${e.slug}`,
      priority: 0.45 as const,
      changeFrequency: "monthly" as const,
    })),
    ...docPaths.map((path) => ({
      path,
      priority: 0.75 as const,
      changeFrequency: "weekly" as const,
    })),
  ];

  return staticPages.map((page) => ({
    url: `${SITE_URL}${staticPageHref(page.path)}`,
    lastModified: now,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
