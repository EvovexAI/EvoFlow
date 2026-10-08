export type TerminalFontFamilySource = "custom" | "system" | "fallback";

export interface TerminalThemeProfile {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalDetectedProfile {
  fontFamily?: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
}
