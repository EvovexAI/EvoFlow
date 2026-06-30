import type { Metadata } from "next";
import { defaultLocale, getAllDocSlugs, getDocPageBySlug, getDocSlugRedirect, getLegacyDocRedirectSlugs } from "@ai-site/content";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DocsArticleWithLocale } from "@/components/docs/docs-page-client";
import { LOCALE_COOKIE_NAME, resolveSiteLocale } from "@/lib/site-locale";

export function generateStaticParams() {
  const slugs = [...getAllDocSlugs(), ...getLegacyDocRedirectSlugs()];
  const seen = new Set<string>();
  return slugs
    .filter((slug) => {
      const key = slug.join("/");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const redirectTo = getDocSlugRedirect(slug);
  const page = getDocPageBySlug(redirectTo ?? slug);
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
  const redirectTo = getDocSlugRedirect(slug);
  if (redirectTo) {
    redirect(`/docs/${redirectTo.join("/")}`);
  }
  const page = getDocPageBySlug(slug);
  if (!page) {
    notFound();
  }
  return <DocsArticleWithLocale page={page} slug={slug} />;
}
