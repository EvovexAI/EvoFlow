import fs from "node:fs";
import path from "node:path";
import { type ChatSource, type ChatToolCall } from "../chat/demo-chat";
import {
  createEvolutionRunResponse,
  type EvolutionAction,
  type EvolutionRadarMetric,
  type EvolutionRequest,
} from "../demo-evolution";
import { runJob } from "../jobs/runner";
import { getHomeContent } from "../../../content/src/home";
import { projects } from "../../../content/src/projects";
import { getSiteCopy } from "../../../content/src/site-copy";
import { timeline } from "../../../content/src/timeline";
import { listJobRuns } from "../../../db/src/repos/job-runs";
import { countSourceRecords, listSourceRecords } from "../../../db/src/repos/source-records";
import { listSourceSyncStates } from "../../../db/src/repos/source-sync-state";
import { getRuntimeObservabilitySnapshot } from "../../../db/src/repos/runtime-observability";
import { getWorkspaceRoot } from "../../../db/src/repos/runtime-files";
import { buildOpenSourceAccountProfile } from "../sources/open-source-profile";

interface EvolutionRuntimeDraft {
  bullets: string[];
  radarMetrics: EvolutionRadarMetric[];
  sources: ChatSource[];
  summary: string;
  toolCalls: ChatToolCall[];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function compactText(value: string, max = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 3).trim()}...`;
}

function parseDurationMs(duration: string) {
  return Math.round(Number.parseFloat(duration.replace("s", "")) * 1000);
}

function readMarkdownHeadings(filename: string, limit = 6) {
  try {
    const filePath = path.join(getWorkspaceRoot(), filename);
    const raw = fs.readFileSync(filePath, "utf8");

    return raw
      .split(/\r?\n/)
      .filter((line) => /^##+\s+/.test(line))
      .map((line) => line.replace(/^##+\s+/, "").trim())
      .slice(0, limit);
  } catch {
    return [] as string[];
  }
}

function countMarkdownSections(filename: string) {
  try {
    const filePath = path.join(getWorkspaceRoot(), filename);
    const raw = fs.readFileSync(filePath, "utf8");

    return raw.split(/\r?\n/).filter((line) => /^##+\s+/.test(line)).length;
  } catch {
    return 0;
  }
}

function dedupeSources(sources: ChatSource[], limit = 8) {
  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = source.path;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  }).slice(0, limit);
}

function dedupeToolCalls(toolCalls: ChatToolCall[], limit = 8) {
  const seen = new Set<string>();

  return toolCalls.filter((toolCall) => {
    const key = `${toolCall.name}:${toolCall.detail}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  }).slice(0, limit);
}

