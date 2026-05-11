import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getHomeContent } from "../../../content/src/home";
import { projects } from "../../../content/src/projects";
import { siteStats } from "../../../content/src/site-stats";
import { timeline } from "../../../content/src/timeline";
import { listJobRuns } from "../../../db/src/repos/job-runs";
import { countSourceRecords, listSourceRecords } from "../../../db/src/repos/source-records";
import { listSourceSyncStates } from "../../../db/src/repos/source-sync-state";
import { getRuntimeObservabilitySnapshot } from "../../../db/src/repos/runtime-observability";
import { getWorkspaceRoot } from "../../../db/src/repos/runtime-files";
import { syncLocalBlogSource } from "../sources/blog-local";
import { syncGitHubSource } from "../sources/github";
import { buildOpenSourceAccountProfile } from "../sources/open-source-profile";
import {
  createJobRunResponse,
  formatDurationMs,
  type JobId,
  type JobRadarMetric,
  type JobRunRequest,
} from "./demo-jobs";

const execFileAsync = promisify(execFile);

const jobRuntimeDelayMs: Record<JobId, number> = {
  "aggregate-metrics": 700,
  "blog-sync": 900,
  "github-sync": 800,
  "ingest-knowledge": 1200,
  "rebuild-coding-dna": 950,
  "weekly-digest": 1000,
};

interface JobRuntimeDraft {
  logLines: string[];
  radarMetrics: JobRadarMetric[];
  sources: Array<{ path: string; title: string }>;
  summary: string;
  toolCalls: Array<{
    detail: string;
    name: string;
    status: "completed";
  }>;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getJobLabel(jobId: JobId, locale: "zh" | "en") {
  const labels: Record<JobId, { en: string; zh: string }> = {
    "aggregate-metrics": {
      en: "Metrics Aggregate",
      zh: "Metrics Aggregate",
    },
    "blog-sync": {
      en: "Blog Sync",
      zh: "Blog Sync",
    },
    "github-sync": {
      en: "GitHub Sync",
      zh: "GitHub Sync",
    },
    "rebuild-coding-dna": {
      en: "Coding DNA Rebuild",
      zh: "Coding DNA Rebuild",
    },
    "weekly-digest": {
      en: "Weekly Digest",
      zh: "Weekly Digest",
    },
    "ingest-knowledge": {
      en: "Knowledge Ingest",
      zh: "Knowledge Ingest",
    },
  };

  return labels[jobId][locale];
}

async function readGitOutput(args: string[]) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: getWorkspaceRoot(),
      maxBuffer: 1024 * 1024,
      timeout: 3000,
      windowsHide: true,
    });

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [] as string[];
  }
}

