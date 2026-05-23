import type { Metadata } from "next";
import { defaultLocale, docsIndexCopy } from "@ai-site/content";
import { cookies } from "next/headers";
import { DocsHomeWithLocale } from "@/components/docs/docs-page-client";
import { LOCALE_COOKIE_NAME, resolveSiteLocale } from "@/lib/site-locale";

export async function generateMetadata(): Promise<Metadata> {
  const locale =
    process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"
      ? defaultLocale
      : resolveSiteLocale((await cookies()).get(LOCALE_COOKIE_NAME)?.value);
  const c = docsIndexCopy(locale);
  return {
    title: `${c.title} | EvoFlow`,
    description: c.description,
  };
}

export default function DocsIndexPage() {
  return <DocsHomeWithLocale />;
}