async function buildRebuildIndexDraft(
  request: EvolutionRequest,
): Promise<EvolutionRuntimeDraft> {
  const homeContent = getHomeContent(request.locale);
  const siteCopy = getSiteCopy(request.locale);
  const designHeadings = readMarkdownHeadings("DESIGN.md", 4);
  const memoryHeadings = readMarkdownHeadings("MEMORY.md", 4);
  const markdownSections =
    countMarkdownSections("DESIGN.md") + countMarkdownSections("MEMORY.md");
  const typedContentGroups =
    Object.keys(siteCopy.pages).length +
    1 + // homepage closingNote
    homeContent.capabilities.scenarioFloor.panels.length +
    projects.length +
    timeline.length;
  const anchorHeading =
    designHeadings[0] ?? memoryHeadings[0] ?? homeContent.hero.title;

  return {
    bullets:
      request.locale === "zh"
        ? [
            `已重新扫描 ${markdownSections} 个 markdown section，并把索引锚定到「${anchorHeading}」。`,
            `typed content 侧共复核了 ${typedContentGroups} 个内容分组，覆盖首页、站点结构、项目与时间线。`,
            "当前 retrieval context 已不再停留在 demo 文案，而是围绕真实 Phase 1 进度刷新。",
          ]
        : [
            `Rescanned ${markdownSections} markdown sections and anchored the refreshed index on "${anchorHeading}".`,
            `Reviewed ${typedContentGroups} typed-content groups across the homepage, site structure, projects, and timeline.`,
            "The retrieval context now refreshes around the real Phase 1 progress instead of staying on demo copy.",
          ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "索引新鲜度" : "Index freshness",
        value: clamp(54 + markdownSections * 2, 68, 98),
      },
      {
        label: request.locale === "zh" ? "来源排序" : "Source ranking",
        value: clamp(52 + typedContentGroups * 2, 66, 96),
      },
      {
        label: request.locale === "zh" ? "召回质量" : "Recall quality",
        value: clamp(50 + designHeadings.length * 8 + memoryHeadings.length * 6, 64, 95),
      },
      {
        label: request.locale === "zh" ? "上下文对齐" : "Context alignment",
        value: clamp(56 + homeContent.capabilities.scenarioFloor.panels.length * 8, 70, 97),
      },
    ],
    sources: [
      {
        path: "DESIGN.md",
        title:
          request.locale === "zh" ? "总体技术设计" : "Technical design",
      },
      {
        path: "MEMORY.md",
        title:
          request.locale === "zh" ? "开发记忆与阶段进度" : "Development memory",
      },
      {
        path: "packages/content/src/home.ts",
        title:
          request.locale === "zh"
            ? "首页 typed content"
            : "Homepage typed content",
      },
      {
        path: "packages/content/src/site-copy.ts",
        title:
          request.locale === "zh"
            ? "站点结构与页面 copy"
            : "Site structure and page copy",
      },
    ],
    summary:
      request.locale === "zh"
        ? `Knowledge index rebuild 已重新扫描 ${markdownSections} 个 markdown section 与 ${typedContentGroups} 个 typed-content 分组，并把当前索引焦点锚定在「${anchorHeading}」。`
        : `The knowledge index rebuild rescanned ${markdownSections} markdown sections and ${typedContentGroups} typed-content groups, anchoring the current index focus on "${anchorHeading}".`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? `扫描了 DESIGN / MEMORY 共 ${markdownSections} 个 markdown section`
            : `Scanned ${markdownSections} markdown sections across DESIGN and MEMORY`,
        name: "scanMarkdownSources",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `复核了 ${typedContentGroups} 个 typed-content 分组`
            : `Reviewed ${typedContentGroups} typed-content groups`,
        name: "refreshTypedContentIndex",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `将当前索引焦点锚定到「${anchorHeading}」`
            : `Anchored the refreshed index on "${anchorHeading}"`,
        name: "rankContextSources",
        status: "completed",
      },
    ],
  };
}

