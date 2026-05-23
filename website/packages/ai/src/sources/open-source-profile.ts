import {
  listSourceRecords,
  type StoredSourceRecord,
} from "../../../db/src/repos/source-records";

export interface RepoBlogLink {
  path: string;
  score: number;
  title: string;
}

export interface OpenSourceFlagshipRepoProfile {
  language: string | null;
  linkedPosts: RepoBlogLink[];
  npmLatestVersion: string | null;
  packageName: string | null;
  rankIndex: number;
  rankScore: number;
  readmeExcerpt: string | null;
  repoName: string;
  repoSlug: string;
  repoUrl: string;
  summary: string;
  topics: string[];
}

export interface OpenSourceAccountProfile {
  accountTitle: string;
  accountUrl: string;
  commitCount: number;
  flagshipRepos: OpenSourceFlagshipRepoProfile[];
  repoCount: number;
  sourceKey: string;
  summary: string;
  topLanguages: string[];
  topTopics: string[];
  totalStars: number;
}

export interface OpenSourceKnowledgeDocument {
  content: string;
  path: string;
  title: string;
}

function getMetadataKind(record: StoredSourceRecord) {
  return typeof record.metadata.kind === "string" ? record.metadata.kind : "";
}

function getStringMetadata(record: StoredSourceRecord, key: string) {
  return typeof record.metadata[key] === "string" ? record.metadata[key] : null;
}

function getNumberMetadata(record: StoredSourceRecord, key: string) {
  return typeof record.metadata[key] === "number" ? record.metadata[key] : null;
}

function getBooleanMetadata(record: StoredSourceRecord, key: string) {
  return typeof record.metadata[key] === "boolean" ? record.metadata[key] : null;
}

function getStringArrayMetadata(record: StoredSourceRecord, key: string) {
  const value = record.metadata[key];

  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function createSnippet(value: string, max = 220) {
  const compact = value.replace(/\s+/g, " ").trim();

  if (compact.length <= max) {
    return compact;
  }

  return `${compact.slice(0, max - 3).trim()}...`;
}

function scoreBlogLink(args: {
  blogRecord: StoredSourceRecord;
  packageName: string | null;
  repoName: string;
  repoSlug: string;
  topics: string[];
}) {
  const blogSlug = getStringMetadata(args.blogRecord, "slug") ?? "";
  const blogTitle = args.blogRecord.title;
  const blogContent = args.blogRecord.content;
  const blogTags = getStringArrayMetadata(args.blogRecord, "tags");

  let score = 0;

  if (blogSlug && blogSlug.toLowerCase().includes(args.repoSlug.toLowerCase())) {
    score += 8;
  }

  if (normalizeText(blogTitle).includes(normalizeText(args.repoSlug))) {
    score += 6;
  }

  if (normalizeText(blogContent).includes(normalizeText(args.repoSlug))) {
    score += 4;
  }

  if (
    args.packageName &&
    normalizeText(blogSlug).includes(normalizeText(args.packageName))
  ) {
    score += 8;
  }

  if (
    args.packageName &&
    normalizeText(blogTitle).includes(normalizeText(args.packageName))
  ) {
    score += 6;
  }

  const repoTokens = new Set([
    ...tokenize(args.repoSlug),
    ...tokenize(args.packageName ?? ""),
  ]);
  const blogTokens = new Set([
    ...tokenize(blogSlug),
    ...tokenize(blogTitle),
    ...blogTags.flatMap((tag) => tokenize(tag)),
  ]);
  const overlappingTokens = [...repoTokens].filter((token) => blogTokens.has(token));
  score += Math.min(overlappingTokens.length, 4);

  const overlappingTopics = args.topics.filter((topic) =>
    blogTags.some((tag) => normalizeText(tag) === normalizeText(topic)),
  );
  score += overlappingTopics.length * 2;

  return score;
}

export async function buildOpenSourceAccountProfile() {
  const [githubRecords, blogRecords] = await Promise.all([
    listSourceRecords({ limit: 200, sourceType: "github" }),
    listSourceRecords({ limit: 200, sourceType: "blog" }),
  ]);
  const accountRecord = githubRecords.find(
    (record) => getMetadataKind(record) === "account_summary",
  );
  const repoRecords = githubRecords
    .filter((record) => getMetadataKind(record) === "repo")
    .sort((left, right) => {
      const leftRank = getNumberMetadata(left, "rankIndex") ?? 999;
      const rightRank = getNumberMetadata(right, "rankIndex") ?? 999;

      return leftRank - rightRank;
    });
  const readmeRecordByRepo = new Map(
    githubRecords
      .filter((record) => getMetadataKind(record) === "repo_readme")
      .map((record) => [getStringMetadata(record, "repoName") ?? "", record]),
  );
  const packageRecordByRepo = new Map(
    githubRecords
      .filter((record) => getMetadataKind(record) === "repo_package")
      .map((record) => [getStringMetadata(record, "repoName") ?? "", record]),
  );
  const commitCount = githubRecords.filter(
    (record) => getMetadataKind(record) === "commit",
  ).length;
  const flagshipRepos = repoRecords
    .filter((record) => getBooleanMetadata(record, "isFlagship") !== false)
    .slice(0, 4)
    .map((record) => {
      const repoName = getStringMetadata(record, "repoName") ?? record.title;
      const repoSlug =
        getStringMetadata(record, "repoSlug") ?? repoName.split("/").pop() ?? repoName;
      const packageName =
        getStringMetadata(record, "packageName") ??
        getStringMetadata(packageRecordByRepo.get(repoName) ?? record, "packageName");
      const topics = getStringArrayMetadata(record, "topics");
      const linkedPosts = blogRecords
        .map((blogRecord) => ({
          path: blogRecord.pathOrUrl,
          score: scoreBlogLink({
            blogRecord,
            packageName,
            repoName,
            repoSlug,
            topics,
          }),
          title: blogRecord.title,
        }))
        .filter((entry) => entry.score >= 4)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3);

      return {
        language: getStringMetadata(record, "language"),
        linkedPosts,
        npmLatestVersion:
          getStringMetadata(record, "npmLatestVersion") ??
          getStringMetadata(packageRecordByRepo.get(repoName) ?? record, "latestVersion"),
        packageName,
        rankIndex: getNumberMetadata(record, "rankIndex") ?? 999,
        rankScore: getNumberMetadata(record, "rankScore") ?? 0,
        readmeExcerpt:
          getStringMetadata(record, "readmeExcerpt") ??
          readmeRecordByRepo.get(repoName)?.content ??
          null,
        repoName,
        repoSlug,
        repoUrl: record.pathOrUrl,
        summary: createSnippet(record.content, 280),
        topics,
      } satisfies OpenSourceFlagshipRepoProfile;
    });

  const topLanguages =
    getStringArrayMetadata(accountRecord ?? repoRecords[0] ?? createFallbackRecord(), "languages")
      .slice(0, 6);
  const fallbackLanguages =
    topLanguages.length > 0
      ? topLanguages
      : repoRecords
          .map((record) => getStringMetadata(record, "language"))
          .filter((entry): entry is string => Boolean(entry))
          .filter((entry, index, array) => array.indexOf(entry) === index)
          .slice(0, 6);
  const topTopics =
    getStringArrayMetadata(accountRecord ?? repoRecords[0] ?? createFallbackRecord(), "topTopics")
      .slice(0, 8);
  const fallbackTopics =
    topTopics.length > 0
      ? topTopics
      : repoRecords
          .flatMap((record) => getStringArrayMetadata(record, "topics"))
          .filter((entry, index, array) => array.indexOf(entry) === index)
          .slice(0, 8);
  const totalStars =
    getNumberMetadata(accountRecord ?? createFallbackRecord(), "totalStars") ??
    repoRecords.reduce(
      (sum, record) => sum + (getNumberMetadata(record, "stargazersCount") ?? 0),
      0,
    );
  const sourceKey =
    accountRecord?.sourceKey ?? repoRecords[0]?.sourceKey ?? "github-account";
  const accountUrl = accountRecord?.pathOrUrl ?? `https://github.com/${sourceKey}`;
  const repoCount =
    getNumberMetadata(accountRecord ?? createFallbackRecord(), "repoCount") ??
    repoRecords.length;
  const flagshipLabels = flagshipRepos
    .map((repo) =>
      repo.packageName ? `${repo.repoName} (${repo.packageName})` : repo.repoName,
    )
    .join(", ");

  return {
    accountTitle: accountRecord?.title ?? `${sourceKey} open source account`,
    accountUrl,
    commitCount,
    flagshipRepos,
    repoCount,
    sourceKey,
    summary:
      accountRecord?.content ??
      `${sourceKey} currently exposes ${repoCount} repositories and ${flagshipRepos.length} flagship repos. Key projects: ${flagshipLabels}.`,
    topLanguages: fallbackLanguages,
    topTopics: fallbackTopics,
    totalStars,
  } satisfies OpenSourceAccountProfile;
}

