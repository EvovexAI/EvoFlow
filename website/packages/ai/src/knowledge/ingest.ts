/**
 * Knowledge Ingestion Pipeline
 *
 * Chunks text from all canonical sources, embeds via text-embedding-3-small,
 * and persists to the knowledge_chunks table for vector similarity retrieval.
 * When pgvector is unavailable the chunks are still stored (for TF-IDF fallback).
 */

import crypto from "node:crypto";
import { getHomeContent, getPersonalProfile, getSiteCopy, projects, timeline } from "../../../content/src";
import {
  countKnowledgeChunks,
  deleteKnowledgeChunksBySource,
  deleteKnowledgeChunksByTypeAndLocale,
  listSourceRecords,
  upsertKnowledgeChunksBatch,
  type UpsertKnowledgeChunkInput,
} from "../../../db/src";

const CHUNK_MAX_CHARS = 800;
const CHUNK_OVERLAP_CHARS = 120;

/**
 * Embedding function interface — callers (apps/web, apps/worker) inject
 * their own implementation so this package stays free of @ai-sdk/* deps.
 */
export type EmbedFn = (texts: string[]) => Promise<(number[] | null)[]>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkId(sourceType: string, sourceKey: string, locale: string, index: number) {
  const base = `${sourceType}:${sourceKey}:${locale}:${index}`;
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 24);
}

/** Split a long text into overlapping windows for better retrieval coverage. */
function chunkText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= CHUNK_MAX_CHARS) return [cleaned];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < cleaned.length) {
    const end = Math.min(offset + CHUNK_MAX_CHARS, cleaned.length);
    chunks.push(cleaned.slice(offset, end));
    offset += CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS;
    if (offset >= cleaned.length) break;
  }

  return chunks;
}

/** Default no-op embed function — caller should inject a real implementation. */
const noopEmbedFn: EmbedFn = (texts) => Promise.resolve(texts.map(() => null));

// ─── Source builders ──────────────────────────────────────────────────────────

