import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalDetectedProfile, TerminalThemeProfile } from "./terminalProfileTypes.js";

type TerminalProfileDetector = {
  id: string;
  platforms?: readonly NodeJS.Platform[];
  detect: (env: NodeJS.ProcessEnv) => TerminalDetectedProfile | null;
};

const MACOS_PLIST_READ_TIMEOUT_MS = 2_000;

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function normalizeFontFamily(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeFontSize(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 6 || parsed > 72) {
    return null;
  }
  return parsed;
}

function readNestedString(value: unknown, pathSegments: readonly string[]): string | null {
  let current: unknown = value;
  for (const segment of pathSegments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? normalizeFontFamily(current) : null;
}

function readMacOsPlistFile(filePath: string): Record<string, unknown> | null {
  if (process.platform !== "darwin" || !existsSync(filePath)) {
    return null;
  }

  try {
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: MACOS_PLIST_READ_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // macOS 终端来源只是 best-effort 插件，plist 缺失、二进制格式异常或 plutil 失败都应静默跳过。
    return null;
  }

  return null;
}

function normalizeMacOsFontName(value: string | null | undefined): string | null {
  const normalized = normalizeFontFamily(value);
  if (!normalized) {
    return null;
  }

  const withoutSize = normalized.replace(/\s+\d+(?:\.\d+)?$/, "");
  return normalizeFontFamily(withoutSize.replace(/-/g, " "));
}

function readMacOsFontDescriptor(
  value: unknown,
): Pick<TerminalDetectedProfile, "fontFamily" | "fontSize"> {
  const raw = typeof value === "string" ? value : value?.toString();
  const fontFamily = normalizeMacOsFontName(raw) ?? undefined;
  const fontSize = normalizeFontSize(raw?.match(/\s+(\d+(?:\.\d+)?)$/)?.[1]) ?? undefined;
  return {
    fontFamily,
    fontSize,
  };
}

function readMacOsArchivedFontName(value: unknown): string | null {
  const rawData =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).NS?.toString()
        : null;
  const normalizedData = normalizeFontFamily(rawData);
  if (!normalizedData) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalizedData, "base64").toString("latin1");
    const match = decoded.match(
      /([A-Za-z][A-Za-z0-9 ._-]*(?:Mono|Code|Nerd|Powerline|Console|Menlo|Monaco|Courier|Cascadia|Consolas|Hack|Meslo)[A-Za-z0-9 ._-]*)/i,
    );
    return normalizeMacOsFontName(match?.[1]);
  } catch {
    return null;
  }
}

function normalizeColorComponent(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  if (parsed >= 0 && parsed <= 255) {
    return parsed / 255;
  }
  if (parsed >= 0 && parsed <= 65_535) {
    return parsed / 65_535;
  }
  return null;
}

function readColorRecordValue(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) {
      return record[name];
    }
  }
  return undefined;
}

