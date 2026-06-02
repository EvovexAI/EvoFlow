import type { SourceRecordInput } from "../../../db/src/repos/source-state";
import { replaceSourceRecords } from "../../../db/src/repos/source-records";
import { upsertSourceSyncState } from "../../../db/src/repos/source-sync-state";
import { createContentHash } from "../../../db/src/repos/source-state";
import { resolveGitHubSourceConfig } from "./config";

interface GitHubRepo {
  archived: boolean;
  default_branch: string;
  description: string | null;
  fork: boolean;
  forks_count: number;
  full_name: string;
  homepage: string | null;
  html_url: string;
  language: string | null;
  name: string;
  open_issues_count: number;
  owner: {
    login: string;
  };
  private: boolean;
  pushed_at: string;
  stargazers_count: number;
  topics: string[];
  updated_at: string;
  visibility?: string;
}

interface GitHubCommitListEntry {
  commit: {
    author: {
      date: string;
      name: string;
    } | null;
    message: string;
  };
  html_url: string;
  sha: string;
}

interface GitHubCommitDetail {
  commit: {
    author: {
      date: string;
      name: string;
    } | null;
    message: string;
  };
  files?: Array<{
    additions?: number;
    changes?: number;
    deletions?: number;
    filename: string;
    status?: string;
  }>;
  html_url: string;
  sha: string;
}

interface GitHubReadmeResponse {
  content: string;
  encoding: string;
}

interface GitHubContentFileResponse {
  content: string;
  encoding: string;
  html_url?: string | null;
}

interface RepoPackageManifest {
  description?: string;
  homepage?: string;
  keywords?: string[];
  name?: string;
  repository?: string | { url?: string };
  version?: string;
}

interface NpmPackageSummary {
  description: string | null;
  keywords: string[];
  latestVersion: string | null;
  npmUrl: string;
  publishedAt: string | null;
}

interface GitHubCommitSignal {
  author: string;
  changedFiles: string[];
  committedAt: string;
  htmlUrl: string;
  message: string;
  repoName: string;
  repoSlug: string;
  repoUrl: string;
  sha: string;
}

interface EnrichedRepoSignal {
  isFlagship: boolean;
  npmPackage: NpmPackageSummary | null;
  packageManifest: RepoPackageManifest | null;
  rankIndex: number;
  rankScore: number;
  readmeExcerpt: string | null;
  repo: GitHubRepo;
}

export interface GitHubSyncFlagshipRepo {
  fullName: string;
  npmPackageName: string | null;
  rankIndex: number;
  rankScore: number;
}

export interface GitHubSyncResult {
  accountUrl: string;
  authMode: "authenticated" | "public";
  commits: GitHubCommitSignal[];
  flagshipRepos: GitHubSyncFlagshipRepo[];
  languages: string[];
  recordCount: number;
  repos: GitHubRepo[];
  sourceKey: string;
  topics: string[];
}

function dedupe(values: string[], limit = values.length) {
  return values.filter((value, index, array) => array.indexOf(value) === index).slice(0, limit);
}

function buildGitHubApiHeaders(token: string | null) {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "User-Agent": "ai-site-sync/0.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function buildPublicJsonHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": "ai-site-sync/0.1",
  };
}

function repoSlug(repo: GitHubRepo) {
  return repo.full_name.split("/").pop() ?? repo.name;
}

function compactMarkdown(value: string, max = 1200) {
  const normalized = value
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`+/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/[*_~\-]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 3).trim()}...`;
}

function decodeBase64Content(value: string) {
  return Buffer.from(value.replace(/\n/g, ""), "base64").toString("utf8");
}

function calculateFlagshipScore(repo: GitHubRepo) {
  const pushedAtMs = Date.parse(repo.pushed_at || repo.updated_at);
  const ageDays = Number.isFinite(pushedAtMs)
    ? (Date.now() - pushedAtMs) / (1000 * 60 * 60 * 24)
    : 365;
  const freshnessScore = Math.max(0, 48 - ageDays / 9);

  return Math.round(
    repo.stargazers_count * 20 +
      repo.forks_count * 10 +
      freshnessScore +
      (repo.archived ? -20 : 12) +
      (repo.fork ? -12 : 18) +
      (repo.homepage ? 6 : 0) +
      (repo.language ? 4 : 0) +
      Math.min(repo.topics.length * 2, 12),
  );
}

