"use client";

import Link from "next/link";
import type { ShowcaseImage, ShowcaseVideo } from "@ai-site/content";
import { staticPageHref } from "@ai-site/content";

export function ShowcaseVideoBlock({
  src,
  poster,
  title,
  caption,
}: {
  src: string;
  poster: string;
  title: string;
  caption: string;
}) {
  return (
    <figure className="space-y-3">
      <video
        className="w-full rounded-xl border border-outline-variant/25 bg-surface-lowest shadow-sm"
        controls
        playsInline
        preload="metadata"
        poster={poster}
      >
        <source src={src} type="video/mp4" />
      </video>
      <figcaption className="text-center text-sm text-foreground-muted">
        <span className="font-medium text-foreground">{title}</span>
        <span className="mt-1 block">{caption}</span>
      </figcaption>
    </figure>
  );
}

export function ShowcaseImageTile({
  image,
  locale,
  compact,
}: {
  image: ShowcaseImage;
  locale: "zh" | "en";
  compact?: boolean;
}) {
  return (
    <figure className="space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.src}
        alt={image.alt[locale]}
        className={[
          "w-full rounded-lg border border-outline-variant/20 bg-surface-lowest object-contain shadow-sm",
          compact ? "max-h-48 md:max-h-56" : "",
        ].join(" ")}
        loading="lazy"
      />
      <figcaption className={["text-center text-foreground-muted", compact ? "text-xs" : "text-xs"].join(" ")}>
        {image.caption[locale]}
      </figcaption>
    </figure>
  );
}

export function ShowcaseMoreLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={staticPageHref(href)}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
    >
      {label}
      <span aria-hidden>→</span>
    </Link>
  );
}

export function pickShowcaseImage(srcSuffix: string, images: ShowcaseImage[]): ShowcaseImage | undefined {
  return images.find((img) => img.src.endsWith(srcSuffix));
}