function normalizeMacOsColor(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(trimmed) ||
      /^rgba?\(/i.test(trimmed)
    ) {
      return trimmed;
    }
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const red = normalizeColorComponent(
    readColorRecordValue(record, ["Red Component", "red", "Red"]),
  );
  const green = normalizeColorComponent(
    readColorRecordValue(record, ["Green Component", "green", "Green"]),
  );
  const blue = normalizeColorComponent(
    readColorRecordValue(record, ["Blue Component", "blue", "Blue"]),
  );
  const alpha =
    normalizeColorComponent(
      readColorRecordValue(record, ["Alpha Component", "alpha", "Alpha", "Opacity"]),
    ) ?? 1;
  if (red === null || green === null || blue === null) {
    return null;
  }

  const r = Math.round(red * 255);
  const g = Math.round(green * 255);
  const b = Math.round(blue * 255);
  if (alpha < 1) {
    return `rgba(${r}, ${g}, ${b}, ${+alpha.toFixed(3)})`;
  }
  return `#${[r, g, b].map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function readThemeColor(
  profile: Record<string, unknown>,
  theme: TerminalThemeProfile,
  themeKey: keyof TerminalThemeProfile,
  profileKeys: readonly string[],
): void {
  for (const profileKey of profileKeys) {
    const color = normalizeMacOsColor(profile[profileKey]);
    if (color) {
      theme[themeKey] = color;
      return;
    }
  }
}

const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function compactTheme(theme: TerminalThemeProfile): TerminalThemeProfile | undefined {
  return Object.keys(theme).length > 0 ? theme : undefined;
}

function readIterm2Theme(profile: Record<string, unknown>): TerminalThemeProfile | undefined {
  const theme: TerminalThemeProfile = {};
  readThemeColor(profile, theme, "foreground", ["Foreground Color"]);
  readThemeColor(profile, theme, "background", ["Background Color"]);
  readThemeColor(profile, theme, "cursor", ["Cursor Color"]);
  readThemeColor(profile, theme, "cursorAccent", ["Cursor Text Color"]);
  readThemeColor(profile, theme, "selectionBackground", ["Selection Color"]);

  ANSI_THEME_KEYS.forEach((themeKey, index) => {
    readThemeColor(profile, theme, themeKey, [`Ansi ${index} Color`, `ANSI ${index} Color`]);
  });
  return compactTheme(theme);
}

function readMacOsTerminalTheme(
  profile: Record<string, unknown>,
): TerminalThemeProfile | undefined {
  const theme: TerminalThemeProfile = {};
  readThemeColor(profile, theme, "foreground", ["TextColor"]);
  readThemeColor(profile, theme, "background", ["BackgroundColor"]);
  readThemeColor(profile, theme, "cursor", ["CursorColor"]);
  readThemeColor(profile, theme, "selectionBackground", ["SelectionColor"]);
  const terminalAnsiNames = [
    "ANSIBlackColor",
    "ANSIRedColor",
    "ANSIGreenColor",
    "ANSIYellowColor",
    "ANSIBlueColor",
    "ANSIMagentaColor",
    "ANSICyanColor",
    "ANSIWhiteColor",
    "ANSIBrightBlackColor",
    "ANSIBrightRedColor",
    "ANSIBrightGreenColor",
    "ANSIBrightYellowColor",
    "ANSIBrightBlueColor",
    "ANSIBrightMagentaColor",
    "ANSIBrightCyanColor",
    "ANSIBrightWhiteColor",
  ] as const;
  ANSI_THEME_KEYS.forEach((themeKey, index) => {
    const terminalAnsiName = terminalAnsiNames[index];
    if (terminalAnsiName) {
      readThemeColor(profile, theme, themeKey, [terminalAnsiName]);
    }
  });
  return compactTheme(theme);
}

function hasDetectedProfile(profile: TerminalDetectedProfile): boolean {
  return Boolean(profile.fontFamily || profile.fontSize || profile.theme);
}

function detectIterm2Profile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const plist = readMacOsPlistFile(
    join(homeDir, "Library", "Preferences", "com.googlecode.iterm2.plist"),
  );
  const profiles = Array.isArray(plist?.["New Bookmarks"])
    ? (plist["New Bookmarks"] as unknown[])
    : [];
  const defaultProfile = profiles.find(
    (profile) =>
      typeof profile === "object" &&
      profile !== null &&
      !Array.isArray(profile) &&
      (profile as Record<string, unknown>)["Default Bookmark"] === true,
  );
  const orderedProfiles = defaultProfile
    ? [defaultProfile, ...profiles.filter((profile) => profile !== defaultProfile)]
    : profiles;

  for (const profile of orderedProfiles) {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
      continue;
    }
    const profileObject = profile as Record<string, unknown>;
    const detectedProfile = {
      ...readMacOsFontDescriptor(profileObject["Normal Font"]),
      theme: readIterm2Theme(profileObject),
    } satisfies TerminalDetectedProfile;
    if (hasDetectedProfile(detectedProfile)) {
      return detectedProfile;
    }
  }

  return null;
}

function detectMacOsTerminalProfile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const plist = readMacOsPlistFile(
    join(homeDir, "Library", "Preferences", "com.apple.Terminal.plist"),
  );
  const settingsNames = [
    readNestedString(plist, ["Startup Window Settings"]),
    readNestedString(plist, ["Default Window Settings"]),
  ].filter((name): name is string => Boolean(name));

  for (const settingsName of settingsNames) {
    const settings = plist?.[settingsName];
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      continue;
    }

    const settingsObject = settings as Record<string, unknown>;
    const fontFamily =
      readNestedString(settingsObject, ["FontName"]) ??
      normalizeMacOsFontName(readNestedString(settingsObject, ["Font"])) ??
      readMacOsArchivedFontName(settingsObject.Font);
    const detectedProfile = {
      fontFamily: fontFamily ?? undefined,
      fontSize:
        normalizeFontSize(settingsObject.FontSize) ??
        readMacOsFontDescriptor(settingsObject.Font).fontSize,
      theme: readMacOsTerminalTheme(settingsObject),
    } satisfies TerminalDetectedProfile;
    if (hasDetectedProfile(detectedProfile)) {
      return detectedProfile;
    }
  }

  return null;
}

export function createMacOsTerminalProfileDetectors(): readonly TerminalProfileDetector[] {
  return [
    {
      id: "iterm2",
      platforms: ["darwin"],
      detect: detectIterm2Profile,
    },
    {
      id: "macos-terminal",
      platforms: ["darwin"],
      detect: detectMacOsTerminalProfile,
    },
  ];
}
