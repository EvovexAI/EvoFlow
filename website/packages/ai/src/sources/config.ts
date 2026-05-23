import fs from "node:fs";
import path from "node:path";
import { getWorkspaceRoot } from "../../../db/src/repos/runtime-files";

export interface GitHubSourceConfig {
  authMode: "authenticated" | "public";
  token: string | null;
  username: string;
}

export interface BlogSourceConfig {
  contentRoot: string;
  directory: string;
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/");
}

function resolveWorkspacePath(input: string) {
  return path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(getWorkspaceRoot(), input);
}

export function resolveGitHubSourceConfig() {
  const username =
    process.env.GITHUB_ACCOUNT_USERNAME?.trim() ||
    process.env.GITHUB_USERNAME?.trim() ||
    "";
  const token = process.env.GITHUB_TOKEN?.trim() || null;

  if (!username) {
    throw new Error(
      "GitHub source is not configured. Set GITHUB_ACCOUNT_USERNAME (or legacy GITHUB_USERNAME) first.",
    );
  }

  return {
    authMode: token ? "authenticated" : "public",
    token,
    username,
  } satisfies GitHubSourceConfig;
}

export function resolveBlogSourceConfig() {
  const configuredDirectory = process.env.BLOG_SOURCE_DIR?.trim() || "../blog";
  const directory = resolveWorkspacePath(configuredDirectory);

  if (!fs.existsSync(directory)) {
    throw new Error(
      `Blog source directory does not exist: ${normalizePath(directory)}. Set BLOG_SOURCE_DIR to a valid local blog repo.`,
    );
  }

  const stat = fs.statSync(directory);

  if (!stat.isDirectory()) {
    throw new Error(
      `Blog source path is not a directory: ${normalizePath(directory)}. Set BLOG_SOURCE_DIR to a local repo folder.`,
    );
  }

  const contentRootCandidate = path.join(directory, "src", "content");
  const contentRoot = fs.existsSync(contentRootCandidate)
    ? contentRootCandidate
    : directory;

  return {
    contentRoot: normalizePath(contentRoot),
    directory: normalizePath(directory),
  } satisfies BlogSourceConfig;
}
