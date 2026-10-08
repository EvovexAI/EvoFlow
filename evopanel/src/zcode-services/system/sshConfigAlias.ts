/* eslint-disable max-lines -- SSH config alias 解析链路包含扫描、回退和受控执行，暂集中在同一文件。 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { SSHConfigAliasOption } from "@zcode/shared";

const CACHE_TTL_MS = 30_000;
const MAX_ALIAS_COUNT = 200;
const SSH_G_TIMEOUT_MS = 1_500;
const SSH_G_CONCURRENCY = 3;
const MAX_INCLUDE_DEPTH = 8;

interface ParsedDirective {
  key: string;
  value: string;
}

interface ParsedBlock {
  patterns: string[];
  directives: ParsedDirective[];
  source: string;
  fromHostDirective: boolean;
}

interface AliasMeta {
  alias: string;
  source: string;
}

let aliasCache: {
  expiresAt: number;
  options: SSHConfigAliasOption[];
} | null = null;

function cloneAliasOptions(options: SSHConfigAliasOption[]): SSHConfigAliasOption[] {
  return options.map((option) => ({ ...option }));
}

function isConnectableAliasPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed === "*" || trimmed.startsWith("!")) {
    return false;
  }

  return !/[?*[\\\]]/.test(trimmed);
}

function stripInlineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, i);
    }
  }

  return line;
}

function splitSshTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (quote) {
      if (char === "\\") {
        const nextChar = line.charAt(i + 1);
        if (!nextChar) {
          current += "\\";
          continue;
        }
        if (nextChar === quote || nextChar === "\\") {
          current += nextChar;
          i += 1;
          continue;
        }
        current += "\\";
        continue;
      }

      if (char === quote) {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\") {
      const nextChar = line.charAt(i + 1);
      if (!nextChar) {
        current += "\\";
        continue;
      }
      if (
        /\s/.test(nextChar) ||
        nextChar === "\\" ||
        nextChar === "'" ||
        nextChar === '"' ||
        nextChar === "#"
      ) {
        current += nextChar;
        i += 1;
        continue;
      }
      // SSH config 在 Windows 下常见 `C:\Users\...` 这类路径。
      // 不能把任意 `\` 都当成转义前缀：反斜杠会被吞掉，私钥/Include 路径失效。
      // 这里仅在“确实用于转义分隔符/引号”时解义，其余场景保留字面反斜杠。
      current += "\\";
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function hasGlobPattern(value: string): boolean {
  // Windows 绝对路径天然包含 `\`，但这不代表 Include 是 glob。
  // 这里只识别 SSH Include 真正的 glob 元字符：`* ? [ ]`。
  return /[*?[\]]/.test(value);
}

function expandHomeToken(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return trimmed;
  }

  const home = homedir();
  const withHomeVariable = trimmed.replace(/^%d(?=$|[\\/])/, home);
  if (withHomeVariable === "~") {
    return home;
  }
  if (withHomeVariable.startsWith("~/") || withHomeVariable.startsWith("~\\")) {
    return join(home, withHomeVariable.slice(2));
  }
  return withHomeVariable;
}

async function resolveIncludeTargets(includeTokens: string[], baseDir: string): Promise<string[]> {
  const results: string[] = [];
  const visited = new Set<string>();

  for (const token of includeTokens) {
    const expanded = expandHomeToken(token);
    if (!expanded) {
      continue;
    }

    const absolutePattern = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);

    if (!hasGlobPattern(absolutePattern)) {
      if (existsSync(absolutePattern) && !visited.has(absolutePattern)) {
        visited.add(absolutePattern);
        results.push(absolutePattern);
      }
      continue;
    }

    try {
      for await (const match of glob(absolutePattern)) {
        const resolvedMatch = resolve(match);
        if (visited.has(resolvedMatch)) {
          continue;
        }
        visited.add(resolvedMatch);
        results.push(resolvedMatch);
      }
    } catch {
      // include 展开失败时按空集合处理，避免单个坏配置阻塞整体加载。
    }
  }

  return results;
}

async function parseConfigBlocks(
  configPath: string,
  visited: Set<string>,
  depth: number,
): Promise<ParsedBlock[]> {
  const normalizedPath = resolve(configPath);
  if (visited.has(normalizedPath) || depth > MAX_INCLUDE_DEPTH) {
    return [];
  }
  visited.add(normalizedPath);

  let content = "";
  try {
    content = await readFile(normalizedPath, "utf8");
  } catch {
    return [];
  }

  const blocks: ParsedBlock[] = [];
  let currentBlock: ParsedBlock = {
    patterns: ["*"],
    directives: [],
    source: normalizedPath,
    fromHostDirective: false,
  };
  blocks.push(currentBlock);

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const stripped = stripInlineComment(line).trim();
    if (!stripped) {
      continue;
    }

    const tokens = splitSshTokens(stripped);
    if (tokens.length === 0) {
      continue;
    }

    const rawKey = tokens[0];
    if (!rawKey) {
      continue;
    }
    const key = rawKey.toLowerCase();
    if (key === "include") {
      const includeTokens = tokens.slice(1);
      const includePaths = await resolveIncludeTargets(includeTokens, dirname(normalizedPath));
      for (const includePath of includePaths) {
        const includeBlocks = await parseConfigBlocks(includePath, visited, depth + 1);
        blocks.push(...includeBlocks);
      }
      continue;
    }

    if (key === "host") {
      currentBlock = {
        patterns: tokens.slice(1),
        directives: [],
        source: normalizedPath,
        fromHostDirective: true,
      };
      blocks.push(currentBlock);
      continue;
    }

    if (tokens.length < 2) {
      continue;
    }

    currentBlock.directives.push({
      key,
      value: tokens.slice(1).join(" "),
    });
  }

  return blocks;
}

function buildAliasMetas(blocks: ParsedBlock[]): AliasMeta[] {
  const aliases: AliasMeta[] = [];
  const seenAliases = new Set<string>();

  for (const block of blocks) {
    if (!block.fromHostDirective || block.patterns.length !== 1) {
      continue;
    }

    const alias = block.patterns[0]?.trim();
    if (!alias || !isConnectableAliasPattern(alias) || seenAliases.has(alias)) {
      continue;
    }

    seenAliases.add(alias);
    aliases.push({
      alias,
      source: block.source,
    });

    if (aliases.length >= MAX_ALIAS_COUNT) {
      break;
    }
  }

  return aliases;
}

function matchHostPattern(pattern: string, alias: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (!/[*?]/.test(pattern)) {
    return pattern === alias;
  }

  const regexBody = Array.from(pattern, (char) => {
    if (char === "*") {
      return ".*";
    }
    if (char === "?") {
      return ".";
    }
    // Teleport 会生成 `Host *.teleport-*.example.com` 这类 SSH glob。
    // 特殊字符（含 `*`）必须先转义，否则会拼出 `^*...` 非法正则并让 alias 枚举整体失败。
    return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }).join("");
  const regex = new RegExp(`^${regexBody}$`);
  return regex.test(alias);
}

function blockMatchesAlias(patterns: string[], alias: string): boolean {
  let matchedPositive = false;

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) {
      continue;
    }

    if (pattern.startsWith("!")) {
      const negatePattern = pattern.slice(1);
      if (negatePattern && matchHostPattern(negatePattern, alias)) {
        return false;
      }
      continue;
    }

    if (matchHostPattern(pattern, alias)) {
      matchedPositive = true;
    }
  }

  return matchedPositive;
}

function toValidPort(rawPort: string): number | undefined {
  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    return undefined;
  }
  return parsedPort;
}

function normalizeIdentityPath(rawValue: string): string | undefined {
  const expanded = expandHomeToken(rawValue).trim();
  return expanded.length > 0 ? expanded : undefined;
}

function buildFallbackOptions(
  blocks: ParsedBlock[],
  aliasMetas: AliasMeta[],
): SSHConfigAliasOption[] {
  return aliasMetas.map((meta) => {
    let host: string | undefined;
    let port: number | undefined;
    let username: string | undefined;
    let privateKeyPath: string | undefined;

    for (const block of blocks) {
      if (!blockMatchesAlias(block.patterns, meta.alias)) {
        continue;
      }

      for (const directive of block.directives) {
        switch (directive.key) {
          case "hostname":
            if (!host) {
              const normalizedHost = directive.value.trim();
              host = normalizedHost.length > 0 ? normalizedHost : undefined;
            }
            break;
          case "port":
            if (port == null) {
              port = toValidPort(directive.value.trim());
            }
            break;
          case "user":
            if (!username) {
              const normalizedUser = directive.value.trim();
              username = normalizedUser.length > 0 ? normalizedUser : undefined;
            }
            break;
          case "identityfile":
            if (!privateKeyPath) {
              privateKeyPath = normalizeIdentityPath(directive.value);
            }
            break;
          default:
            break;
        }
      }
    }

    return {
      alias: meta.alias,
      host: host ?? meta.alias,
      port,
      username,
      privateKeyPath,
      source: meta.source,
    };
  });
}

function findExecutableFromPath(binaryName: string): string | null {
  const rawPath = process.env["PATH"];
  if (!rawPath) {
    return null;
  }

  for (const entry of rawPath.split(delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = join(trimmed, binaryName);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

function resolveSshExecutablePath(): string | null {
  if (process.platform !== "win32") {
    return findExecutableFromPath("ssh");
  }

  const fromPath = findExecutableFromPath("ssh.exe");
  if (fromPath) {
    return fromPath;
  }

  const windowsDir = process.env["WINDIR"]?.trim() || "C:\\Windows";
  const programFiles = process.env["ProgramFiles"]?.trim() || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)";

  const candidates = [
    join(windowsDir, "System32", "OpenSSH", "ssh.exe"),
    join(programFiles, "OpenSSH", "ssh.exe"),
    join(programFiles, "Git", "usr", "bin", "ssh.exe"),
    join(programFilesX86, "Git", "usr", "bin", "ssh.exe"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function runSshConfigQuery(params: {
  sshExecutablePath: string;
  configPath: string;
  alias: string;
}): Promise<string | null> {
  const { sshExecutablePath, configPath, alias } = params;
  return await new Promise((resolvePromise) => {
    let finished = false;
    let stdout = "";

    const child = spawn(sshExecutablePath, ["-G", "-F", configPath, "-o", "BatchMode=yes", alias], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        SSH_ASKPASS_REQUIRE: "never",
        SSH_ASKPASS: "",
        DISPLAY: "",
      },
    });

    const timeoutId = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill();
      resolvePromise(null);
    }, SSH_G_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (finished) {
        return;
      }
      stdout += chunk.toString();
      if (stdout.length > 128_000) {
        stdout = stdout.slice(0, 128_000);
      }
    });

    child.on("error", () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutId);
      resolvePromise(null);
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutId);
      resolvePromise(code === 0 ? stdout : null);
    });
  });
}

function parseSshGOutput(output: string): Omit<SSHConfigAliasOption, "alias"> {
  let host: string | undefined;
  let port: number | undefined;
  let username: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const rawKey = match[1];
    const rawValue = match[2];
    if (!rawKey || rawValue == null) {
      continue;
    }
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    switch (key) {
      case "hostname":
        if (!host && value.length > 0) {
          host = value;
        }
        break;
      case "port":
        if (port == null) {
          port = toValidPort(value);
        }
        break;
      case "user":
        if (!username && value.length > 0) {
          username = value;
        }
        break;
      default:
        break;
    }
  }

  return {
    host,
    port,
    username,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as R[];
  const entries = items.map((item, index) => ({ item, index }));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) {
        return;
      }
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      results[entry.index] = await mapper(entry.item, entry.index);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      await worker();
    }),
  );

  return results;
}

export async function listSSHConfigAliasesFromLocalConfig(): Promise<SSHConfigAliasOption[]> {
  const now = Date.now();
  if (aliasCache && aliasCache.expiresAt > now) {
    return cloneAliasOptions(aliasCache.options);
  }

  const rootConfigPath = join(homedir(), ".ssh", "config");
  if (!existsSync(rootConfigPath)) {
    aliasCache = {
      expiresAt: now + CACHE_TTL_MS,
      options: [],
    };
    return [];
  }

  const blocks = await parseConfigBlocks(rootConfigPath, new Set<string>(), 0);
  const aliasMetas = buildAliasMetas(blocks);
  if (aliasMetas.length === 0) {
    aliasCache = {
      expiresAt: now + CACHE_TTL_MS,
      options: [],
    };
    return [];
  }

  const fallbackOptions = buildFallbackOptions(blocks, aliasMetas);
  const fallbackByAlias = new Map(fallbackOptions.map((option) => [option.alias, option] as const));

  const sshExecutablePath = resolveSshExecutablePath();
  const options =
    sshExecutablePath == null
      ? fallbackOptions
      : await mapWithConcurrency(aliasMetas, SSH_G_CONCURRENCY, async (meta) => {
          const fallbackOption = fallbackByAlias.get(meta.alias) ?? {
            alias: meta.alias,
            host: meta.alias,
            source: meta.source,
          };
          const sshOutput = await runSshConfigQuery({
            sshExecutablePath,
            configPath: rootConfigPath,
            alias: meta.alias,
          });
          if (!sshOutput) {
            return fallbackOption;
          }

          const parsed = parseSshGOutput(sshOutput);
          return {
            alias: meta.alias,
            host: parsed.host ?? fallbackOption.host ?? meta.alias,
            port: parsed.port ?? fallbackOption.port,
            username: parsed.username ?? fallbackOption.username,
            // `ssh -G` 会返回默认 identityfile（例如 ~/.ssh/id_rsa），
            // 即使 alias 并未显式配置 IdentityFile。之前直接采用该值，会把“密码登录”误判成“密钥登录”。
            // 因此 privateKeyPath 只信任 ssh config 显式解析结果，不再使用 `ssh -G` 的 identityfile。
            privateKeyPath: fallbackOption.privateKeyPath,
            source: meta.source,
          } satisfies SSHConfigAliasOption;
        });

  aliasCache = {
    expiresAt: now + CACHE_TTL_MS,
    options,
  };
  return cloneAliasOptions(options);
}