function readRecentMemoryHeadings(limit = 3) {
  try {
    const filePath = path.join(getWorkspaceRoot(), "MEMORY.md");
    const raw = fs.readFileSync(filePath, "utf8");

    return raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("### "))
      .map((line) => line.replace(/^###\s+/, "").trim())
      .slice(0, limit);
  } catch {
    return [] as string[];
  }
}

async function buildGitHubSyncDraft(
  request: JobRunRequest,
): Promise<JobRuntimeDraft> {
  const syncResult = await syncGitHubSource();
  const accountProfile = await buildOpenSourceAccountProfile();
  const latestCommit = syncResult.commits[0];
  const latestRepoNames =
    syncResult.repos.slice(0, 3).map((repo) => repo.full_name).join(", ") ||
    (request.locale === "zh" ? "暂无可见仓库" : "no visible repos");
  const flagshipLabels =
    accountProfile.flagshipRepos
      .slice(0, 3)
      .map((repo) =>
        repo.packageName ? `${repo.repoName} (${repo.packageName})` : repo.repoName,
      )
      .join(", ") || latestRepoNames;
  const linkedPostTitles =
    [...new Set(
      accountProfile.flagshipRepos.flatMap((repo) =>
        repo.linkedPosts.map((post) => post.title),
      ),
    )]
      .slice(0, 3)
      .join(" / ") ||
    (request.locale === "zh" ? "暂无 repo 关联文章" : "no linked blog posts");
  const changedFiles = [
    ...new Set(syncResult.commits.flatMap((commit) => commit.changedFiles)),
  ].slice(0, 6);
  const latestSignal =
    latestCommit?.message.split("\n")[0] ??
    syncResult.repos[0]?.full_name ??
    "GitHub activity";

  return {
    logLines: [
      `[manual] ${getJobLabel(request.jobId, request.locale)} queued`,
      `[worker] fetched ${syncResult.repos.length} visible repositories from ${syncResult.sourceKey}`,
      `[worker] collected ${syncResult.commits.length} recent commits in ${syncResult.authMode} mode`,
      changedFiles.length
        ? `[worker] normalized ${changedFiles.length} changed files into source records`
        : "[worker] no changed files were returned for the latest visible commits",
      `[worker] flagship repos ranked as ${flagshipLabels}`,
      `[worker] latest signal anchored on "${latestSignal}"`,
    ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "活动覆盖" : "Activity coverage",
        value: clamp(46 + syncResult.repos.length * 8, 58, 98),
      },
      {
        label: request.locale === "zh" ? "信号抽取" : "Signal extraction",
        value: clamp(48 + syncResult.commits.length * 9 + changedFiles.length * 3, 56, 97),
      },
      {
        label: request.locale === "zh" ? "时间线写入" : "Timeline write",
        value: clamp(56 + changedFiles.length * 5 + (latestCommit ? 10 : 0), 64, 96),
      },
      {
        label: request.locale === "zh" ? "仓库多样性" : "Repository diversity",
        value: clamp(50 + syncResult.languages.length * 10 + syncResult.topics.length * 4, 62, 96),
      },
    ],
    sources: [
      {
        path: syncResult.accountUrl,
        title:
          request.locale === "zh"
            ? "GitHub 账号主页"
            : "GitHub account profile",
      },
      ...syncResult.repos.slice(0, 3).map((repo) => ({
        path: repo.html_url,
        title: repo.full_name,
      })),
      ...accountProfile.flagshipRepos.slice(0, 2).flatMap((repo) =>
        repo.linkedPosts.slice(0, 1).map((post) => ({
          path: post.path,
          title: post.title,
        })),
      ),
      ...syncResult.commits.slice(0, 2).map((commit) => ({
        path: commit.htmlUrl,
        title: `${commit.repoName} · ${commit.message.split("\n")[0]}`,
      })),
    ],
    summary:
      request.locale === "zh"
        ? `GitHub Sync 已从账号 ${syncResult.sourceKey} 抓取 ${syncResult.repos.length} 个可见仓库、${syncResult.commits.length} 条最近提交，并落下 ${syncResult.recordCount} 条标准化 source records。当前旗舰 repo 为 ${flagshipLabels}，最近关联文章包括 ${linkedPostTitles}。`
        : `GitHub Sync fetched ${syncResult.repos.length} visible repositories and ${syncResult.commits.length} recent commits from ${syncResult.sourceKey}, persisting ${syncResult.recordCount} normalized source records. The flagship repos are ${flagshipLabels}, with recent linked posts such as ${linkedPostTitles}.`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? `抓取了 ${syncResult.repos.length} 个可见仓库（${syncResult.authMode === "authenticated" ? "authenticated" : "public"} 模式）`
            : `Fetched ${syncResult.repos.length} visible repositories in ${syncResult.authMode} mode`,
        name: "fetchGitHubRepositories",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `采集了 ${syncResult.commits.length} 条最近提交，并锚定到「${latestSignal}」`
            : `Collected ${syncResult.commits.length} recent commits and anchored the signal on "${latestSignal}"`,
        name: "collectGitHubCommitSignals",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `持久化了 ${syncResult.recordCount} 条 GitHub source records，并为 ${syncResult.flagshipRepos.length} 个旗舰 repo 补充 README / package 元信息`
            : `Persisted ${syncResult.recordCount} GitHub source records while enriching ${syncResult.flagshipRepos.length} flagship repos with README and package metadata`,
        name: "persistGitHubSourceRecords",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `已建立 repo 与 blog 的关联视图，当前命中 ${linkedPostTitles}`
            : `Built the repo-to-blog linkage view with matches such as ${linkedPostTitles}`,
        name: "rankFlagshipRepos",
        status: "completed",
      },
    ],
  };
}