function buildStaticChunks(locale: "zh" | "en"): Array<{ content: string; sourceKey: string; sourceType: string; title: string }> {
  const profile = getPersonalProfile(locale);
  const home = getHomeContent(locale);
  const siteCopy = getSiteCopy(locale);

  const raw: Array<{ content: string; sourceKey: string; title: string }> = [
    {
      content: [profile.name, profile.title, profile.summary]
        .filter(Boolean)
        .join("\n"),
      sourceKey: "personal-profile",
      title: locale === "zh" ? "个人简介" : "Personal Profile",
    },
    {
      content: [
        home.hero.title,
        home.hero.description,
        home.hero.productArchitecture.title,
        home.hero.productArchitecture.description,
        home.hero.productArchitecture.layers
          .map(
            (layer) =>
              `${layer.label}\n${layer.modules.map((m) => `${m.title}: ${m.description}`).join("\n")}`,
          )
          .join("\n\n"),
        home.capabilities.title,
        home.capabilities.description,
        [
          home.capabilities.focusBand.supervisorTitle,
          home.capabilities.focusBand.supervisorHook,
          home.capabilities.focusBand.supervisorRoles.map((r) => `${r.label}: ${r.text}`).join("\n"),
          home.capabilities.focusBand.planBadge,
          home.capabilities.focusBand.planTitle,
          home.capabilities.focusBand.planPoints.join("\n"),
          home.capabilities.focusBand.arrowLabel,
        ].join("\n"),
        home.capabilities.closedLoopFlow.label,
        home.capabilities.closedLoopFlow.steps
          .map((s, i) => `${home.capabilities.closedLoopFlow.stepPrefix} ${i + 1}: ${s.title}: ${s.summary}`)
          .join("\n"),
        home.capabilities.primaryCard.title,
        home.capabilities.primaryCard.description,
        home.capabilities.primaryCard.flowStrip.join(" → "),
        home.capabilities.primaryCard.bullets.join("\n"),
        home.capabilities.secondaryCard.title,
        home.capabilities.secondaryCard.description,
        home.capabilities.secondaryCard.flowStrip.join(" → "),
        home.capabilities.secondaryCard.bullets.join("\n"),
        [
          home.capabilities.scenarioFloor.eyebrow,
          home.capabilities.scenarioFloor.title,
          home.capabilities.scenarioFloor.description,
          home.capabilities.scenarioFloor.intro,
          ...home.capabilities.scenarioFloor.panels.map((p) => {
            const tagLine = p.tags?.length ? `Tags: ${p.tags.join(", ")}` : "";
            const linkLine =
              p.links?.map((l) => `${l.label} ${l.href}`).join(" | ") ?? "";
            return [p.title, p.lead, p.highlights.join("\n"), tagLine, linkLine].filter(Boolean).join("\n");
          }),
        ].join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n"),
      sourceKey: "home-capabilities",
      title: locale === "zh" ? "首页与能力矩阵" : "Homepage & Capabilities",
    },
    {
      content: projects
        .map((p) => `${p.title}\n${p.summary}\nTech: ${p.tags.join(", ")}`)
        .join("\n\n"),
      sourceKey: "projects",
      title: locale === "zh" ? "项目列表" : "Projects",
    },
    {
      content: timeline
        .map((item) => `${item.year} — ${item.title}\n${item.description}`)
        .join("\n\n"),
      sourceKey: "timeline",
      title: locale === "zh" ? "技术时间线" : "Technical Timeline",
    },
    {
      content: [
        siteCopy.pages.ai.title,
        siteCopy.pages.ai.description,
        siteCopy.pages.aiChat.title,
        siteCopy.pages.aiChat.description,
        siteCopy.pages.aiKnowledge.title,
        siteCopy.pages.aiKnowledge.description,
      ]
        .filter(Boolean)
        .join("\n"),
      sourceKey: "site-copy",
      title: locale === "zh" ? "页面文案与站点结构" : "Site Pages & Copy",
    },
  ];

  return raw.map((item) => ({ ...item, sourceType: "static" }));
}

/** Source records (GitHub / blog) are locale-neutral — same data served for all locales. */
async function buildSourceRecordChunks() {
  const [blogRecords, githubRecords] = await Promise.all([
    listSourceRecords({ limit: 100, sourceType: "blog" }),
    listSourceRecords({ limit: 40, sourceType: "github" }),
  ]);

  const all = [
    ...blogRecords.map((r) => ({
      content: r.content,
      sourceKey: r.pathOrUrl,
      sourceType: "blog" as const,
      title: r.title,
    })),
    ...githubRecords.map((r) => ({
      content: r.content,
      sourceKey: r.pathOrUrl,
      sourceType: "github" as const,
      title: r.title,
    })),
  ];

  return all;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface IngestResult {
  chunksUpserted: number;
  durationMs: number;
  errors: string[];
  locale: "zh" | "en";
  sourcesProcessed: number;
}

/**
 * Ingest all knowledge sources for the given locale.
 * Deletes stale static chunks for this locale then re-ingests all sources.
 *
 * @param embedFn - Inject an embedding function from the calling app.
 *   When omitted, chunks are stored without embeddings (TF-IDF fallback remains active).
 */
export async function ingestAllKnowledge(
  locale: "zh" | "en",
  embedFn: EmbedFn = noopEmbedFn,
): Promise<IngestResult> {
  const startMs = Date.now();
  const errors: string[] = [];
  let chunksUpserted = 0;
  let sourcesProcessed = 0;

  // Build raw source documents
  const staticSources = buildStaticChunks(locale);
  let dynamicSources: Array<{ content: string; sourceKey: string; sourceType: string; title: string }> = [];

  try {
    dynamicSources = await buildSourceRecordChunks();
  } catch (err) {
    errors.push(`Dynamic sources error: ${String(err)}`);
  }

  const allSources = [...staticSources, ...dynamicSources];
  sourcesProcessed = allSources.length;

  // Clear existing static chunks for this locale before re-ingesting.
  // Use source_type + locale filter since static chunks have per-doc source_key values.
  try {
    await deleteKnowledgeChunksByTypeAndLocale("static", locale);
  } catch {
    // Table might not exist yet on first run — ignore
  }

  // Flatten sources into chunks
  const flatChunks: Array<{
    content: string;
    index: number;
    sourceKey: string;
    sourceType: string;
    title: string;
  }> = [];

  for (const src of allSources) {
    const parts = chunkText(src.content);
    for (let i = 0; i < parts.length; i++) {
      flatChunks.push({
        content: parts[i]!,
        index: i,
        sourceKey: src.sourceKey,
        sourceType: src.sourceType,
        title: parts.length > 1 ? `${src.title} (${i + 1}/${parts.length})` : src.title,
      });
    }
  }

  // Embed in batches of 20
  const BATCH_SIZE = 20;
  for (let batchStart = 0; batchStart < flatChunks.length; batchStart += BATCH_SIZE) {
    const batch = flatChunks.slice(batchStart, batchStart + BATCH_SIZE);
    const texts = batch.map((c) => c.content);
    const embeddings = await embedFn(texts);

    const upsertBatch: UpsertKnowledgeChunkInput[] = batch.map((chunk, i) => ({
      content: chunk.content,
      embedding: embeddings[i] ?? undefined,
      id: chunkId(chunk.sourceType, chunk.sourceKey, locale, chunk.index),
      locale,
      metadata: { sourceKey: chunk.sourceKey, sourceType: chunk.sourceType },
      source_key: chunk.sourceKey,
      source_type: chunk.sourceType,
      title: chunk.title,
    }));

    try {
      await upsertKnowledgeChunksBatch(upsertBatch);
      chunksUpserted += upsertBatch.length;
    } catch (err) {
      errors.push(`Batch upsert error: ${String(err)}`);
    }
  }

  return {
    chunksUpserted,
    durationMs: Date.now() - startMs,
    errors,
    locale,
    sourcesProcessed,
  };
}

/**
 * Ingest a single source record by its type and key (used after sync jobs).
 */
export async function ingestSourceRecord(
  sourceType: string,
  sourceKey: string,
  title: string,
  content: string,
  locale: "zh" | "en",
  embedFn: EmbedFn = noopEmbedFn,
): Promise<{ chunksUpserted: number }> {
  await deleteKnowledgeChunksBySource(sourceType, sourceKey);

  const parts = chunkText(content);
  const embeddings = await embedFn(parts);

  const chunks: UpsertKnowledgeChunkInput[] = parts.map((part, i) => ({
    content: part,
    embedding: embeddings[i] ?? undefined,
      id: chunkId(sourceType, sourceKey, locale, i),
    locale,
    metadata: { sourceKey, sourceType },
    source_key: sourceKey,
    source_type: sourceType,
    title: parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title,
  }));

  await upsertKnowledgeChunksBatch(chunks);
  return { chunksUpserted: chunks.length };
}

export async function getKnowledgeIndexStats() {
  const [totalZh, totalEn] = await Promise.all([
    countKnowledgeChunks("zh"),
    countKnowledgeChunks("en"),
  ]);
  return { totalEn, totalZh, total: totalZh + totalEn };
}
