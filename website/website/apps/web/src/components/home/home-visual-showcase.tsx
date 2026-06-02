"use client";

import {
  guiShowcaseImages,
  homeVisualShowcaseByLocale,
  planShowcaseImages,
  planShowcaseVideos,
} from "@ai-site/content";
import { useLocalizedValue, useSiteLocale } from "../locale-provider";
import {
  ShowcaseImageTile,
  ShowcaseMoreLink,
  ShowcaseVideoBlock,
  pickShowcaseImage,
} from "../showcase/showcase-media-blocks";

const HOME_PLAN_SNAPSHOTS = [
  "plan-02-structured-plan-modal.png",
  "plan-02-structured-plan-modal-2.png",
  "plan-05-supervisor-workflow-panel.png",
] as const;

const HOME_GUI_SNAPSHOTS = ["agents-preset-teams.png", "agents-preset-roles.png"] as const;

export function HomeVisualShowcase({ className = "" }: { className?: string }) {
  const { locale } = useSiteLocale();
  const copy = useLocalizedValue(homeVisualShowcaseByLocale);

  const planShots = HOME_PLAN_SNAPSHOTS.map((name) => pickShowcaseImage(name, planShowcaseImages)).filter(
    Boolean,
  ) as typeof planShowcaseImages;
  const guiShots = HOME_GUI_SNAPSHOTS.map((name) => pickShowcaseImage(name, guiShowcaseImages)).filter(
    Boolean,
  ) as typeof guiShowcaseImages;

  return (
    <div
      className={[
        "animate-fade-up relative overflow-hidden rounded-[28px] border border-white/[0.06] bg-white/[0.02] p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] md:p-8",
        className,
      ].join(" ")}
      style={{ animationDelay: "160ms" }}
    >
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-primary/90">{copy.eyebrow}</p>
          <h2 className="font-display-ui mt-2 text-xl font-semibold tracking-[-0.03em] text-foreground md:text-2xl">
            {copy.title}
          </h2>
          <p className="mt-2 text-sm leading-7 text-foreground-muted md:text-[15px]">{copy.lead}</p>
        </div>
        <ShowcaseMoreLink href="/showcase/" label={copy.moreLabel} />
      </div>

      <div className="relative mt-8 grid gap-8 lg:grid-cols-2">
        {planShowcaseVideos.map((v: (typeof planShowcaseVideos)[number]) => (
          <ShowcaseVideoBlock
            key={v.src}
            src={v.src}
            poster={v.poster}
            title={v.title[locale]}
            caption={v.caption[locale]}
          />
        ))}
      </div>

      <div className="relative mt-8">
        <p className="mb-4 font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
          {copy.snapshotsLabel}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {planShots.map((img) => (
            <ShowcaseImageTile key={img.src} image={img} locale={locale} compact />
          ))}
          {guiShots.map((img) => (
            <ShowcaseImageTile key={img.src} image={img} locale={locale} compact />
          ))}
        </div>
      </div>
    </div>
  );
}
