import type { ComponentPropsWithoutRef } from "react";

interface SectionHeadingProps extends ComponentPropsWithoutRef<"div"> {
  align?: "left" | "center";
  description?: string;
  eyebrow: string;
  title: string;
}

export function SectionHeading({
  align = "left",
  className = "",
  description,
  eyebrow,
  title,
  ...props
}: SectionHeadingProps) {
  const alignmentClassName =
    align === "center" ? "items-center text-center" : "items-start text-left";

  return (
    <div
      className={[
        "flex max-w-3xl flex-col gap-4",
        alignmentClassName,
        className,
      ].join(" ")}
      {...props}
    >
      <p className="font-label-ui text-xs uppercase tracking-[0.28em] text-foreground-muted">
        {eyebrow}
      </p>
      <h2 className="font-display-ui text-4xl font-semibold tracking-[-0.05em] md:text-6xl">
        {title}
      </h2>
      {description ? (
        <p className="max-w-2xl text-base leading-7 text-foreground-muted md:text-lg">
          {description}
        </p>
      ) : null}
    </div>
  );
}
