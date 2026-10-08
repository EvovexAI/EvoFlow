import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppSettings } from "@zcode/shared";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { createMacOsTerminalProfileDetectors } from "./terminalProfileMacOs.js";
import type {
  TerminalDetectedProfile,
  TerminalFontFamilySource,
  TerminalThemeProfile,
} from "./terminalProfileTypes.js";
export type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfileTypes.js";

interface TerminalFontProfile {
  fontFamily: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
  source: TerminalFontFamilySource;
}

interface TerminalFontProfileInput {
  settings: Pick<AppSettings, "terminalFontFamily" | "terminalInheritSystemProfile">;
  env?: NodeJS.ProcessEnv;
}

type TerminalFontDetector = {
  id: string;
  platforms?: readonly NodeJS.Platform[];
  detect: (env: NodeJS.ProcessEnv) => TerminalDetectedProfile | null;
};

const FONT_FAMILY_FALLBACKS = [
  "ui-monospace",
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Cascadia Mono",
  "JetBrains Mono",
  "MesloLGS NF",
  "Hack Nerd Font",
  "Noto Sans Mono CJK SC",
  "monospace",
] as const;

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function normalizeFontFamily(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeDetectedProfile(
  profile: TerminalDetectedProfile | null,
): TerminalDetectedProfile | null {
  if (!profile?.fontFamily && !profile?.fontSize && !profile?.theme) {
    return null;
  }
  return profile;
}

function dedupeFontFamilyStack(primary: string): string {
  const stack = primary
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const fallback of FONT_FAMILY_FALLBACKS) {
    if (!stack.includes(fallback)) {
      stack.push(fallback);
    }
  }
  return stack.join(", ");
}

function stripJsonComments(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      result += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

function removeJsonTrailingCommas(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(raw[nextIndex] ?? "")) nextIndex += 1;
      if (raw[nextIndex] === "}" || raw[nextIndex] === "]") continue;
    }
    result += char;
  }
  return result;
}

function parseJsonc(raw: string): Record<string, unknown> | null {
  const attempts = [raw, removeJsonTrailingCommas(stripJsonComments(raw))];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function readJsoncFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    return parseJsonc(raw);
  } catch {
    return null;
  }
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

