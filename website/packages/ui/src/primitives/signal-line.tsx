import type { AccentTone } from "../tokens/accents";

interface SignalLineProps {
  accent?: AccentTone;
  direction?: "horizontal" | "vertical";
  glow?: boolean;
  className?: string;
}

const accentViaColors: Record<AccentTone, string> = {
  primary: "via-primary/40",
  secondary: "via-secondary/40",
  tertiary: "via-tertiary/40",
};

export function SignalLine({
  accent = "primary",
  direction = "horizontal",
  glow = false,
  className = "",
}: SignalLineProps) {
  const isH = direction === "horizontal";

  return (
    <div
      className={[
        isH ? "h-px w-full" : "h-full w-px",
        `bg-gradient-to-${isH ? "r" : "b"} from-transparent ${accentViaColors[accent]} to-transparent`,
        glow && `shadow-[0_0_8px_0] shadow-${accent === "primary" ? "primary" : accent === "secondary" ? "secondary" : "tertiary"}/20`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