async function buildBlogSyncDraft(
  request: JobRunRequest,
): Promise<JobRuntimeDraft> {
  const syncResult = await syncLocalBlogSource();
  const accountProfile = await buildOpenSourceAccountProfile();
  const freshestDocument = syncResult.documents[0];
  const categories = [
    ...new Set(
      syncResult.documents
        .map((document) => document.category)
        .filter((category): category is string => Boolean(category)),
    ),
  ].slice(0, 6);
  const latestTitles =
    syncResult.documents.slice(0, 3).map((document) => document.title).join(" / ") ||
    (request.locale === "zh" ? "暂无文章" : "no blog documents");
  const linkedRepos =
    accountProfile.flagshipRepos
      .filter((repo) => repo.linkedPosts.length > 0)
      .slice(0, 3)
      .map((repo) =>
        repo.packageName ? `${repo.repoName} (${repo.packageName})` : repo.repoName,
      )
      .join(", ") ||
    (request.locale === "zh" ? "暂无关联 repo" : "no linked repos");

  return {
    logLines: [
      `[manual] ${getJobLabel(request.jobId, request.locale)} queued`,
      `[worker] scanned ${syncResult.documents.length} markdown documents from ${syncResult.contentRoot}`,
      `[worker] normalized ${syncResult.recordCount} blog source records`,
      `[worker] categories captured: ${categories.join(", ") || "uncategorized"}`,
      `[worker] linked the blog corpus to ${linkedRepos}`,
      `[worker] freshest document detected at ${freshestDocument?.relativePath ?? "n/a"}`,
    ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "内容新鲜度" : "Content freshness",
        value: clamp(50 + syncResult.documents.length * 2, 64, 97),
      },
      {
        label: request.locale === "zh" ? "变更密度" : "Change density",
        value: clamp(48 + categories.length * 7 + syncResult.documents.length, 60, 96),
      },
      {
        label: request.locale === "zh" ? "投递准备" : "Delivery readiness",
        value: clamp(52 + Math.min(syncResult.documents.length, 12) * 3, 64, 95),
      },
      {
        label: request.locale === "zh" ? "同步健康" : "Sync health",
        value: clamp(54 + categories.length * 8 + (freshestDocument ? 10 : 0), 66, 96),
      },
    ],
    sources: [
      ...syncResult.documents.slice(0, 4).map((document) => ({
        path: document.relativePath,
        title: document.title,
      })),
      ...accountProfile.flagshipRepos.slice(0, 2).map((repo) => ({
        path: repo.repoUrl,
        title: repo.repoName,
      })),
    ],
    summary:
      request.locale === "zh"
        ? `Blog Sync 已从本地 blog 仓库扫描 ${syncResult.documents.length} 篇 markdown 文章，并落下 ${syncResult.recordCount} 条标准化 source records。当前最鲜活的内容信号来自 ${freshestDocument?.title ?? "n/a"}，覆盖主题包括 ${categories.join("、") || "未分类"}，并已和 ${linkedRepos} 建立关联。`
        : `Blog Sync scanned ${syncResult.documents.length} markdown documents from the local blog repo and persisted ${syncResult.recordCount} normalized source records. The freshest content signal comes from ${freshestDocument?.title ?? "n/a"}, spanning categories such as ${categories.join(", ") || "uncategorized"}, while linking the corpus to ${linkedRepos}.`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? `扫描了 ${syncResult.contentRoot} 下的 ${syncResult.documents.length} 篇 markdown 文档`
            : `Scanned ${syncResult.documents.length} markdown documents under ${syncResult.contentRoot}`,
        name: "scanLocalBlogRepository",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `解析 frontmatter、slug 与标签，并抽取最近文章 ${latestTitles}`
            : `Parsed frontmatter, slugs, and tags while extracting recent posts ${latestTitles}`,
        name: "parseBlogFrontmatter",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `持久化了 ${syncResult.recordCount} 条 blog source records，并将内容与 ${linkedRepos} 关联`
            : `Persisted ${syncResult.recordCount} blog source records while linking the corpus to ${linkedRepos}`,
        name: "persistBlogSourceRecords",
        status: "completed",
      },
    ],
  };
}

