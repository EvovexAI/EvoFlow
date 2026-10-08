import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const stripWrappingQuotes = (value: string) => {
    const normalized = value.trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1).trim();
    }
    return normalized;
  };
  const shellCommandMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
  if (shellCommandMatch?.[1]) {
    return stripWrappingQuotes(shellCommandMatch[1]);
  }

  const powershellCommandMatch = trimmed.match(
    /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i,
  );
  if (powershellCommandMatch?.[1]) {
    return stripWrappingQuotes(powershellCommandMatch[1]);
  }

  return trimmed;
}

function normalizeCommandCandidate(candidate: string): string[] {
  const unwrapped = unwrapShellCommand(candidate);
  if (unwrapped.length === 0) {
    return [];
  }

  return splitCommandSegments(unwrapped);
}

function extractToolCommands(input: unknown): string[] {
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) {
        commandCandidates.push(command);
      }
      return;
    }

    if (!Array.isArray(value)) {
      return;
    }

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (shellCommandIndex >= 0 && typeof commandParts[shellCommandIndex + 1] === "string") {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) {
        commandCandidates.push(joinedCommand);
      }
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) {
        continue;
      }

      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
    );
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
  );
}

const EXECUTE_READ_COMMAND_RE =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const EXECUTE_WRITE_COMMAND_RE =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;
const SHELL_LOOP_RE = /\b(for|while)\b/i;

export function isShellToolCallAwaitingCommand({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });
  return identity.family === "shell" && extractToolCommands(input).length === 0;
}

export function isExploreToolCall({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });

  if (identity.family === "file-write") {
    return false;
  }

  if (
    identity.family === "file-read" ||
    identity.family === "search" ||
    identity.family === "explore"
  ) {
    return true;
  }

  if (identity.family !== "shell") {
    return false;
  }

  const commands = extractToolCommands(input);
  if (commands.length === 0) {
    return false;
  }

  if (commands.some((command) => EXECUTE_WRITE_COMMAND_RE.test(command))) {
    return false;
  }

  if (commands.some((command) => SHELL_REDIRECT_WRITE_RE.test(command))) {
    return false;
  }

  if (commands.some((command) => EXECUTE_READ_COMMAND_RE.test(command))) {
    return true;
  }

  // 有些只读探查会包在 for/while 循环里，例如批量查看 README 或递归扫目录，
  // 这种命令本身不一定以 rg/ls 开头，但仍然属于 explore。
  return commands.some(
    (command) => SHELL_LOOP_RE.test(command) && EXECUTE_READ_COMMAND_RE.test(command),
  );
}

export function isExecuteToolCall({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });
  return (
    identity.family === "shell" &&
    !isShellToolCallAwaitingCommand({ kind, input }) &&
    !isExploreToolCall({ kind, input })
  );
}