function readObjectFile(
  filePath: string,
  parser: (raw: string) => unknown,
): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = parser(readFileSync(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function detectWindowsTerminalFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  if (process.platform !== "win32") {
    return null;
  }

  const localAppData = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (!localAppData) {
    return null;
  }

  const candidates = [
    join(
      localAppData,
      "Packages",
      "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
      "LocalState",
      "settings.json",
    ),
    join(
      localAppData,
      "Packages",
      "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe",
      "LocalState",
      "settings.json",
    ),
    join(localAppData, "Microsoft", "Windows Terminal", "settings.json"),
  ];

  for (const filePath of candidates) {
    const parsed = readJsoncFile(filePath);
    if (!parsed) {
      continue;
    }

    const defaultProfileId = readNestedString(parsed, ["defaultProfile"]);
    const profiles = parsed.profiles as Record<string, unknown> | undefined;
    const list = Array.isArray(profiles?.list) ? profiles?.list : [];
    if (defaultProfileId) {
      for (const item of list) {
        const profile = item as Record<string, unknown> | undefined;
        if (!profile || profile.guid !== defaultProfileId) {
          continue;
        }
        const fontFamily = readNestedString(profile, ["font", "face"]);
        if (fontFamily) {
          return { fontFamily };
        }
      }
    }

    const defaults = profiles?.defaults as Record<string, unknown> | undefined;
    const defaultsFont = readNestedString(defaults, ["font", "face"]);
    if (defaultsFont) {
      return { fontFamily: defaultsFont };
    }

    for (const item of list) {
      const profile = item as Record<string, unknown> | undefined;
      if (!profile) {
        continue;
      }
      const fontFamily = readNestedString(profile, ["font", "face"]);
      if (fontFamily) {
        return { fontFamily };
      }
    }
  }

  return null;
}

function detectVsCodeTerminalFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const appData = env.APPDATA?.trim();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const candidates = [
    appData && join(appData, "Code", "User", "settings.json"),
    appData && join(appData, "Code - Insiders", "User", "settings.json"),
    xdgConfigHome && join(xdgConfigHome, "Code", "User", "settings.json"),
    xdgConfigHome && join(xdgConfigHome, "Code - Insiders", "User", "settings.json"),
    join(homeDir, ".config", "Code", "User", "settings.json"),
    join(homeDir, ".config", "Code - Insiders", "User", "settings.json"),
    join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
    join(homeDir, "Library", "Application Support", "Code - Insiders", "User", "settings.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const filePath of candidates) {
    const parsed = readJsoncFile(filePath);
    const fontFamily = readNestedString(parsed, ["terminal.integrated.fontFamily"]);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  return null;
}

function detectKittyFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  const candidates = [
    join(xdgConfigHome, "kitty", "kitty.conf"),
    join(homeDir, "Library", "Application Support", "kitty", "kitty.conf"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const raw = readFileSync(filePath, "utf8");
      const match = raw.match(/^\s*font_family\s+(.+)$/m);
      const fontFamily = normalizeFontFamily(match?.[1]);
      if (fontFamily) {
        return { fontFamily: fontFamily.replace(/^"|"$/g, "") };
      }
    } catch {
      // continue
    }
  }

  return null;
}

function detectAlacrittyFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  const tomlCandidates = [
    join(xdgConfigHome, "alacritty", "alacritty.toml"),
    join(homeDir, ".alacritty.toml"),
  ];
  const yamlCandidates = [
    join(xdgConfigHome, "alacritty", "alacritty.yml"),
    join(xdgConfigHome, "alacritty", "alacritty.yaml"),
  ];

  for (const filePath of tomlCandidates) {
    const parsed = readObjectFile(filePath, parseToml);
    const fontFamily = readNestedString(parsed, ["font", "normal", "family"]);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  for (const filePath of yamlCandidates) {
    const parsed = readObjectFile(filePath, parseYaml);
    const fontFamily = readNestedString(parsed, ["font", "normal", "family"]);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  return null;
}

const TERMINAL_FONT_DETECTORS: readonly TerminalFontDetector[] = [
  {
    id: "windows-terminal",
    platforms: ["win32"],
    detect: detectWindowsTerminalFontFamily,
  },
  {
    id: "vscode",
    detect: detectVsCodeTerminalFontFamily,
  },
  ...createMacOsTerminalProfileDetectors(),
  {
    id: "kitty",
    platforms: ["darwin", "linux", "freebsd", "openbsd"],
    detect: detectKittyFontFamily,
  },
  {
    id: "alacritty",
    platforms: ["darwin", "linux", "freebsd", "openbsd"],
    detect: detectAlacrittyFontFamily,
  },
];

function detectSystemTerminalProfile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  for (const detector of TERMINAL_FONT_DETECTORS) {
    if (detector.platforms && !detector.platforms.includes(process.platform)) {
      continue;
    }
    const profile = normalizeDetectedProfile(detector.detect(env));
    if (profile) {
      return profile;
    }
  }

  return null;
}

export function resolveTerminalFontProfile(input: TerminalFontProfileInput): TerminalFontProfile {
  const env = input.env ?? process.env;
  const customFontFamily = normalizeFontFamily(input.settings.terminalFontFamily);
  const detectedProfile =
    input.settings.terminalInheritSystemProfile !== false ? detectSystemTerminalProfile(env) : null;
  if (customFontFamily) {
    return {
      fontFamily: dedupeFontFamilyStack(customFontFamily),
      fontSize: detectedProfile?.fontSize,
      theme: detectedProfile?.theme,
      source: "custom",
    };
  }

  if (detectedProfile) {
    return {
      // macOS 用户终端样式不只包含字体族，还包含字号和配色；
      // 读不到字体族时不能整体放弃系统 profile，否则仅配置配色的终端无法继承到面板。
      fontFamily: dedupeFontFamilyStack(detectedProfile.fontFamily ?? FONT_FAMILY_FALLBACKS[0]),
      fontSize: detectedProfile.fontSize,
      theme: detectedProfile.theme,
      source: "system",
    };
  }

  return {
    fontFamily: FONT_FAMILY_FALLBACKS.join(", "),
    source: "fallback",
  };
}