async function fetchGitHubApi<T>(
  url: string,
  args: {
    allowEmpty?: boolean;
    allowNotFound?: boolean;
    token: string | null;
  },
) {
  const response = await fetch(url, {
    headers: buildGitHubApiHeaders(args.token),
  });

  if (args.allowEmpty && response.status === 409) {
    return [] as T;
  }

  if (args.allowNotFound && response.status === 404) {
    return null as T;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `GitHub API request failed (${response.status}) for ${url}${detail ? `: ${detail}` : ""}`,
    );
  }

  return (await response.json()) as T;
}

async function fetchVisibleRepos(args: {
  token: string | null;
  username: string;
}) {
  const repos: GitHubRepo[] = [];

  for (let page = 1; page <= 4; page += 1) {
    const nextPage = await fetchGitHubApi<GitHubRepo[]>(
      `https://api.github.com/users/${encodeURIComponent(args.username)}/repos?per_page=100&page=${page}&sort=updated&type=owner`,
      { token: args.token },
    );

    repos.push(...nextPage);

    if (nextPage.length < 100) {
      break;
    }
  }

  return repos
    .filter((repo) => repo.owner.login.toLowerCase() === args.username.toLowerCase())
    .sort((left, right) => right.pushed_at.localeCompare(left.pushed_at));
}

async function fetchRepoCommits(args: {
  repo: GitHubRepo;
  token: string | null;
}) {
  return fetchGitHubApi<GitHubCommitListEntry[]>(
    `https://api.github.com/repos/${encodeURIComponent(args.repo.owner.login)}/${encodeURIComponent(args.repo.name)}/commits?per_page=2`,
    {
      allowEmpty: true,
      token: args.token,
    },
  );
}

async function fetchCommitDetail(args: {
  repo: GitHubRepo;
  sha: string;
  token: string | null;
}) {
  return fetchGitHubApi<GitHubCommitDetail>(
    `https://api.github.com/repos/${encodeURIComponent(args.repo.owner.login)}/${encodeURIComponent(args.repo.name)}/commits/${encodeURIComponent(args.sha)}`,
    {
      token: args.token,
    },
  );
}

async function fetchRepoReadme(args: {
  repo: GitHubRepo;
  token: string | null;
}) {
  const response = await fetchGitHubApi<GitHubReadmeResponse | null>(
    `https://api.github.com/repos/${encodeURIComponent(args.repo.owner.login)}/${encodeURIComponent(args.repo.name)}/readme`,
    {
      allowNotFound: true,
      token: args.token,
    },
  );

  if (!response?.content || response.encoding !== "base64") {
    return null;
  }

  return compactMarkdown(decodeBase64Content(response.content));
}

async function fetchRepoPackageManifest(args: {
  repo: GitHubRepo;
  token: string | null;
}) {
  const response = await fetchGitHubApi<GitHubContentFileResponse | null>(
    `https://api.github.com/repos/${encodeURIComponent(args.repo.owner.login)}/${encodeURIComponent(args.repo.name)}/contents/package.json?ref=${encodeURIComponent(args.repo.default_branch)}`,
    {
      allowNotFound: true,
      token: args.token,
    },
  );

  if (!response?.content || response.encoding !== "base64") {
    return null;
  }

  try {
    return JSON.parse(decodeBase64Content(response.content)) as RepoPackageManifest;
  } catch {
    return null;
  }
}

async function fetchNpmPackageSummary(packageName: string) {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      {
        headers: buildPublicJsonHeaders(),
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      description?: unknown;
      keywords?: unknown;
      time?: Record<string, string>;
      ["dist-tags"]?: { latest?: string };
    };
    const latestVersion =
      typeof payload["dist-tags"]?.latest === "string"
        ? payload["dist-tags"]?.latest
        : null;

    return {
      description:
        typeof payload.description === "string" ? payload.description : null,
      keywords: Array.isArray(payload.keywords)
        ? payload.keywords.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      latestVersion,
      npmUrl: `https://www.npmjs.com/package/${packageName}`,
      publishedAt:
        latestVersion && payload.time?.[latestVersion]
          ? payload.time[latestVersion]
          : null,
    } satisfies NpmPackageSummary;
  } catch {
    return null;
  }
}

