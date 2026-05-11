import type { MetadataRoute } from "next";
import { siteIdentity } from "@ai-site/content";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/admin/", "/terminal", "/terminal/"],
      },
    ],
    sitemap: `${siteIdentity.siteUrl}/sitemap.xml`,
  };
}
