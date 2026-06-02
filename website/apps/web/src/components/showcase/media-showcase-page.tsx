"use client";

import {
  guiShowcaseImages,
  planShowcaseImages,
  planShowcaseVideos,
  showcasePageCopyByLocale,
  type ShowcaseImage,
} from "@ai-site/content";
import { GlassPanel } from "@ai-site/ui";
import { useLocalizedValue, useSiteLocale } from "../locale-provider";
import { ShowcaseImageTile, ShowcaseVideoBlock } from "./showcase-media-blocks";

function ImageGrid({ images, locale }: { images: ShowcaseImage[]; locale: "zh" | "en" }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {images.map((img) => (
        <ShowcaseImageTile key={img.src} image={img} locale={locale} />
      ))}
    </div>
  );
}

export function MediaShowcasePage() {
  const { locale } = useSiteLocale();
  const copy = useLocalizedValue(showcasePageCopyByLocale);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-10 md:px-6 md:pt-14">
      <header className="mb-12 max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-widest text-primary">Showcase</p>
        <h1 className="mt-2 font-display-ui text-3xl font-semibold tracking-[-0.04em] text-foreground md:text-4xl">
          {copy.title}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-foreground-muted">{copy.description}</p>
      </header>

      <section id="plan" className="scroll-mt-24 space-y-8">
        <GlassPanel className="p-6 md:p-8">
          <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.03em] text-foreground">
            {copy.planSection.title}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground-muted md:text-base">
            {copy.planSection.lead}
          </p>
        </GlassPanel>

        <div>
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-foreground-muted">
            {copy.planSection.videosTitle}
          </h3>
          <div className="grid gap-10">
            {planShowcaseVideos.map((v) => (
              <ShowcaseVideoBlock
                key={v.src}
                src={v.src}
                poster={v.poster}
                title={v.title[locale]}
                caption={v.caption[locale]}
              />
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-foreground-muted">
            {copy.planSection.galleryTitle}
          </h3>
          <ImageGrid images={planShowcaseImages} locale={locale} />
        </div>
      </section>

      <section id="gui" className="mt-16 scroll-mt-24 space-y-6">
        <GlassPanel className="p-6 md:p-8">
          <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.03em] text-foreground">
            {copy.guiSection.title}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground-muted md:text-base">
            {copy.guiSection.lead}
          </p>
        </GlassPanel>
        <ImageGrid images={guiShowcaseImages} locale={locale} />
      </section>
    </div>
  );
}