async function enrichFlagshipRepo(args: {
  rankIndex: number;
  rankScore: number;
  repo: GitHubRepo;
  token: string | null;
}) {
  const [readmeExcerpt, packageManifest] = await Promise.all([
    fetchRepoReadme({
      repo: args.repo,
      token: args.token,
    }),
    fetchRepoPackageManifest({
      repo: args.repo,
      token: args.token,
    }),
  ]);
  const npmPackage =
    packageManifest?.name && typeof packageManifest.name === "string"
      ? await fetchNpmPackageSummary(packageManifest.name)
      : null;

  return {
    isFlagship: true,
    npmPackage,
    packageManifest,
    rankIndex: args.rankIndex,
    rankScore: args.rankScore,
    readmeExcerpt,
    repo: args.repo,
  } satisfies EnrichedRepoSignal;
}

function createRepoRecord(args: {
  enrichedRepo: EnrichedRepoSignal;
  sourceKey: string;
}): SourceRecordInput {
  const { enrichedRepo, sourceKey } = args;
  const { npmPackage, packageManifest, rankIndex, rankScore, readmeExcerpt, repo } =
    enrichedRepo;
  const packageName =
    packageManifest?.name && typeof packageManifest.name === "string"
      ? packageManifest.name
      : null;
  const packageVersion =
    packageManifest?.version && typeof packageManifest.version === "string"
      ? packageManifest.version
      : null;
  const content = [
    `Repository: ${repo.full_name}`,
    repo.description ? `Description: ${repo.description}` : "",
    repo.language ? `Primary language: ${repo.language}` : "",
    repo.topics.length ? `Topics: ${repo.topics.join(", ")}` : "",
    `Stars: ${repo.stargazers_count}`,
    `Forks: ${repo.forks_count}`,
    `Open issues: ${repo.open_issues_count}`,
    `Flagship rank: #${rankIndex}`,
    `Flagship score: ${rankScore}`,
    packageName ? `Package: ${packageName}` : "",
    packageVersion ? `Package version: ${packageVersion}` : "",
    npmPackage?.latestVersion
      ? `NPM latest version: ${npmPackage.latestVersion}`
      : "",
    repo.homepage ? `Homepage: ${repo.homepage}` : "",
    `Visibility: ${repo.visibility ?? (repo.private ? "private" : "public")}`,
    `Updated at: ${repo.updated_at}`,
    `Pushed at: ${repo.pushed_at}`,
    readmeExcerpt ? `README summary: ${readmeExcerpt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content,
    metadata: {
      defaultBranch: repo.default_branch,
      fork: repo.fork,
      forksCount: repo.forks_count,
      homepage: repo.homepage,
      isFlagship: enrichedRepo.isFlagship,
      kind: "repo",
      language: repo.language,
      npmLatestVersion: npmPackage?.latestVersion ?? null,
      npmPackageUrl: npmPackage?.npmUrl ?? null,
      openIssuesCount: repo.open_issues_count,
      packageDescription:
        packageManifest?.description && typeof packageManifest.description === "string"
          ? packageManifest.description
          : null,
      packageKeywords: Array.isArray(packageManifest?.keywords)
        ? packageManifest.keywords.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      packageName,
      packageVersion,
      private: repo.private,
      pushedAt: repo.pushed_at,
      rankIndex,
      rankScore,
      readmeExcerpt,
      repoName: repo.full_name,
      repoSlug: repoSlug(repo),
      stargazersCount: repo.stargazers_count,
      topics: repo.topics,
      updatedAt: repo.updated_at,
      visibility: repo.visibility ?? (repo.private ? "private" : "public"),
    },
    pathOrUrl: repo.html_url,
    sourceId: `repo:${repo.full_name}`,
    sourceKey,
    sourceType: "github" as const,
    title: repo.full_name,
    updatedAt: repo.pushed_at || repo.updated_at,
  } satisfies SourceRecordInput;
}

function createReadmeRecord(args: {
  enrichedRepo: EnrichedRepoSignal;
  sourceKey: string;
}): SourceRecordInput | null {
  if (!args.enrichedRepo.readmeExcerpt) {
    return null;
  }

  return {
    content: [
      `Repository README: ${args.enrichedRepo.repo.full_name}`,
      args.enrichedRepo.readmeExcerpt,
    ].join("\n\n"),
    metadata: {
      isFlagship: args.enrichedRepo.isFlagship,
      kind: "repo_readme",
      rankIndex: args.enrichedRepo.rankIndex,
      rankScore: args.enrichedRepo.rankScore,
      repoName: args.enrichedRepo.repo.full_name,
      repoSlug: repoSlug(args.enrichedRepo.repo),
    },
    pathOrUrl: `${args.enrichedRepo.repo.html_url}#readme`,
    sourceId: `readme:${args.enrichedRepo.repo.full_name}`,
    sourceKey: args.sourceKey,
    sourceType: "github" as const,
    title: `${args.enrichedRepo.repo.full_name} README`,
    updatedAt:
      args.enrichedRepo.repo.pushed_at || args.enrichedRepo.repo.updated_at,
  } satisfies SourceRecordInput;
}

