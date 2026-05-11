export const colors = {
  surface: "#131313",
  surfaceLowest: "#0e0e0e",
  surfaceLow: "#1c1b1b",
  surfaceHigh: "#2a2a2a",
  surfaceBright: "#3a3939",
  foreground: "#e5e2e1",
  foregroundMuted: "#c7c4d7",
  primary: "#d0bcff",
  primaryContainer: "#a078ff",
  secondary: "#5de6ff",
  tertiary: "#ffb95f",
  outlineVariant: "#464554",
} as const;

export const gradients = {
  soul: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryContainer} 100%)`,
  aurora:
    "radial-gradient(circle at 50% -20%, rgba(99, 102, 241, 0.2) 0%, rgba(34, 211, 238, 0.07) 35%, transparent 70%)",
} as const;
