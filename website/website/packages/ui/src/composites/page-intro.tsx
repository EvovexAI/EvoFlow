import type { ComponentPropsWithoutRef } from "react";

type PageIntroVariant = "hero" | "inline";
type PageIntroAlign = "left" | "center";
type TitleTag = "h1" | "h2";

interface PageIntroProps extends ComponentPropsWithoutRef<"div"> {
  align?: PageIntroAlign;
  description?: string;
  eyebrow: string;
  title: string;
  titleAs?: TitleTag;
  variant?: PageIntroVariant;
}

const wrapperClassNames: Record<PageIntroVariant, string> = {
  hero: "flex max-w-5xl flex-col gap-4",
  inline:
    "flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-8",
};

const titleClassNames: Record<PageIntroVariant, string> = {
  hero: "mt-4 font-display-ui text-5xl font-bold tracking-[-0.05em] md:text-7xl",
  inline:
    "font-display-ui text-2xl font-semibold tracking-[-0.04em] md:text-3xl",
};

const descriptionClassNames: Record<PageIntroVariant, string> = {
  hero: "mt-6 max-w-2xl text-lg leading-8 text-foreground-muted",
  inline:
    "max-w-xl text-sm leading-7 text-foreground-muted md:text-right md:text-base",
};

export function PageIntro({
  align = "left",
  className = "",
  description,
  eyebrow,
  title,
  titleAs = "h1",
  variant = "hero",
  ...props
}: PageIntroProps) {
  const TitleTag = titleAs;
  const alignmentClassName =
    align === "center" ? "items-center text-center" : "items-start text-left";

  return (
    <div
      className={[
        wrapperClassNames[variant],
        alignmentClassName,
        className,
      ].join(" ")}
      {...props}
    >
      <div>
        <p className="font-label-ui text-xs uppercase tracking-[0.24em] text-foreground-muted">
          {eyebrow}
        </p>
        <TitleTag className={titleClassNames[variant]}>{title}</TitleTag>
      </div>

      {description ? (
        <p className={descriptionClassNames[variant]}>{description}</p>
      ) : null}
    </div>
  );
}
