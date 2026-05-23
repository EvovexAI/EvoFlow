import { platformPagesByLocale } from "@ai-site/content";
import { ExperimentLabDetailPage } from "@/components/platform-pages/experiment-lab-pages";

export function generateStaticParams() {
  return platformPagesByLocale.zh.lab.experiments.map((e) => ({ slug: e.slug }));
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return <ExperimentLabDetailPage slug={slug} />;
}

