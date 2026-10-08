import type { RemoteTargetSnapshot } from "./protocol.js";
import type { SSHConnectOptions } from "./remoteTarget.js";

type SshRemoteHostKeyTarget = SSHConnectOptions | Extract<RemoteTargetSnapshot, { kind: "ssh" }>;

interface PrivateKeyPathRoot {
  prefix: string;
  body: string;
  blocksParentTraversal: boolean;
}

function splitPrivateKeyPathRoot(value: string): PrivateKeyPathRoot {
  const windowsDriveRoot = value.match(/^([A-Z]:)\/(.*)$/);
  if (windowsDriveRoot) {
    return {
      prefix: `${windowsDriveRoot[1]}/`,
      body: windowsDriveRoot[2] ?? "",
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("//")) {
    const segments = value.slice(2).split("/").filter(Boolean);
    if (segments.length >= 2) {
      const [server, share, ...bodySegments] = segments;
      return {
        prefix: `//${server}/${share}/`,
        body: bodySegments.join("/"),
        blocksParentTraversal: true,
      };
    }
    return {
      prefix: "//",
      body: segments.join("/"),
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("/")) {
    return {
      prefix: "/",
      body: value.replace(/^\/+/, ""),
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("~/")) {
    return {
      prefix: "~/",
      body: value.slice(2),
      blocksParentTraversal: false,
    };
  }

  const windowsDriveRelative = value.match(/^([A-Z]:)(.*)$/);
  if (windowsDriveRelative) {
    return {
      prefix: windowsDriveRelative[1] ?? "",
      body: windowsDriveRelative[2] ?? "",
      blocksParentTraversal: false,
    };
  }

  return {
    prefix: "",
    body: value,
    blocksParentTraversal: false,
  };
}

function normalizePrivateKeyPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  const driveNormalized = normalizedSeparators.replace(
    /^([a-z]):/i,
    (_, drive: string) => `${drive.toUpperCase()}:`,
  );
  const root = splitPrivateKeyPathRoot(driveNormalized);
  const segments: string[] = [];

  for (const segment of root.body.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
        continue;
      }
      // 盘符、UNC share 和 POSIX root 不是普通路径段，`..` 不能把根弹掉；
      // 相对路径与 `~` 无法在浏览器侧安全求值，保留未消解的 parent segment 以避免错误复用。
      if (root.blocksParentTraversal) {
        continue;
      }
      segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  return `${root.prefix}${segments.join("/")}` || root.prefix;
}

function resolveSshAuthKind(target: SshRemoteHostKeyTarget): "agent" | "password" | "private-key" {
  if (target.privateKeyPath?.trim()) {
    return "private-key";
  }
  if (
    ("password" in target && typeof target.password === "string") ||
    ("passwordCredentialKey" in target && Boolean(target.passwordCredentialKey?.trim()))
  ) {
    return "password";
  }
  return "agent";
}

/**
 * 构造窗口内 SSH Remote Host 的共享身份。
 * 密码和私钥口令只用于建连，禁止进入共享键或日志。
 */
export function buildSshRemoteHostKey(target: SshRemoteHostKeyTarget): string {
  return JSON.stringify([
    "ssh:v1",
    target.host.trim().toLowerCase(),
    target.port ?? 22,
    target.username.trim(),
    resolveSshAuthKind(target),
    normalizePrivateKeyPath(target.privateKeyPath),
  ]);
}
