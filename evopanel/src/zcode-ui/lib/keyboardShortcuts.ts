export interface KeyboardShortcutPlatformInfo {
  platform?: string;
  userAgent?: string;
}

interface PrimaryShortcutKeyboardEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function readNavigatorPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

export function isAppleKeyboardPlatform(
  platformInfo: KeyboardShortcutPlatformInfo = readNavigatorPlatformInfo(),
): boolean {
  const platform = platformInfo.platform?.toLowerCase() ?? "";
  const userAgent = platformInfo.userAgent ?? "";

  if (
    platform.includes("mac") ||
    platform.includes("iphone") ||
    platform.includes("ipad") ||
    platform.includes("ipod")
  ) {
    return true;
  }

  return /Mac|iPhone|iPad|iPod/.test(userAgent);
}

function getCommandModifierLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? "⌘" : "Ctrl";
}

function formatAppleShortcutLabel(...parts: string[]): string {
  return parts.join(" ");
}

export function formatCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const mod = getCommandModifierLabel(platformInfo);
  if (isAppleKeyboardPlatform(platformInfo)) {
    return formatAppleShortcutLabel(mod, formatShortcutKeyLabel(key));
  }
  return `${mod}+${key.toUpperCase()}`;
}

function formatShortcutKeyLabel(key: string): string {
  switch (key) {
    case "[":
      return "[";
    case "]":
      return "]";
    default:
      return key.toUpperCase();
  }
}

export function matchesPrimaryShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

function matchesPrimaryModifier(
  event: PrimaryShortcutKeyboardEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  // 主快捷键要按平台隔离。macOS 的 Ctrl 保留给系统 Emacs 风格文本编辑，
  // Windows/Linux 才使用 Ctrl；同时按下 Ctrl 和 Command 不视作主快捷键，避免误触发。
  return isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function matchesCtrlShortcut(event: PrimaryShortcutKeyboardEvent, key: string): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

function matchesShortcutKey(
  event: Pick<PrimaryShortcutKeyboardEvent, "key" | "code">,
  key: string,
): boolean {
  const normalizedKey = key.toLowerCase();
  if (event.key.toLowerCase() === normalizedKey) {
    return true;
  }

  // 修复说明：macOS 上按下 Option 参与组合键时，event.key 可能会被当前键盘布局改写成其他字符，
  // 直接按 key 比较会把 ⌥⌘B 这类快捷键误判成未命中。这里补一层 code 匹配，避免受输入法/布局影响。
  const expectedCode = getExpectedShortcutCode(normalizedKey);
  return expectedCode != null && event.code === expectedCode;
}

function getExpectedShortcutCode(key: string): string | null {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return `Key${lower.toUpperCase()}`;
    }
    if (lower >= "0" && lower <= "9") {
      return `Digit${lower}`;
    }
  }

  switch (key) {
    case "[":
      return "BracketLeft";
    case "]":
      return "BracketRight";
    default:
      return null;
  }
}