function createPackageRecord(args: {
  enrichedRepo: EnrichedRepoSignal;
  sourceKey: string;
}): SourceRecordInput | null {
  const packageName =
    args.enrichedRepo.packageManifest?.name &&
    typeof args.enrichedRepo.packageManifest.name === "string"
      ? args.enrichedRepo.packageManifest.name
      : null;

  if (!packageName) {
    return null;
  }

  const packageVersion =
    args.enrichedRepo.packageManifest?.version &&
    typeof args.enrichedRepo.packageManifest.version === "string"
      ? args.enrichedRepo.packageManifest.version
      : null;
  const content = [
    `Package: ${packageName}`,
    packageVersion ? `Version: ${packageVersion}` : "",
    args.enrichedRepo.packageManifest?.description &&
    typeof args.enrichedRepo.packageManifest.description === "string"
      ? `Description: ${args.enrichedRepo.packageManifest.description}`
      : "",
    args.enrichedRepo.npmPackage?.latestVersion
      ? `NPM latest version: ${args.enrichedRepo.npmPackage.latestVersion}`
      : "",
    args.enrichedRepo.npmPackage?.publishedAt
      ? `Latest publish date: ${args.enrichedRepo.npmPackage.publishedAt}`
      : "",
    args.enrichedRepo.npmPackage?.keywords.length
      ? `Keywords: ${args.enrichedRepo.npmPackage.keywords.join(", ")}`
      : "",
    `Repository: ${args.enrichedRepo.repo.full_name}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content,
    metadata: {
      isFlagship: args.enrichedRepo.isFlagship,
      kind: "repo_package",
      latestVersion: args.enrichedRepo.npmPackage?.latestVersion ?? null,
      npmPackageUrl: args.enrichedRepo.npmPackage?.npmUrl ?? null,
      packageName,
      packageVersion,
      rankIndex: args.enrichedRepo.rankIndex,
      rankScore: args.enrichedRepo.rankScore,
      repoName: args.enrichedRepo.repo.full_name,
      repoSlug: repoSlug(args.enrichedRepo.repo),
    },
    pathOrUrl:
      args.enrichedRepo.npmPackage?.npmUrl ?? args.enrichedRepo.repo.html_url,
    sourceId: `package:${args.enrichedRepo.repo.full_name}`,
    sourceKey: args.sourceKey,
    sourceType: "github" as const,
    title: `${packageName} package`,
    updatedAt:
      args.enrichedRepo.repo.pushed_at || args.enrichedRepo.repo.updated_at,
  } satisfies SourceRecordInput;
}

function createAccountSummaryRecord(args: {
  accountUrl: string;
  languages: string[];
  repos: EnrichedRepoSignal[];
  sourceKey: string;
  topics: string[];
}): SourceRecordInput {
  const totalStars = args.repos.reduce(
    (sum, entry) => sum + entry.repo.stargazers_count,
    0,
  );
  const flagshipSummary = args.repos
    .slice(0, 3)
    .map((entry) => {
      const packageName =
        entry.packageManifest?.name && typeof entry.packageManifest.name === "string"
          ? ` (${entry.packageManifest.name})`
          : "";

      return `#${entry.rankIndex} ${entry.repo.full_name}${packageName}`;
    })
    .join(", ");

  return {
    content: [
      `Open source account: ${args.sourceKey}`,
      `Visible repositories: ${args.repos.length}`,
      `Total stars: ${totalStars}`,
      args.languages.length
        ? `Primary languages: ${args.languages.join(", ")}`
        : "",
      args.topics.length ? `Core topics: ${args.topics.join(", ")}` : "",
      flagshipSummary ? `Flagship repositories: ${flagshipSummary}` : "",
      `Account URL: ${args.accountUrl}`,
    ]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      accountUrl: args.accountUrl,
      flagshipRepos: args.repos.slice(0, 3).map((entry) => ({
        fullName: entry.repo.full_name,
        rankIndex: entry.rankIndex,
        rankScore: entry.rankScore,
      })),
      kind: "account_summary",
      languages: args.languages,
      repoCount: args.repos.length,
      sourceKey: args.sourceKey,
      topTopics: args.topics,
      totalStars,
    },
    pathOrUrl: args.accountUrl,
    sourceId: `account:${args.sourceKey}`,
    sourceKey: args.sourceKey,
    sourceType: "github" as const,
    title: `${args.sourceKey} open source account`,
    updatedAt: new Date().toISOString(),
  } satisfies SourceRecordInput;
}