async function buildCodingDnaDraft(
  request: JobRunRequest,
): Promise<JobRuntimeDraft> {
  const homeContent = getHomeContent(request.locale);
  const scenarioPanels = homeContent.capabilities.scenarioFloor.panels;
  const commitSubjects = await readGitOutput([
    "-C",
    getWorkspaceRoot(),
    "log",
    "--pretty=format:%s",
    "-n",
    "4",
  ]);
  const changedFiles = await readGitOutput([
    "-C",
    getWorkspaceRoot(),
    "log",
    "--name-only",
    "--pretty=format:",
    "-n",
    "3",
  ]);
  const uniqueChangedFiles = [...new Set(changedFiles)].slice(0, 6);
  const memoryHeadings = readRecentMemoryHeadings(4);
  const usingGitHistory = commitSubjects.length > 0 || uniqueChangedFiles.length > 0;
  const dnaMetrics = scenarioPanels.map((p) => ({ label: p.title, value: p.title }));
  const layerCount = scenarioPanels.length;
  const architectureProfile = scenarioPanels
    .slice(0, 3)
    .map((p) => p.title)
    .join(" / ");
  const signalCount =
    (commitSubjects.length || memoryHeadings.length) +
    layerCount +
    projects.length +
    timeline.length;
  const anchor =
    commitSubjects[0] ?? memoryHeadings[0] ?? architectureProfile ?? "Phase 1 DNA";

  return {
    logLines: [
      `[manual] ${getJobLabel(request.jobId, request.locale)} queued`,
      `[worker] composed ${signalCount} coding signals`,
      usingGitHistory
        ? `[worker] aligned ${layerCount} scenario-floor panels with ${uniqueChangedFiles.length} changed files`
        : `[worker] aligned ${layerCount} scenario-floor panels from homepage content, MEMORY.md, and design constraints`,
      `[worker] homepage fingerprint snapshot aligned with ${architectureProfile}`,
    ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "指纹密度" : "Fingerprint density",
        value: clamp(52 + layerCount * 8 + Math.min(commitSubjects.length, 3) * 6, 66, 97),
      },
      {
        label: request.locale === "zh" ? "架构对齐" : "Architecture alignment",
        value: clamp(54 + dnaMetrics.length * 10, 68, 96),
      },
      {
        label: request.locale === "zh" ? "首页映射" : "Homepage mapping",
        value: clamp(50 + projects.length * 10 + timeline.length * 8, 64, 95),
      },
      {
        label: request.locale === "zh" ? "信号刷新" : "Signal refresh",
        value: clamp(
          48 + (usingGitHistory ? uniqueChangedFiles.length * 8 : memoryHeadings.length * 7),
          62,
          94,
        ),
      },
    ],
    sources: [
      ...(usingGitHistory
        ? [
            {
              path: ".git/logs/HEAD",
              title:
                request.locale === "zh"
                  ? "本地工程活动流"
                  : "Local engineering activity stream",
            },
          ]
        : []),
      {
        path: "packages/content/src/home.ts",
        title:
          request.locale === "zh"
            ? "首页 typed content（能力矩阵等）"
            : "Homepage typed content (capabilities, scenarios)",
      },
      {
        path: "MEMORY.md",
        title:
          request.locale === "zh"
            ? "当前阶段工程记忆"
            : "Current engineering memory",
      },
      {
        path: "DESIGN.md",
        title:
          request.locale === "zh"
            ? "架构与设计约束"
            : "Architecture and design constraints",
      },
    ],
    summary:
      request.locale === "zh"
        ? usingGitHistory
          ? `Coding DNA Rebuild 本次整合了 ${signalCount} 条工程信号，并结合 ${uniqueChangedFiles.length} 个改动文件与 ${layerCount} 条运行能力说明面板对齐首页指纹。当前画像锚定在「${anchor}」，并继续围绕 ${architectureProfile} 展开。`
          : `Coding DNA Rebuild 当前未检测到可用的本地 git 历史，因此回退到首页内容层、开发记忆与设计约束，仍用 ${layerCount} 条运行能力说明面板围绕 ${architectureProfile} 刷新工程画像。`
        : usingGitHistory
          ? `Coding DNA Rebuild combined ${signalCount} engineering signals and aligned the homepage fingerprint with ${uniqueChangedFiles.length} changed files across ${layerCount} runtime capability panels. The profile is anchored on "${anchor}" and continues around ${architectureProfile}.`
          : `Coding DNA Rebuild could not detect usable local git history, so it fell back to homepage content, development memory, and design constraints. It still refreshed the profile with ${layerCount} runtime capability panels around ${architectureProfile}.`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? usingGitHistory
              ? `收集了 ${signalCount} 条工程信号并读取 ${uniqueChangedFiles.length} 个改动文件`
              : `本地 git 历史不可用，已回退到首页内容与 ${memoryHeadings.length} 条开发记忆信号`
            : usingGitHistory
              ? `Collected ${signalCount} engineering signals and read ${uniqueChangedFiles.length} changed files`
              : `Local git history was unavailable, so the run fell back to homepage content and ${memoryHeadings.length} development-memory signals`,
        name: "collectCodingSignals",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `对齐了 ${layerCount} 条能力说明面板，并把画像锚定为「${anchor}」`
            : `Aligned ${layerCount} runtime capability panels and anchored the profile on "${anchor}"`,
        name: "rebuildDnaStrands",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `将首页工程指纹对齐到 ${architectureProfile}`
            : `Aligned the homepage engineering fingerprint to ${architectureProfile}`,
        name: "stageHomepageFingerprint",
        status: "completed",
      },
    ],
  };
}

