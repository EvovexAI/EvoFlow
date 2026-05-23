import type { Metadata } from "next";
import { defaultLocale, getAllDocSlugs, getDocPageBySlug } from "@ai-site/content";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { DocsArticleWithLocale } from "@/components/docs/docs-page-client";
import { LOCALE_COOKIE_NAME, resolveSiteLocale } from "@/lib/site-locale";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getDocPageBySlug(slug);
  if (!page) {
    return { title: "Not found | EvoFlow" };
  }
  const locale =
    process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"
      ? defaultLocale
      : resolveSiteLocale((await cookies()).get(LOCALE_COOKIE_NAME)?.value);
  return {
    title: `${page.title[locale]} | EvoFlow`,
    description: page.description[locale],
  };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const page = getDocPageBySlug(slug);
  if (!page) {
    notFound();
  }
  return <DocsArticleWithLocale page={page} slug={slug} />;
}