export async function buildOpenSourceKnowledgeDocuments() {
  const profile = await buildOpenSourceAccountProfile();
  const documents: OpenSourceKnowledgeDocument[] = [
    {
      content: [
        profile.summary,
        profile.flagshipRepos.length
          ? `Flagship repos: ${profile.flagshipRepos
              .map((repo) => repo.repoName)
              .join(", ")}`
          : "",
        profile.topLanguages.length
          ? `Languages: ${profile.topLanguages.join(", ")}`
          : "",
        profile.topTopics.length ? `Topics: ${profile.topTopics.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      path: profile.accountUrl,
      title: profile.accountTitle,
    },
  ];

  for (const repo of profile.flagshipRepos) {
    documents.push({
      content: [
        `Flagship repo: ${repo.repoName}`,
        repo.packageName ? `Package: ${repo.packageName}` : "",
        repo.npmLatestVersion ? `NPM latest: ${repo.npmLatestVersion}` : "",
        repo.language ? `Language: ${repo.language}` : "",
        repo.topics.length ? `Topics: ${repo.topics.join(", ")}` : "",
        repo.summary,
        repo.readmeExcerpt ? `README: ${createSnippet(repo.readmeExcerpt, 320)}` : "",
        repo.linkedPosts.length
          ? `Linked blog posts: ${repo.linkedPosts
              .map((post) => `${post.title} (${post.score})`)
              .join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      path: repo.repoUrl,
      title: repo.repoName,
    });
  }

  return documents;
}

function createFallbackRecord(): StoredSourceRecord {
  return {
    content: "",
    contentHash: "",
    createdAt: "",
    metadata: {},
    pathOrUrl: "",
    sourceId: "",
    sourceKey: "",
    sourceType: "github",
    title: "",
    updatedAt: "",
  };
}
