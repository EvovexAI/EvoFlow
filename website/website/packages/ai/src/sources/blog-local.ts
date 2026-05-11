import fs from "node:fs";
import path from "node:path";
import { replaceSourceRecords } from "../../../db/src/repos/source-records";
import { upsertSourceSyncState } from "../../../db/src/repos/source-sync-state";
import { createContentHash } from "../../../db/src/repos/source-state";
import { resolveBlogSourceConfig } from "./config";

interface BlogDocumentSignal {
  category: string | null;
  excerpt: string;
  publishDate: string | null;
  relativePath: string;
  slug: string;
  tags: string[];
  title: string;
  updatedAt: string;
}

export interface BlogSyncResult {
  contentRoot: string;
  directory: string;
  documents: BlogDocumentSignal[];
  recordCount: number;
  sourceKey: string;
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/");
}

function listMarkdownFiles(targetDirectory: string): string[] {
  const entries = fs.readdirSync(targetDirectory, {
    withFileTypes: true,
  });

  return entries.flatMap((entry) => {
    const absolutePath = path.join(targetDirectory, entry.name);

    if (entry.isDirectory()) {
      if ([".git", ".idea", ".turbo", "dist", "node_modules"].includes(entry.name)) {
        return [];
      }

      return listMarkdownFiles(absolutePath);
    }

    return /\.(md|mdx)$/i.test(entry.name) ? [absolutePath] : [];
  });
}

function parseScalarValue(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function parseFrontmatter(raw: string) {
  if (!raw.startsWith("---")) {
    return {
      attributes: {} as Record<string, unknown>,
      body: raw,
    };
  }

  const lines = raw.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (endIndex <= 0) {
    return {
      attributes: {} as Record<string, unknown>,
      body: raw,
    };
  }

  const attributes = lines
    .slice(1, endIndex)
    .reduce<Record<string, unknown>>((result, line) => {
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);

      if (!match) {
        return result;
      }

      result[match[1]] = parseScalarValue(match[2]);
      return result;
    }, {});

  return {
    attributes,
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function extractTitleFromBody(body: string, fallback: string) {
  const headingLine = body.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return headingLine ? headingLine.replace(/^#\s+/, "").trim() : fallback;
}

function createExcerpt(input: string, max = 220) {
  const compact = input.replace(/\s+/g, " ").trim();

  if (compact.length <= max) {
    return compact;
  }

  return `${compact.slice(0, max - 3).trim()}...`;
}

function buildSlug(relativePath: string) {
  const normalized = normalizePath(relativePath);
  return normalized
    .replace(/^src\/content\//, "")
    .replace(/\/index\.(md|mdx)$/i, "")
    .replace(/\.(md|mdx)$/i, "");
}

function createBlogRecord(args: {
  body: string;
  document: BlogDocumentSignal;
  directory: string;
  metadata: Record<string, unknown>;
}) {
  const content = [
    args.document.title,
    args.document.excerpt,
    args.body.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    content,
    metadata: {
      ...args.metadata,
      category: args.document.category,
      excerpt: args.document.excerpt,
      kind: "document",
      publishDate: args.document.publishDate,
      slug: args.document.slug,
      tags: args.document.tags,
    },
    pathOrUrl: args.document.relativePath,
    sourceId: args.document.slug || args.document.relativePath,
    sourceKey: args.directory,
    sourceType: "blog" as const,
    title: args.document.title,
    updatedAt: args.document.updatedAt,
  };
}

export async function syncLocalBlogSource() {
  const config = resolveBlogSourceConfig();
  const sourceKey = config.directory;

  await upsertSourceSyncState({
    contentHash: null,
    cursor: null,
    itemCount: 0,
    lastError: null,
    lastSyncedAt: null,
    metadata: {
      contentRoot: config.contentRoot,
      directory: config.directory,
    },
    sourceKey,
    sourceType: "blog",
    status: "syncing",
  });

  try {
    const markdownFiles = listMarkdownFiles(config.contentRoot);
    const rawDocuments = markdownFiles.map((absolutePath) => {
      const raw = fs.readFileSync(absolutePath, "utf8");
      const parsed = parseFrontmatter(raw);
      const stat = fs.statSync(absolutePath);
      const relativePath = normalizePath(path.relative(config.directory, absolutePath));
      const fallbackTitle = normalizePath(path.basename(path.dirname(absolutePath)));
      const title =
        (typeof parsed.attributes.title === "string" && parsed.attributes.title.trim()) ||
        extractTitleFromBody(parsed.body, fallbackTitle);
      const description =
        typeof parsed.attributes.description === "string"
          ? parsed.attributes.description
          : "";
      const tags = Array.isArray(parsed.attributes.tags)
        ? parsed.attributes.tags.filter((entry): entry is string => typeof entry === "string")
        : [];
      const slug = buildSlug(relativePath);
      const category = slug.split("/")[0] || null;

      return {
        body: parsed.body,
        document: {
          category,
          excerpt: createExcerpt(description || parsed.body),
          publishDate:
            typeof parsed.attributes.publishDate === "string"
              ? parsed.attributes.publishDate
              : null,
          relativePath,
          slug,
          tags,
          title,
          updatedAt: stat.mtime.toISOString(),
        } satisfies BlogDocumentSignal,
        metadata: parsed.attributes,
      };
    });
    const documents = [...rawDocuments]
      .map((entry) => entry.document)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const sourceRecords = rawDocuments
      .sort((left, right) =>
        right.document.updatedAt.localeCompare(left.document.updatedAt),
      )
      .map((entry) =>
        createBlogRecord({
          body: entry.body,
          directory: config.directory,
          document: entry.document,
          metadata: entry.metadata,
        }),
      );
    const topCategories = documents
      .map((document) => document.category)
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry, index, array) => array.indexOf(entry) === index)
      .slice(0, 6);
    const topTags = documents
      .flatMap((document) => document.tags)
      .filter((entry, index, array) => array.indexOf(entry) === index)
      .slice(0, 8);
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
      sourceType: "blog",
    });
    await upsertSourceSyncState({
      contentHash,
      cursor: documents[0]?.slug ?? null,
      itemCount: sourceRecords.length,
      lastError: null,
      lastSyncedAt: new Date().toISOString(),
      metadata: {
        contentRoot: config.contentRoot,
        directory: config.directory,
        documentCount: documents.length,
        topCategories,
        topTags,
      },
      sourceKey,
      sourceType: "blog",
      status: "completed",
    });

    return {
      contentRoot: config.contentRoot,
      directory: config.directory,
      documents,
      recordCount: sourceRecords.length,
      sourceKey,
    } satisfies BlogSyncResult;
  } catch (error) {
    await upsertSourceSyncState({
      contentHash: null,
      cursor: null,
      itemCount: 0,
      lastError: error instanceof Error ? error.message : "unknown_blog_sync_error",
      lastSyncedAt: null,
      metadata: {
        contentRoot: config.contentRoot,
        directory: config.directory,
      },
      sourceKey,
      sourceType: "blog",
      status: "failed",
    });
    throw error;
  }
}