function createCommitRecord(args: {
  commit: GitHubCommitSignal;
  sourceKey: string;
}): SourceRecordInput {
  const content = [
    `Repository: ${args.commit.repoName}`,
    `Commit: ${args.commit.sha}`,
    `Author: ${args.commit.author}`,
    `Committed at: ${args.commit.committedAt}`,
    `Message: ${args.commit.message}`,
    args.commit.changedFiles.length
      ? `Changed files: ${args.commit.changedFiles.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content,
    metadata: {
      author: args.commit.author,
      changedFiles: args.commit.changedFiles,
      committedAt: args.commit.committedAt,
      kind: "commit",
      repoName: args.commit.repoName,
      repoSlug: args.commit.repoSlug,
      repoUrl: args.commit.repoUrl,
      sha: args.commit.sha,
    },
    pathOrUrl: args.commit.htmlUrl,
    sourceId: `commit:${args.commit.repoName}:${args.commit.sha}`,
    sourceKey: args.sourceKey,
    sourceType: "github" as const,
    title: `${args.commit.repoName} · ${args.commit.message.split("\n")[0]}`,
    updatedAt: args.commit.committedAt,
  } satisfies SourceRecordInput;
}

export async function syncGitHubSource() {
  const config = resolveGitHubSourceConfig();
  const sourceKey = config.username;
  const accountUrl = `https://github.com/${config.username}`;

  await upsertSourceSyncState({
    contentHash: null,
    cursor: null,
    itemCount: 0,
    lastError: null,
    lastSyncedAt: null,
    metadata: {
      accountUrl,
      authMode: config.authMode,
    },
    sourceKey,
    sourceType: "github",
    status: "syncing",
  });

  try {
    const repos = await fetchVisibleRepos(config);
    const rankedRepos = repos
      .map((repo) => ({
        rankScore: calculateFlagshipScore(repo),
        repo,
      }))
      .sort((left, right) => right.rankScore - left.rankScore)
      .map((entry, index) => ({
        rankIndex: index + 1,
        rankScore: entry.rankScore,
        repo: entry.repo,
      }));
    const flagshipWindow = rankedRepos.slice(0, 4);
    const enrichedFlagshipRepos = await Promise.all(
      flagshipWindow.map((entry) =>
        enrichFlagshipRepo({
          rankIndex: entry.rankIndex,
          rankScore: entry.rankScore,
          repo: entry.repo,
          token: config.token,
        }),
      ),
    );
    const enrichmentMap = new Map(
      enrichedFlagshipRepos.map((entry) => [entry.repo.full_name, entry]),
    );
    const enrichedRepos = rankedRepos.map((entry) => {
      const enriched = enrichmentMap.get(entry.repo.full_name);

      return (
        enriched ?? {
          isFlagship: false,
          npmPackage: null,
          packageManifest: null,
          rankIndex: entry.rankIndex,
          rankScore: entry.rankScore,
          readmeExcerpt: null,
          repo: entry.repo,
        }
      ) satisfies EnrichedRepoSignal;
    });
    const repoWindow = repos.slice(0, 6);
    const commitLists = await Promise.all(
      repoWindow.map(async (repo) => ({
        commits: await fetchRepoCommits({
          repo,
          token: config.token,
        }),
        repo,
      })),
    );
    const latestCommits = commitLists
      .flatMap(({ commits, repo }) =>
        commits.map((commit) => ({
          committedAt:
            commit.commit.author?.date ?? repo.pushed_at ?? repo.updated_at,
          repo,
          sha: commit.sha,
        })),
      )
      .sort((left, right) => right.committedAt.localeCompare(left.committedAt))
      .slice(0, 6);
    const detailedCommits = await Promise.all(
      latestCommits.map(async (entry) => ({
        detail: await fetchCommitDetail({
          repo: entry.repo,
          sha: entry.sha,
          token: config.token,
        }),
        repo: entry.repo,
      })),
    );
    const commitSignals = detailedCommits.map(({ detail, repo }) => ({
      author: detail.commit.author?.name ?? repo.owner.login,
      changedFiles: dedupe(
        (detail.files ?? []).map((file) => file.filename).filter(Boolean),
        8,
      ),
      committedAt:
        detail.commit.author?.date ?? repo.pushed_at ?? repo.updated_at,
      htmlUrl: detail.html_url,
      message: detail.commit.message,
      repoName: repo.full_name,
      repoSlug: repoSlug(repo),
      repoUrl: repo.html_url,
      sha: detail.sha,
    }));
    const languages = dedupe(
      repos
        .map((repo) => repo.language)
        .filter((language): language is string => Boolean(language)),
      6,
    );
    const topics = dedupe(repos.flatMap((repo) => repo.topics), 8);
    const sourceRecords: SourceRecordInput[] = [
      createAccountSummaryRecord({
        accountUrl,
        languages,
        repos: enrichedRepos,
        sourceKey,
        topics,
      }),
      ...enrichedRepos.map((entry) =>
        createRepoRecord({
          enrichedRepo: entry,
          sourceKey,
        }),
      ),
      ...enrichedFlagshipRepos.flatMap((entry) => {
        const optionalRecords: SourceRecordInput[] = [];
        const readmeRecord = createReadmeRecord({
          enrichedRepo: entry,
          sourceKey,
        });
        const packageRecord = createPackageRecord({
          enrichedRepo: entry,
          sourceKey,
        });

        if (readmeRecord) {
          optionalRecords.push(readmeRecord);
        }

        if (packageRecord) {
          optionalRecords.push(packageRecord);
        }

        return optionalRecords;
      }),
      ...commitSignals.map((commit) =>
        createCommitRecord({
          commit,
          sourceKey,
        }),
      ),
    ];
    const contentHash = createContentHash(
      JSON.stringify(
        sourceRecords.map((record) => ({
          contentHash: createContentHash(record.content),
          pathOrUrl: record.pathOrUrl,
          sourceId: record.sourceId,
          title: record.title,
          updatedAt: record.updatedAt,
        })),
      ),
    );

    await replaceSourceRecords({
      records: sourceRecords,
      sourceKey,
      sourceType: "github",
    });
    await upsertSourceSyncState({
      contentHash,
      cursor: commitSignals[0]?.sha ?? null,
      itemCount: sourceRecords.length,
      lastError: null,
      lastSyncedAt: new Date().toISOString(),
      metadata: {
        accountUrl,
        authMode: config.authMode,
        commitCount: commitSignals.length,
        flagshipRepoNames: enrichedFlagshipRepos.map((entry) => entry.repo.full_name),
        languages,
        packageCount: enrichedFlagshipRepos.filter(
          (entry) =>
            entry.packageManifest?.name &&
            typeof entry.packageManifest.name === "string",
        ).length,
        readmeCount: enrichedFlagshipRepos.filter(
          (entry) => entry.readmeExcerpt,
        ).length,
        repoCount: repos.length,
        repoNames: repos.slice(0, 6).map((repo) => repo.full_name),
        topics,
        totalStars: enrichedRepos.reduce(
          (sum, entry) => sum + entry.repo.stargazers_count,
          0,
        ),
      },
      sourceKey,
      sourceType: "github",
      status: "completed",
    });

    return {
      accountUrl,
      authMode: config.authMode,
      commits: commitSignals,
      flagshipRepos: enrichedFlagshipRepos.map((entry) => ({
        fullName: entry.repo.full_name,
        npmPackageName:
          entry.packageManifest?.name &&
          typeof entry.packageManifest.name === "string"
            ? entry.packageManifest.name
            : null,
        rankIndex: entry.rankIndex,
        rankScore: entry.rankScore,
      })),
      languages,
      recordCount: sourceRecords.length,
      repos,
      sourceKey,
      topics,
    } satisfies GitHubSyncResult;
  } catch (error) {
    await upsertSourceSyncState({
      contentHash: null,
      cursor: null,
      itemCount: 0,
      lastError: error instanceof Error ? error.message : "unknown_github_sync_error",
      lastSyncedAt: null,
      metadata: {
        accountUrl,
        authMode: config.authMode,
      },
      sourceKey,
      sourceType: "github",
      status: "failed",
    });
    throw error;
  }
}