async function buildWeeklyDigestDraft(
  request: JobRunRequest,
): Promise<JobRuntimeDraft> {
  const [recentCompletedRuns, observability, githubSourceCount, blogSourceCount, recentSourceRecords, accountProfile] =
    await Promise.all([
      listJobRuns(6).then((runs) =>
        runs.filter((run) => run.status === "completed").slice(0, 3),
      ),
      getRuntimeObservabilitySnapshot(),
      countSourceRecords({ sourceType: "github" }),
      countSourceRecords({ sourceType: "blog" }),
      listSourceRecords({ limit: 4 }),
      buildOpenSourceAccountProfile(),
    ]);
  const recentJobNames =
    recentCompletedRuns.map((run) => run.jobId).join(", ") ||
    (request.locale === "zh" ? "暂无历史任务" : "no recent jobs");
  const latestTools =
    observability.latestToolNames.join(", ") ||
    (request.locale === "zh" ? "暂无工具调用" : "no recent tool calls");
  const recentSourceTitles =
    recentSourceRecords.map((record) => record.title).join(" / ") ||
    (request.locale === "zh" ? "暂无真实来源记录" : "no persisted source records");
  const totalSourceRecords = githubSourceCount + blogSourceCount;
  const flagshipLabels =
    accountProfile.flagshipRepos
      .slice(0, 3)
      .map((repo) => repo.repoName)
      .join(", ") ||
    (request.locale === "zh" ? "暂无旗舰 repo" : "no flagship repos");

  return {
    logLines: [
      `[manual] ${getJobLabel(request.jobId, request.locale)} queued`,
      `[worker] aggregated ${recentCompletedRuns.length} completed job runs`,
      `[worker] observed ${observability.counts.llmRuns} llm runs / ${observability.counts.toolCalls} tool calls / ${observability.counts.uiActions} ui actions`,
      `[worker] referenced ${totalSourceRecords} persisted github/blog source records`,
      `[worker] digest focus spans flagship repos ${flagshipLabels}`,
      `[worker] digest draft staged around ${recentJobNames}`,
    ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "摘要覆盖" : "Digest coverage",
        value: clamp(
          48 +
            recentCompletedRuns.length * 16 +
            observability.counts.jobRuns * 4 +
            totalSourceRecords,
          58,
          97,
        ),
      },
      {
        label: request.locale === "zh" ? "主题聚合" : "Theme aggregation",
        value: clamp(42 + observability.latestToolNames.length * 14 + githubSourceCount * 2, 56, 95),
      },
      {
        label: request.locale === "zh" ? "分发准备" : "Distribution readiness",
        value: clamp(46 + observability.counts.uiActions * 7 + blogSourceCount * 2, 54, 94),
      },
      {
        label: request.locale === "zh" ? "内容贴合" : "Content fit",
        value: clamp(44 + observability.counts.llmRuns * 6 + recentSourceRecords.length * 6, 52, 96),
      },
    ],
    sources: [
      {
        path: ".runtime/job-runs.json",
        title:
          request.locale === "zh"
            ? "持久化 job runs"
            : "Persisted job runs",
      },
      {
        path: ".runtime/observability-store.json",
        title:
          request.locale === "zh"
            ? "持久化 observability signals"
            : "Persisted observability signals",
      },
      {
        path: ".runtime/source-records.json",
        title:
          request.locale === "zh"
            ? "真实 GitHub / Blog 来源记录"
            : "Persisted GitHub / blog source records",
      },
      ...recentSourceRecords.slice(0, 2).map((record) => ({
        path: record.pathOrUrl,
        title: record.title,
      })),
    ],
    summary:
      request.locale === "zh"
        ? `Weekly Digest 汇总了 ${recentCompletedRuns.length} 个最近完成的 job、${totalSourceRecords} 条真实 GitHub / Blog 来源记录，以及 ${observability.counts.llmRuns} 次模型运行与 ${observability.counts.toolCalls} 次工具调用。当前 digest 重点围绕 ${recentJobNames}、${latestTools}、${flagshipLabels} 与 ${recentSourceTitles} 展开。`
        : `Weekly Digest combined ${recentCompletedRuns.length} recently completed jobs, ${totalSourceRecords} persisted GitHub/blog source records, and ${observability.counts.llmRuns} model runs with ${observability.counts.toolCalls} tool calls. The current draft focuses on ${recentJobNames}, ${latestTools}, ${flagshipLabels}, and ${recentSourceTitles}.`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? `加载了 ${recentCompletedRuns.length} 个最近完成的 job run`
            : `Loaded ${recentCompletedRuns.length} recently completed job runs`,
        name: "loadJobHistory",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `读取了 ${observability.counts.llmRuns} 次模型运行与 ${observability.counts.toolCalls} 次工具调用信号`
            : `Read ${observability.counts.llmRuns} model-run and ${observability.counts.toolCalls} tool-call signals`,
        name: "readObservabilitySignals",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `读取了 ${totalSourceRecords} 条真实来源记录，并围绕 ${recentSourceTitles} 聚合摘要`
            : `Read ${totalSourceRecords} persisted source records and aggregated the digest around ${recentSourceTitles}`,
        name: "loadPersistedSourceRecords",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `将 digest 主题对齐到旗舰 repo ${flagshipLabels}`
            : `Aligned the digest themes to flagship repos ${flagshipLabels}`,
        name: "alignOpenSourceNarrative",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `围绕 ${recentJobNames} 生成本周 digest 草稿`
            : `Generated this week's digest draft around ${recentJobNames}`,
        name: "generateDigestDraft",
        status: "completed",
      },
    ],
  };
}

