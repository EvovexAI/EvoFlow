export type AccentTone = "primary" | "secondary" | "tertiary";

export const accentTextClassNames: Record<AccentTone, string> = {
  primary: "text-primary",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
};

export const accentDotClassNames: Record<AccentTone, string> = {
  primary: "bg-primary shadow-[0_0_16px_rgba(208,188,255,0.8)]",
  secondary: "bg-secondary shadow-[0_0_16px_rgba(93,230,255,0.8)]",
  tertiary: "bg-tertiary shadow-[0_0_16px_rgba(255,185,95,0.8)]",
};

export const accentGlowClassNames: Record<AccentTone, string> = {
  primary: "from-primary/25 to-primary-container/10",
  secondary: "from-secondary/20 to-secondary/10",
  tertiary: "from-tertiary/20 to-tertiary/10",
};

export const accentLineClassNames: Record<AccentTone, string> = {
  primary: "from-primary to-primary-container",
  secondary: "from-secondary to-primary",
  tertiary: "from-tertiary to-primary-container",
};