async function buildRunSyncDraft(
  request: EvolutionRequest,
): Promise<EvolutionRuntimeDraft> {
  const [
    githubSync,
    blogSync,
    codingDna,
    githubSourceRecords,
    blogSourceRecords,
    syncStates,
    accountProfile,
  ] = await Promise.all([
    runJob({ jobId: "github-sync", locale: request.locale }),
    runJob({ jobId: "blog-sync", locale: request.locale }),
    runJob({ jobId: "rebuild-coding-dna", locale: request.locale }),
    listSourceRecords({ limit: 3, sourceType: "github" }),
    listSourceRecords({ limit: 3, sourceType: "blog" }),
    listSourceSyncStates(6),
    buildOpenSourceAccountProfile(),
  ]);
  const combinedSources = dedupeSources([
    ...githubSync.sources,
    ...blogSync.sources,
    ...codingDna.sources,
    ...githubSourceRecords.map((record) => ({
      path: record.pathOrUrl,
      title: record.title,
    })),
    ...blogSourceRecords.map((record) => ({
      path: record.pathOrUrl,
      title: record.title,
    })),
    ...accountProfile.flagshipRepos.map((repo) => ({
      path: repo.repoUrl,
      title: repo.repoName,
    })),
    ...accountProfile.flagshipRepos.flatMap((repo) =>
      repo.linkedPosts.slice(0, 1).map((post) => ({
        path: post.path,
        title: post.title,
      })),
    ),
  ]);
  const recentPersistedRuns = (await listJobRuns(4))
    .map((run) => run.jobId)
    .join(", ");
  const sourceRecordCount = githubSourceRecords.length + blogSourceRecords.length;
  const syncHealthSummary =
    syncStates
      .map((state) => `${state.sourceType}:${state.status}`)
      .join(", ") || "none";
  const totalDurationMs =
    parseDurationMs(githubSync.recentRun.duration) +
    parseDurationMs(blogSync.recentRun.duration) +
    parseDurationMs(codingDna.recentRun.duration);
  const totalToolCalls =
    githubSync.toolCalls.length +
    blogSync.toolCalls.length +
    codingDna.toolCalls.length;
  const flagshipLabels =
    accountProfile.flagshipRepos
      .slice(0, 3)
      .map((repo) =>
        repo.packageName ? `${repo.repoName} (${repo.packageName})` : repo.repoName,
      )
      .join(", ") || "none";
  const linkedPostTitles =
    [...new Set(
      accountProfile.flagshipRepos.flatMap((repo) =>
        repo.linkedPosts.map((post) => post.title),
      ),
    )]
      .slice(0, 3)
      .join(", ") || "none";

  return {
    bullets:
      request.locale === "zh"
        ? [
            "GitHub / Blog / 首页能力指纹 三条链路已在 shared runtime 中完成一次联动同步。",
            `本次共聚合 ${combinedSources.length} 个来源、${totalToolCalls} 个工具步骤，并直接消费了 ${sourceRecordCount} 条真实 source records。`,
            `当前旗舰 repo 为 ${flagshipLabels}，最近关联文章包括 ${linkedPostTitles}。`,
            `最近持久化任务为 ${recentPersistedRuns || "none"}，当前同步状态为 ${syncHealthSummary}。`,
            "当前 evolution timeline 已准备接收新的工程信号、blog 文档增量与首页指纹刷新。",
          ]
        : [
            "GitHub, Blog, and the homepage fingerprint job completed a linked sync pass inside the shared runtime.",
            `The run combined ${combinedSources.length} sources, ${totalToolCalls} tool steps, and directly consumed ${sourceRecordCount} persisted source records.`,
            `The flagship repos are ${flagshipLabels}, with linked posts such as ${linkedPostTitles}.`,
            `Recent persisted jobs were ${recentPersistedRuns || "none"}, with sync health currently at ${syncHealthSummary}.`,
            "The evolution timeline is now ready to absorb fresh engineering signals, blog deltas, and homepage fingerprint updates.",
          ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "同步健康" : "Sync health",
        value: clamp(56 + combinedSources.length * 5, 70, 97),
      },
      {
        label: request.locale === "zh" ? "事件摄入" : "Event ingestion",
        value: clamp(52 + totalToolCalls * 4, 68, 96),
      },
      {
        label: request.locale === "zh" ? "时间线写入" : "Timeline write",
        value: clamp(50 + githubSync.sources.length * 8 + codingDna.sources.length * 4, 64, 95),
      },
      {
        label: request.locale === "zh" ? "远程准备" : "Remote readiness",
        value: clamp(48 + Math.round(totalDurationMs / 180), 62, 93),
      },
    ],
    sources: combinedSources,
    summary:
      request.locale === "zh"
        ? `Run Sync Pipeline 已在 shared runtime 中串行覆盖 GitHub / Blog / 首页能力指纹 三条链路，共聚合 ${combinedSources.length} 个来源、${totalToolCalls} 次工具步骤，并读取了 ${sourceRecordCount} 条真实 source records。当前旗舰 repo 为 ${flagshipLabels}，关联文章包括 ${linkedPostTitles}。同步状态为 ${syncHealthSummary}。`
        : `Run Sync Pipeline covered GitHub, Blog, and the homepage fingerprint job inside the shared runtime, combining ${combinedSources.length} sources, ${totalToolCalls} tool steps, and ${sourceRecordCount} persisted source records. The flagship repos are ${flagshipLabels}, with linked posts such as ${linkedPostTitles}. Sync health is ${syncHealthSummary}.`,
    toolCalls: dedupeToolCalls([
      {
        detail: compactText(githubSync.summary, 140),
        name: "runGithubSync",
        status: "completed",
      },
      {
        detail: compactText(blogSync.summary, 140),
        name: "runBlogSync",
        status: "completed",
      },
      {
        detail: compactText(codingDna.summary, 140),
        name: "rebuildCodingDna",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `已为 evolution timeline 组合 ${combinedSources.length} 个最新来源信号，并对齐旗舰 repo ${flagshipLabels}`
            : `Prepared ${combinedSources.length} fresh source signals for the evolution timeline while aligning flagship repos ${flagshipLabels}`,
        name: "prepareEvolutionTimeline",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `建立了 repo 与 blog 的关联叙事，当前命中 ${linkedPostTitles}`
            : `Built the repo-to-blog narrative links with matches such as ${linkedPostTitles}`,
        name: "linkOpenSourceNarratives",
        status: "completed",
      },
    ]),
  };
}