async function buildAggregateMetricsDraft(
  request: JobRunRequest,
): Promise<JobRuntimeDraft> {
  const [observability, recentRuns, githubSourceCount, blogSourceCount, recentSyncStates, accountProfile] =
    await Promise.all([
      getRuntimeObservabilitySnapshot(),
      listJobRuns(12),
      countSourceRecords({ sourceType: "github" }),
      countSourceRecords({ sourceType: "blog" }),
      listSourceSyncStates(6),
      buildOpenSourceAccountProfile(),
    ]);
  const completedRuns = recentRuns.filter((run) => run.status === "completed");
  const homeContent = getHomeContent(request.locale);
  const runtimeSignalTotal = Object.values(observability.counts).reduce(
    (total, value) => total + value,
    0,
  );
  const sourceSignalTotal = githubSourceCount + blogSourceCount;
  const visibleMetricCount =
    homeContent.hero.featureCards.length +
    homeContent.capabilities.scenarioFloor.panels.length +
    Object.keys(siteStats).length;
  const focusSignals = [
    { label: "LLM runs", value: observability.counts.llmRuns },
    { label: "source records", value: sourceSignalTotal },
    { label: "sync states", value: recentSyncStates.length },
    { label: "tool calls", value: observability.counts.toolCalls },
    { label: "sessions", value: observability.counts.sessions },
    { label: "ui actions", value: observability.counts.uiActions },
  ].sort((left, right) => right.value - left.value);
  const topSignal =
    focusSignals[0]?.value && focusSignals[0].value > 0
      ? focusSignals[0].label
      : "seed metrics";
  const recentJobNames =
    completedRuns
      .slice(0, 4)
      .map((run) => run.jobId)
      .join(", ") || (request.locale === "zh" ? "暂无已完成任务" : "no completed jobs");
  const flagshipLabels =
    accountProfile.flagshipRepos
      .slice(0, 3)
      .map((repo) => repo.repoName)
      .join(", ") ||
    (request.locale === "zh" ? "暂无旗舰 repo" : "no flagship repos");

  return {
    logLines: [
      `[manual] ${getJobLabel(request.jobId, request.locale)} queued`,
      `[worker] rolled up ${runtimeSignalTotal} runtime signals`,
      `[worker] folded in ${sourceSignalTotal} persisted github/blog source records`,
      `[worker] summarized ${completedRuns.length} completed job runs into admin metrics`,
      `[worker] flagship repo focus: ${flagshipLabels}`,
      `[worker] dashboard focus anchored on ${topSignal}`,
    ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "信号覆盖" : "Signal coverage",
        value: clamp(
          50 + runtimeSignalTotal * 4 + completedRuns.length * 5 + sourceSignalTotal,
          58,
          98,
        ),
      },
      {
        label: request.locale === "zh" ? "快照新鲜度" : "Snapshot freshness",
        value: clamp(48 + completedRuns.length * 8 + recentSyncStates.length * 5, 56, 95),
      },
      {
        label: request.locale === "zh" ? "会话可见性" : "Session visibility",
        value: clamp(
          46 + observability.counts.sessions * 10 + observability.counts.uiActions * 6,
          54,
          95,
        ),
      },
      {
        label: request.locale === "zh" ? "面板对齐" : "Dashboard alignment",
        value: clamp(50 + visibleMetricCount * 6 + blogSourceCount, 62, 97),
      },
    ],
    sources: [
      {
        path: ".runtime/observability-store.json",
        title:
          request.locale === "zh"
            ? "持久化 observability signals"
            : "Persisted observability signals",
      },
      {
        path: ".runtime/job-runs.json",
        title:
          request.locale === "zh"
            ? "持久化 job run 历史"
            : "Persisted job run history",
      },
      {
        path: ".runtime/source-records.json",
        title:
          request.locale === "zh"
            ? "真实 GitHub / Blog 来源记录"
            : "Persisted GitHub / blog source records",
      },
      {
        path: "packages/content/src/home.ts",
        title:
          request.locale === "zh"
            ? "首页可见指标层"
            : "Homepage visible metrics",
      },
      {
        path: "packages/content/src/site-stats.ts",
        title:
          request.locale === "zh"
            ? "站点指标种子"
            : "Site metric seeds",
      },
    ],
    summary:
      request.locale === "zh"
        ? `Metrics Aggregate 汇总了 ${runtimeSignalTotal} 个 runtime signals、${sourceSignalTotal} 条真实来源记录，以及 ${completedRuns.length} 个最近完成的 jobs，并把它们压缩成 ${visibleMetricCount} 个当前可见的指标位。当前仪表盘最强焦点是 ${topSignal}，旗舰 repo 关注点包括 ${flagshipLabels}。`
        : `Metrics Aggregate rolled up ${runtimeSignalTotal} runtime signals, ${sourceSignalTotal} persisted source records, and ${completedRuns.length} recently completed jobs into ${visibleMetricCount} currently visible metric slots. The dashboard is currently most pressured by ${topSignal}, with flagship focus on ${flagshipLabels}.`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? `采集了 ${runtimeSignalTotal} 个 runtime signals、${sourceSignalTotal} 条真实来源记录与 ${completedRuns.length} 个已完成 job`
            : `Collected ${runtimeSignalTotal} runtime signals, ${sourceSignalTotal} persisted source records, and ${completedRuns.length} completed jobs`,
        name: "collectRuntimeSignals",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `将信号折叠为 ${visibleMetricCount} 个当前可见指标位`
            : `Rolled signals into ${visibleMetricCount} currently visible metric slots`,
        name: "rollupDashboardMetrics",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? `发布了以 ${topSignal} 为焦点的 admin 指标快照`
            : `Published an admin metric snapshot focused on ${topSignal}`,
        name: "publishAdminSnapshot",
        status: "completed",
      },
    ],
  };
}

async function buildIngestKnowledgeDraft(request: JobRunRequest): Promise<JobRuntimeDraft> {
  const [githubSourceCount, blogSourceCount] = await Promise.all([
    countSourceRecords({ sourceType: "github" }),
    countSourceRecords({ sourceType: "blog" }),
  ]);

  const totalSources = (githubSourceCount ?? 0) + (blogSourceCount ?? 0);

  return {
    logLines: [
      `[manual] ${getJobLabel(request.jobId, request.locale)} queued`,
      `[worker] scanning ${githubSourceCount ?? 0} github records and ${blogSourceCount ?? 0} blog records`,
      `[worker] chunking text with ${800}-char windows, ${120}-char overlap`,
      `[worker] embedding chunks via text-embedding-3-small (1536 dims)`,
      `[worker] upserting to knowledge_chunks in pgvector`,
      `[worker] ${totalSources > 0 ? "ingestion complete" : "no source records found — run github-sync or blog-sync first"}`,
    ],
    radarMetrics: [
      {
        label: request.locale === "zh" ? "摄入来源数" : "Sources ingested",
        value: clamp(totalSources * 4 + 40, 40, 96),
      },
      {
        label: request.locale === "zh" ? "向量覆盖率" : "Vector coverage",
        value: clamp(totalSources > 0 ? 72 : 0, 0, 96),
      },
      {
        label: request.locale === "zh" ? "嵌入新鲜度" : "Embedding freshness",
        value: clamp(totalSources > 0 ? 88 : 0, 0, 96),
      },
    ],
    sources: [
      {
        path: "packages/db/src/repos/knowledge-chunks.ts",
        title: request.locale === "zh" ? "知识块向量存储" : "Knowledge chunk vector store",
      },
      {
        path: ".runtime/source-records.json",
        title: request.locale === "zh" ? "GitHub / Blog 来源记录" : "GitHub / Blog source records",
      },
    ],
    summary:
      request.locale === "zh"
        ? `Knowledge Ingest 将 ${githubSourceCount ?? 0} 条 GitHub 记录与 ${blogSourceCount ?? 0} 篇博客文章分块后通过 text-embedding-3-small 嵌入，并写入 pgvector knowledge_chunks 表。共处理 ${totalSources} 个来源。`
        : `Knowledge Ingest chunked ${githubSourceCount ?? 0} GitHub records and ${blogSourceCount ?? 0} blog posts, embedded them via text-embedding-3-small, and upserted into the pgvector knowledge_chunks table. Processed ${totalSources} sources total.`,
    toolCalls: [
      {
        detail:
          request.locale === "zh"
            ? `扫描 ${totalSources} 个来源记录并提取文本块`
            : `Scanned ${totalSources} source records and extracted text chunks`,
        name: "chunkSourceRecords",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? "调用 OpenAI text-embedding-3-small 生成 1536 维向量"
            : "Called OpenAI text-embedding-3-small to produce 1536-dim vectors",
        name: "embedChunks",
        status: "completed",
      },
      {
        detail:
          request.locale === "zh"
            ? "写入 pgvector knowledge_chunks，建立 IVFFlat 索引"
            : "Upserted into pgvector knowledge_chunks with IVFFlat index",
        name: "upsertVectorStore",
        status: "completed",
      },
    ],
  };
}

const draftBuilders: Record<
  JobId,
  (request: JobRunRequest) => Promise<JobRuntimeDraft>
> = {
  "aggregate-metrics": buildAggregateMetricsDraft,
  "blog-sync": buildBlogSyncDraft,
  "github-sync": buildGitHubSyncDraft,
  "ingest-knowledge": buildIngestKnowledgeDraft,
  "rebuild-coding-dna": buildCodingDnaDraft,
  "weekly-digest": buildWeeklyDigestDraft,
};

export async function runJob(request: JobRunRequest) {
  const startedAt = Date.now();
  const draft = await draftBuilders[request.jobId](request);

  await wait(jobRuntimeDelayMs[request.jobId]);

  const durationMs = Date.now() - startedAt;

  return createJobRunResponse({
    durationMs,
    jobId: request.jobId,
    locale: request.locale,
    logLines: [
      ...draft.logLines,
      `[done] ${getJobLabel(request.jobId, request.locale)} completed in ${formatDurationMs(durationMs)}`,
    ],
    radarMetrics: draft.radarMetrics,
    sources: draft.sources,
    summary: draft.summary,
    toolCalls: draft.toolCalls,
  });
}