async function buildGenerateDigestDraft(
  request: EvolutionRequest,
): Promise<EvolutionRuntimeDraft> {
  const [
    weeklyDigest,
    aggregateMetrics,
    recentSourceRecords,
    syncStates,
    githubSourceCount,
    blogSourceCount,
    accountProfile,
  ] = await Promise.all([
    runJob({ jobId: "weekly-digest", locale: request.locale }),
    runJob({ jobId: "aggregate-metrics", locale: request.locale }),
    listSourceRecords({ limit: 4 }),
    listSourceSyncStates(6),
    countSourceRecords({ sourceType: "github" }),
    countSourceRecords({ sourceType: "blog" }),
    buildOpenSourceAccountProfile(),
  ]);
  const observability = await getRuntimeObservabilitySnapshot();
  const recentPersistedRuns = (await listJobRuns(5))
    .map((run) => run.jobId)
    .join(", ");
  const combinedSources = dedupeSources([
    ...weeklyDigest.sources,
    ...aggregateMetrics.sources,
    ...recentSourceRecords.map((record) => ({
      path: record.pathOrUrl,
      title: record.title,
    })),
    ...accountProfile.flagshipRepos.map((repo) => ({
      path: repo.repoUrl,
      title: repo.repoName,
    })),
  ]);
  const latestToolNames =
    observability.latestToolNames.join(", ") ||
    (request.locale === "zh" ? "暂无工具调用" : "no recent tool calls");
  const totalObservabilitySignals = Object.values(observability.counts).reduce(
    (total, value) => total + value,
    0,
  );
  const sourceRecordCount = githubSourceCount + blogSourceCount;
  const syncHealthSummary =
    syncStates
      .map((state) => `${state.sourceType}:${state.status}`)
      .join(", ") || "none";
  const flagshipLabels =
    accountProfile.flagshipRepos
      .slice(0, 3)
      .map((repo) =>
        repo.packageName ? `${repo.repoName} (${repo.packageName})` : repo.repoName,
      )
      .join(", ") || "none";
  const linkedPostTitles =
    [...new Set(
      accountProfile.flagshipRepos.flatMap((repo) =>
        repo.linkedPosts.map((post) => post.title),
      ),
    )]
      .slice(0, 3)
      .join(", ") || "none";

  return {
    bullets:
      request.locale === "zh"
        ? [
            "Weekly digest 与 metrics aggregate 已在 shared runtime 中完成一次联合生成。",
            `当前摘要共聚合 ${combinedSources.length} 个来源，并参考最近持久化任务 ${recentPersistedRuns || "none"}。`,
            `当前已纳入 ${sourceRecordCount} 条真实 GitHub / Blog source records，旗舰 repo 为 ${flagshipLabels}。`,
            `最近关联文章包括 ${linkedPostTitles}，同步状态为 ${syncHealthSummary}。`,
            `本次投递还会带上最新工具轨迹 ${latestToolNames}，供首页和 admin surface 继续消费。`,
          ]
        : [
            "Weekly digest and metrics aggregate completed as a combined shared-runtime generation pass.",
            `The draft now combines ${combinedSources.length} sources and references recent persisted jobs from ${recentPersistedRuns || "none"}.`,
            `It now includes ${sourceRecordCount} persisted GitHub/blog source records, with flagship repos ${flagshipLabels}.`,
            `Recent linked posts include ${linkedPostTitles}, with sync health ${syncHealthSummary}.`,
            `The next delivery can carry tool trails from ${latestToolNames} into the homepage and admin surfaces.`,
          ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "摘要覆盖" : "Digest coverage",
        value: clamp(54 + combinedSources.length * 5 + observability.counts.jobRuns * 4, 70, 98),
      },
      {
        label: request.locale === "zh" ? "信号密度" : "Signal density",
        value: clamp(50 + observability.latestToolNames.length * 12, 64, 95),
      },
      {
        label: request.locale === "zh" ? "投递准备" : "Delivery readiness",
        value: clamp(52 + observability.counts.uiActions * 6 + observability.counts.sessions * 4, 66, 95),
      },
      {
        label: request.locale === "zh" ? "内容贴合" : "Content fit",
        value: clamp(
          50 + Math.round(parseDurationMs(weeklyDigest.recentRun.duration) / 80),
          68,
          96,
        ),
      },
    ],
    sources: combinedSources,
    summary:
      request.locale === "zh"
        ? `Generate Weekly Digest 已把 weekly digest 与 metrics aggregate 两条真实链路合并成一个 evolution 摘要，当前共聚合 ${combinedSources.length} 个来源、${sourceRecordCount} 条真实 source records，并参考了 ${totalObservabilitySignals} 条 observability signals。旗舰 repo 为 ${flagshipLabels}，关联文章包括 ${linkedPostTitles}。`
        : `Generate Weekly Digest merged the weekly-digest and metrics-aggregate runtime paths into a single evolution summary, combining ${combinedSources.length} sources, ${sourceRecordCount} persisted source records, and ${totalObservabilitySignals} observability signals. The flagship repos are ${flagshipLabels}, with linked posts such as ${linkedPostTitles}.`,
    toolCalls: dedupeToolCalls([
      {
        detail: compactText(weeklyDigest.summary, 140),
        name: "runWeeklyDigest",
        status: "completed",
      },
      {
        detail: compactText(aggregateMetrics.summary, 140),
        name: "aggregateRuntimeMetrics",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `已按 ${latestToolNames} 的最新工具轨迹准备投递摘要`
            : `Prepared the delivery summary around recent tool trails from ${latestToolNames}`,
        name: "stageDigestDelivery",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `将旗舰 repo ${flagshipLabels} 与关联文章 ${linkedPostTitles} 注入摘要语义层`
            : `Injected flagship repos ${flagshipLabels} and linked posts ${linkedPostTitles} into the digest narrative`,
        name: "composeOpenSourceDigest",
        status: "completed",
      },
    ]),
  };
}

const actionBuilders: Record<
  EvolutionAction,
  (request: EvolutionRequest) => Promise<EvolutionRuntimeDraft>
> = {
  generate_digest: buildGenerateDigestDraft,
  rebuild_index: buildRebuildIndexDraft,
  run_sync: buildRunSyncDraft,
};

export async function runEvolution(request: EvolutionRequest) {
  const draft = await actionBuilders[request.action](request);

  return createEvolutionRunResponse({
    action: request.action,
    bullets: draft.bullets,
    locale: request.locale,
    radarMetrics: draft.radarMetrics,
    sources: draft.sources,
    summary: draft.summary,
    toolCalls: draft.toolCalls,
  });
}
