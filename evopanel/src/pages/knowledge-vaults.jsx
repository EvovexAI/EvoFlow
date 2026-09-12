import { open } from "@tauri-apps/plugin-dialog";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createKnowledgeVault,
  deleteKnowledgeVault,
  getKnowledgeVaultReindexJob,
  getKnowledgeVaultStatus,
  listKnowledgeVaults,
  openKnowledgeNote,
  readKnowledgeNotes,
  reindexKnowledgeVault,
  saveKnowledgeNote,
  searchKnowledgeVault,
  testKnowledgeVault,
  updateKnowledgeVault,
  graphKnowledgeVault,
  fullGraphKnowledgeVault,
  installKnowledgeVault,
  listKnowledgeNotes,
} from "../services/knowledge-vault-api.js";
import { setKnowledgeVaultDetailShellMode } from "../router.js";
import { MarkdownDocumentView } from "../react/components/MarkdownDocumentView.js";
import {
  KnowledgeForceGraph,
  prepareForceGraphData,
} from "../react/components/KnowledgeForceGraph.jsx";
import { KnowledgeNavExplorer } from "../react/components/KnowledgeNavExplorer.jsx";
import { TauriWindowControls } from "../react/components/TauriWindowControls.js";
import { loadFavorites, loadHistory } from "../lib/knowledge-graph-explore.js";
import { KnowledgeSourceTabs } from "./knowledge-source-tabs.jsx";
import {
  LIST_PAGE_SIZE_OPTIONS,
  paginateItems,
  readStoredPageSize,
  writeStoredPageSize,
} from "../components/list-pager.js";
import "./knowledge-vaults.css";
import "./knowledge-vaults-redesign.css";
import "./knowledge-source-tabs.css";

const VAULTS_PAGE_SIZE_KEY = "evopanel_knowledge_vaults_page_size";

const KV_TAURI_DRAG = { "data-tauri-drag-region": "" };
const SEARCH_MODES = [
  { value: "title", label: "文件名" },
  { value: "fulltext", label: "全文" },
  { value: "semantic", label: "语义" },
  { value: "hybrid", label: "混合" },
];

const EMPTY_VAULT_FORM = {
  name: "",
  vaultPath: "",
  accessMode: "read_write",
  launchMode: "managed_stdio",
  defaultInboxPath: "00-Inbox",
  allowedReadPaths: ["*"],
  allowedWritePaths: ["*"],
  embeddingMode: "local",
  enabled: true,
};

function Icon({ name, size = 18 }) {
  const paths = {
    vault: (
      <>
        <path d="M12 2 4.5 6.2v11.6L12 22l7.5-4.2V6.2L12 2Z" />
        <path d="m4.5 6.2 7.5 4.3 7.5-4.3M12 10.5V22" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    folder: (
      <>
        <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" />
        <path d="M3 10h18" />
      </>
    ),
    edit: (
      <>
        <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" />
        <path d="m13.5 7 3.5 3.5" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    file: (
      <>
        <path d="M6 2h8l4 4v16H6V2Z" />
        <path d="M14 2v5h5M9 12h6M9 16h6" />
      </>
    ),
    link: (
      <>
        <path d="M10.5 13.5 13.5 10.5" />
        <path d="M7.5 16.5 5 19a4 4 0 0 1-5.7-5.7l3-3A4 4 0 0 1 8 10" transform="translate(3 -2)" />
        <path d="m16.5 7.5 2.5-2.5a4 4 0 1 1 5.7 5.7l-3 3A4 4 0 0 1 16 14" transform="translate(-3 2)" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21h-4v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1A1.6 1.6 0 0 0 4.8 15a1.6 1.6 0 0 0-1.5-1H3v-4h.3a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V3h4v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1h.3v4h-.3a1.6 1.6 0 0 0-1.5 1Z" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6 6 18" />,
    external: (
      <>
        <path d="M14 4h6v6M20 4l-9 9" />
        <path d="M20 13v7H4V4h7" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
      </>
    ),
    chevron: <path d="m8 10 4 4 4-4" />,
    "chevron-left": <path d="m14 6-6 6 6 6" />,
    "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="kv-icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {paths[name] || paths.file}
    </svg>
  );
}

/** 列表/详情统一文字状态标签（不依赖橙色圆点） */
function displayIndexBadge(indexState, vault) {
  const key = String(indexState?.key || "").toLowerCase();
  const detail = String(indexState?.detail || vault?.searchError || vault?.message || "");
  if (key === "indexing" || key === "warming") {
    return { label: key === "indexing" ? indexState.label || "同步中" : "同步中", tone: "warn", key: "syncing" };
  }
  if (key === "failed") return { label: "同步失败", tone: "error", key: "failed" };
  if (
    key === "unavailable" ||
    (!vault?.vaultPath && key !== "disabled") ||
    /不存在|失效|not found|enoent|no such file|path.*invalid/i.test(detail)
  ) {
    return { label: "目录失效", tone: "error", key: "path_invalid" };
  }
  if (key === "index_pending") return { label: "待索引", tone: "warn", key: "pending" };
  if (key === "index_ready" || key === "index_partial" || key === "ready") {
    return { label: "索引就绪", tone: "ok", key: "ready" };
  }
  if (key === "disabled") return { label: "已禁用", tone: "muted", key: "disabled" };
  return { label: "待索引", tone: "warn", key: "pending" };
}

function IndexStatusBadge({ indexState, vault }) {
  const badge = displayIndexBadge(indexState, vault);
  return (
    <span className={`kv-status-badge is-${badge.tone}`} data-testid="kv-status-badge" title={indexState?.detail || badge.label}>
      {badge.label}
    </span>
  );
}

function sourceTypeLabel(vault) {
  if (vault?.builtin) return "系统内置";
  const path = String(vault?.vaultPath || "").toLowerCase();
  if (/obsidian|\.obsidian/i.test(path) || vault?.launchMode === "managed_stdio") return "Obsidian";
  return "本地目录";
}

function formatSyncTime(value) {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(value);
  }
}

function humanizeStatus(status) {
  const map = {
    ready: "运行中",
    running: "运行中",
    stopped: "已停止",
    failed: "异常",
    unavailable: "不可用",
    indexing: "索引中",
    disabled: "已禁用",
    unknown: "未知",
    index_ready: "索引就绪",
    index_partial: "全文就绪",
    index_pending: "索引未就绪",
  };
  return map[status] || status || "未知";
}

/** Soft / informational notices that must not be shown as hard「检索异常」. */
function isSoftSearchNotice(error) {
  const text = String(error || "").trim();
  if (!text) return false;
  return /后台启动|启动中|仍可用|自动加速|warming|starting|initializ/i.test(text);
}

/** True when desktop runtime still needs npm install of OHS into ~/.evoflow/runtime/kb-mcp. */
function kbPackagesNeedInstall(status) {
  const rt = status?.runtimeStatus || status?.runtime_status || {};
  if (rt.privatePackagesReady === true || rt.private_packages_ready === true) return false;
  if (rt.privatePackagesReady === false || rt.private_packages_ready === false) return true;
  const msg = String(
    rt.privatePackagesMessage ||
      rt.private_packages_message ||
      status?.searchError ||
      status?.message ||
      "",
  );
  return /missing OHS|MCP 包未就绪|Knowledge Vault MCP 包未就绪/i.test(msg);
}

/** Derive a user-facing index readiness label from vault status payload. */
function deriveIndexState(status, vault, reindexJob = null) {
  const job = reindexJob || status?.reindexJob || status?.reindex_job || null;
  const jobState = String(job?.state || "").toLowerCase();
  const jobPhase = String(job?.phase || "").toLowerCase();
  const installing = jobPhase === "installing_packages";
  if (jobState === "queued" || jobState === "running") {
    const pct = Number(job?.percent);
    const processed = job?.processed;
    const total = job?.total;
    let label = "正在重建索引…";
    if (installing) {
      label =
        Number.isFinite(pct) && pct >= 0 ? `安装检索组件 ${pct}%` : "正在安装检索组件…";
    } else if (Number.isFinite(pct) && pct >= 0) {
      label = `重建中 ${pct}%`;
    } else if (processed != null && total != null) {
      label = `重建中 ${processed}/${total}`;
    }
    return {
      key: "indexing",
      label,
      tone: "warn",
      detail: String(job?.message || ""),
      noteCount: Number(status?.noteCount ?? status?.note_count ?? vault?.indexedNotes ?? 0),
      lastIndexedAt: status?.lastIndexedAt || status?.last_indexed_at || vault?.lastIndexedAt || null,
      semanticReady: !!(status?.semanticReady ?? status?.semantic_ready),
      indexInitialized: !!(status?.indexInitialized ?? status?.index_initialized),
      job,
    };
  }

  const data = status || vault || {};
  const searchReady = data.searchReady ?? data.search_ready;
  const searchError = data.searchError ?? data.search_error;
  const softNotice = isSoftSearchNotice(searchError);
  const indexInitialized = data.indexInitialized ?? data.index_initialized;
  const semanticReady = data.semanticReady ?? data.semantic_ready;
  const mcpWarming = data.mcpWarming ?? data.mcp_warming;
  const noteCount = Number(
    data.noteCount ?? data.note_count ?? data.indexedNotes ?? data.indexed_notes ?? 0
  );
  const lastIndexedAt = data.lastIndexedAt || data.last_indexed_at || null;
  const statusMessage = String(data.message || "").trim();

  if (jobState === "error") {
    return {
      key: "failed",
      label: "重建失败",
      tone: "error",
      detail: String(job?.error || job?.message || searchError || "重建索引失败"),
      noteCount,
      lastIndexedAt,
      semanticReady: !!semanticReady,
      indexInitialized: !!indexInitialized,
      job,
    };
  }

  if (data.enabled === false) {
    return { key: "disabled", label: "已禁用", tone: "muted", noteCount, lastIndexedAt, semanticReady: false, indexInitialized: false };
  }
  // Hard fault: real error only. Soft warmup copy used to land in searchError and
  // painted the whole page as「检索异常」right after restart.
  if (searchError && !softNotice && jobState !== "done" && searchReady !== true) {
    return {
      key: "failed",
      label: "检索异常",
      tone: "error",
      detail: String(searchError),
      noteCount,
      lastIndexedAt,
      semanticReady: !!semanticReady,
      indexInitialized: !!indexInitialized,
    };
  }
  // Prefer explicit mcpWarming; fall back to legacy message sniffing only when flag absent.
  const legacyWarming =
    mcpWarming == null && (softNotice || /启动中/.test(statusMessage));
  if (mcpWarming === true || legacyWarming) {
    return {
      key: "warming",
      label: "检索服务启动中",
      tone: "warn",
      detail: softNotice ? String(searchError) : statusMessage,
      noteCount,
      lastIndexedAt,
      semanticReady: !!semanticReady,
      indexInitialized: !!indexInitialized,
    };
  }
  if (searchReady === false) {
    return {
      key: "unavailable",
      label: "检索不可用",
      tone: "warn",
      noteCount,
      lastIndexedAt,
      semanticReady: false,
      indexInitialized: !!indexInitialized,
    };
  }
  if (indexInitialized === true && semanticReady === true) {
    return {
      key: "index_ready",
      label: "索引就绪（含语义）",
      tone: "ok",
      noteCount,
      lastIndexedAt,
      semanticReady: true,
      indexInitialized: true,
    };
  }
  if (indexInitialized === true) {
    return {
      key: "index_partial",
      label: "全文就绪（语义不可用）",
      tone: "warn",
      detail: /加速服务暂不可用|回退本地全文/.test(statusMessage) ? statusMessage : "",
      noteCount,
      lastIndexedAt,
      semanticReady: false,
      indexInitialized: true,
    };
  }
  if (indexInitialized === false) {
    return {
      key: "index_pending",
      label: noteCount > 0 ? "索引未就绪（需重建）" : "尚未建索引",
      tone: "warn",
      noteCount,
      lastIndexedAt,
      semanticReady: false,
      indexInitialized: false,
    };
  }
  if (searchReady === true) {
    return {
      key: "ready",
      label: "检索就绪",
      tone: "ok",
      noteCount,
      lastIndexedAt,
      semanticReady: !!semanticReady,
      indexInitialized: indexInitialized == null ? null : !!indexInitialized,
    };
  }
  return {
    key: "unknown",
    label: "索引状态未知",
    tone: "muted",
    noteCount,
    lastIndexedAt,
    semanticReady: !!semanticReady,
    indexInitialized: indexInitialized == null ? null : !!indexInitialized,
  };
}

function formatElapsed(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 60) return `${Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m}分${s}秒`;
}

function ReindexProgressBanner({ job, onDismiss }) {
  if (!job || job.state === "idle") return null;
  const running = job.state === "queued" || job.state === "running";
  const failed = job.state === "error";
  const done = job.state === "done";
  const phase = String(job.phase || "").toLowerCase();
  const isSetup = !!(job.runInstall || job.run_install);
  const installing = phase === "installing_packages" || (isSetup && (phase === "queued" || !phase));
  const pct = Number.isFinite(Number(job.percent)) ? Math.max(0, Math.min(100, Number(job.percent))) : null;
  const title = running
    ? installing
      ? "正在安装检索组件"
      : "正在重建索引"
    : failed
      ? isSetup
        ? "初始化失败"
        : "重建失败"
      : isSetup
        ? "初始化完成"
        : "重建完成";
  return (
    <div
      className={`kv-reindex-banner ${failed ? "is-error" : done ? "is-ok" : "is-running"}`}
      data-testid="kv-reindex-banner"
    >
      <div className="kv-reindex-banner__head">
        <strong>{title}</strong>
        <span className="kv-reindex-banner__meta">
          已用时 {formatElapsed(job.elapsedSec ?? job.elapsed_sec)}
          {job.engine
            ? ` · ${
                job.engine === "cli"
                  ? "本地引擎"
                  : job.engine === "setup"
                    ? "首次安装"
                    : "MCP"
              }`
            : ""}
        </span>
        {!running && onDismiss ? (
          <button type="button" className="kv-reindex-banner__dismiss" onClick={onDismiss}>
            关闭
          </button>
        ) : null}
      </div>
      <p className="kv-reindex-banner__msg">{job.message || (failed ? job.error : "") || "—"}</p>
      {running || pct != null ? (
        <div className="kv-reindex-banner__bar" aria-hidden="true">
          <div
            className="kv-reindex-banner__bar-fill"
            style={{ width: `${pct != null ? pct : running ? 8 : 100}%` }}
          />
        </div>
      ) : null}
      <div className="kv-reindex-banner__stats">
        {installing && running ? (
          <span>下载/安装中（不是 Obsidian 应用）…</span>
        ) : job.processed != null && job.total != null ? (
          <span>
            进度 {job.processed}/{job.total}
            {pct != null ? `（${pct}%）` : ""}
          </span>
        ) : pct != null ? (
          <span>进度 {pct}%</span>
        ) : (
          <span>{running ? "正在扫描/写入…" : "—"}</span>
        )}
        {job.indexed != null ? <span>写入 {job.indexed}</span> : null}
        {job.skipped != null ? <span>跳过 {job.skipped}</span> : null}
        {job.errorCount > 0 ? <span className="is-error">错误 {job.errorCount}</span> : null}
      </div>
      {done ? (
        <p className="kv-reindex-banner__hint">
          完成标准：状态变为「全文就绪」或「索引就绪（含语义）」。语义不可用时仍可全文搜索。
        </p>
      ) : null}
      {failed && job.error ? (
        <pre className="kv-reindex-banner__error">{String(job.error)}</pre>
      ) : null}
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function normalizeVault(raw) {
  const searchReady = raw.searchReady ?? raw.search_ready
  const statusFromReady =
    raw.enabled === false
      ? "disabled"
      : searchReady === true
        ? "ready"
        : searchReady === false
          ? "unavailable"
          : null
  const indexState = deriveIndexState(raw, raw)
  const indexedNotes = raw.indexedNotes ?? raw.indexed_notes ?? raw.noteCount ?? raw.note_count ?? 0
  const lastIndexedAt = raw.lastIndexedAt || raw.last_indexed_at || null
  const createdAt = raw.createdAt || raw.created_at || null
  // listSort* freeze list order across async status patches (see loadVaults / loadStatus).
  const listSortAt =
    raw.listSortAt || raw.list_sort_at || lastIndexedAt || createdAt || null
  const listSortDocs =
    raw.listSortDocs ?? raw.list_sort_docs ?? Number(indexedNotes || 0)
  return {
    ...raw,
    id: raw.id,
    name: raw.name || "未命名 Vault",
    vaultPath: raw.vaultPath || raw.vault_path || "",
    accessMode: raw.accessMode || raw.access_mode || "read_write",
    enabled: raw.enabled !== false,
    builtin: Boolean(raw.builtin),
    status: raw.status || raw.searchStatus || raw.search_status || statusFromReady || indexState.key || "unknown",
    indexedNotes,
    indexSize: raw.indexSize ?? raw.index_size ?? 0,
    embeddingDimension: raw.embeddingDimension ?? raw.embedding_dimension ?? null,
    lastIndexedAt,
    indexInitialized: raw.indexInitialized ?? raw.index_initialized ?? null,
    semanticReady: raw.semanticReady ?? raw.semantic_ready ?? null,
    searchReady: searchReady ?? null,
    searchError: raw.searchError ?? raw.search_error ?? null,
    mcpReady: raw.mcpReady ?? raw.mcp_ready ?? null,
    mcpWarming: raw.mcpWarming ?? raw.mcp_warming ?? null,
    message: raw.message || "",
    indexLabel: indexState.label,
    indexTone: indexState.tone,
    createdAt,
    listSortAt,
    listSortDocs,
  };
}

/** Merge live status into a vault row without thawing frozen list-sort keys. */
function applyVaultStatus(vault, st) {
  const listSortAt = vault.listSortAt || vault.lastIndexedAt || vault.createdAt || null
  const listSortDocs = vault.listSortDocs ?? Number(vault.indexedNotes || 0)
  return normalizeVault({
    ...vault,
    ...st,
    searchReady: st.searchReady ?? st.search_ready,
    indexInitialized: st.indexInitialized ?? st.index_initialized,
    semanticReady: st.semanticReady ?? st.semantic_ready,
    searchError: st.searchError ?? st.search_error,
    status:
      st.status ||
      st.searchStatus ||
      ((st.searchReady ?? st.search_ready) ? "ready" : vault.status),
    noteCount: st.noteCount ?? st.note_count ?? vault.indexedNotes,
    indexedNotes:
      st.indexedNotes ??
      st.indexed_notes ??
      st.noteCount ??
      st.note_count ??
      vault.indexedNotes,
    indexSize: st.indexSize ?? st.index_size ?? vault.indexSize,
    embeddingDimension:
      st.embeddingDimension ??
      st.embedding_dimension ??
      st.runtimeStatus?.embeddingDim ??
      vault.embeddingDimension,
    lastIndexedAt: st.lastIndexedAt || st.last_indexed_at || vault.lastIndexedAt,
    mcpReady: st.mcpReady ?? st.mcp_ready ?? vault.mcpReady,
    mcpWarming: st.mcpWarming ?? st.mcp_warming ?? vault.mcpWarming,
    message: st.message || vault.message || "",
    listSortAt,
    listSortDocs,
  })
}

function VaultCard({ vault, agentCount = 0, onOpen, onAction }) {
  const indexState = deriveIndexState(vault, vault);
  const ready = indexState.tone === "ok" || vault.status === "ready" || vault.status === "running";
  const [menuOpen, setMenuOpen] = useState(false);
  const noteCount = Number(indexState.noteCount || vault.indexedNotes || 0);
  const semantic = indexState.semanticReady ? "可用" : "不可用";

  return (
    <article
      className={`kv-tile ${!vault.enabled ? "is-disabled" : ""} ${ready ? "is-ready" : ""}`}
      data-testid={`kv-card-${vault.id}`}
      onClick={() => onOpen(vault)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(vault);
        }
      }}
    >
      <div className="kv-tile__icon">
        <Icon name="vault" size={22} />
      </div>
      <div className="kv-tile__info">
        <div className="kv-tile__title-row">
          <h3>{vault.name}</h3>
          {vault.builtin ? <span className="kv-doc-badge is-builtin" title="系统内置知识库">内置</span> : null}
          <IndexStatusBadge indexState={indexState} vault={vault} />
        </div>
        <p className="kv-tile__meta">
          <span>{sourceTypeLabel(vault)}</span>
          <span className="kv-tile__dot" aria-hidden="true" />
          <span>{noteCount.toLocaleString()} 篇文档</span>
        </p>
        <div className="kv-tile__stats">
          <span>向量 {vault.embeddingDimension ? `${vault.embeddingDimension}维` : "—"}</span>
          <span>同步 {formatSyncTime(indexState.lastIndexedAt || vault.lastIndexedAt)}</span>
          <span>智能体 {agentCount}</span>
          <span>语义 {semantic}</span>
        </div>
      </div>
      <div className="kv-tile__menu-wrap">
        <button
          className="kv-tile__more"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          type="button"
          title="更多操作"
        >
          <Icon name="more" size={16} />
        </button>
        {menuOpen && (
          <div className="kv-tile__menu" onClick={(event) => event.stopPropagation()}>
            <button onClick={() => { onAction("edit", vault); setMenuOpen(false); }} type="button">
              <Icon name="edit" size={15} />
              <span>编辑</span>
            </button>
            <button onClick={() => { onAction("sync", vault); setMenuOpen(false); }} type="button">
              <Icon name="refresh" size={15} />
              <span>同步</span>
            </button>
            <button onClick={() => { onAction("reindex", vault); setMenuOpen(false); }} type="button">
              <Icon name="refresh" size={15} />
              <span>重建索引</span>
            </button>
            <button onClick={() => { onAction("test", vault); setMenuOpen(false); }} type="button">
              <Icon name="settings" size={15} />
              <span>测试连接</span>
            </button>
            <div className="kv-tile__menu-divider" />
            {vault.builtin ? (
              <button type="button" disabled title="系统内置知识库不可删除，可在设置中停用">
                <Icon name="trash" size={15} />
                <span>内置不可删</span>
              </button>
            ) : (
              <button className="kv-tile__menu-danger" onClick={() => { onAction("delete", vault); setMenuOpen(false); }} type="button">
                <Icon name="trash" size={15} />
                <span>删除</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function buildVaultTree(items) {
  const root = { type: "folder", name: "", path: "", children: [] };
  const folderMap = new Map([["", root]]);

  for (const item of items || []) {
    const path = String(item.path || "").replace(/\\/g, "/");
    if (!path) continue;
    const segments = path.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue;

    let prefix = "";
    for (const seg of segments) {
      const parent = prefix;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (!folderMap.has(prefix)) {
        const folder = { type: "folder", name: seg, path: prefix, children: [] };
        folderMap.get(parent).children.push(folder);
        folderMap.set(prefix, folder);
      }
    }

    folderMap.get(prefix).children.push({
      type: "file",
      name: fileName,
      path,
      title: item.title || fileName.replace(/\.md$/i, ""),
    });
  }

  const sortChildren = (node) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    node.children.forEach((child) => {
      if (child.type === "folder") sortChildren(child);
    });
  };
  sortChildren(root);
  return root;
}

function treeTestId(kind, path) {
  const slug = String(path || "root")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `kv-tree-${kind}-${slug || "root"}`;
}

function VaultTreeNode({ node, depth, expanded, onToggle, selectedPath, onPickFile }) {
  if (node.type === "file") {
    const selected = selectedPath === node.path;
    return (
      <button
        className={`kv-tree-file ${selected ? "is-selected" : ""}`}
        data-testid={treeTestId("file", node.path)}
        onClick={() => onPickFile(node)}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        type="button"
      >
        <Icon name="file" size={15} />
        <span className="kv-tree-label">{node.title || node.name}</span>
      </button>
    );
  }

  const isOpen = expanded.has(node.path);
  const hasChildren = node.children?.length > 0;
  if (!hasChildren) return null;

  return (
    <div className="kv-tree-folder" data-testid={treeTestId("folder", node.path)}>
      <button
        className={`kv-tree-folder-head ${isOpen ? "is-open" : ""}`}
        onClick={() => onToggle(node.path)}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        type="button"
      >
        <Icon name="chevron" size={14} />
        <Icon name="folder" size={15} />
        <span className="kv-tree-label">{node.name || "根目录"}</span>
        <span className="kv-tree-count">{node.children.length}</span>
      </button>
      {isOpen ? (
        <div className="kv-tree-children">
          {node.children.map((child) => (
            <VaultTreeNode
              depth={depth + 1}
              expanded={expanded}
              key={`${child.type}-${child.path || child.name}`}
              node={child}
              onPickFile={onPickFile}
              onToggle={onToggle}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BrowsePanel({ notes, total, loading, selectedPath, onPickFile, onRefresh }) {
  const [fileQuery, setFileQuery] = useState("");
  const queryNorm = fileQuery.trim().toLowerCase();

  const filteredNotes = useMemo(() => {
    if (!queryNorm) return notes;
    return (notes || []).filter((note) => {
      const path = String(note.path || "").toLowerCase();
      const title = String(note.title || "").toLowerCase();
      const name = path.split("/").pop() || "";
      return path.includes(queryNorm) || title.includes(queryNorm) || name.includes(queryNorm);
    });
  }, [notes, queryNorm]);

  const tree = useMemo(() => buildVaultTree(filteredNotes), [filteredNotes]);
  const [expanded, setExpanded] = useState(() => new Set([""]));

  useEffect(() => {
    if (!queryNorm) return;
    const all = new Set([""]);
    const walk = (node) => {
      if (node.type === "folder" && node.path) all.add(node.path);
      node.children?.forEach(walk);
    };
    walk(tree);
    setExpanded(all);
  }, [queryNorm, tree]);

  useEffect(() => {
    if (queryNorm || !selectedPath) return;
    const parts = selectedPath.split("/");
    parts.pop();
    const next = new Set([""]);
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      next.add(prefix);
    }
    setExpanded(next);
  }, [selectedPath, queryNorm]);

  const toggleFolder = (path) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const matchCount = filteredNotes.length;
  const totalCount = total ?? notes.length;

  return (
    <div className="kv-browse-body" data-testid="kv-browse-panel">
      <div className="kv-browse-toolbar">
        <div className="kv-browse-filter">
          <Icon name="search" size={15} />
          <input
            data-testid="kv-browse-filter"
            onChange={(event) => setFileQuery(event.target.value)}
            placeholder="按文件名、标题过滤…"
            type="search"
            value={fileQuery}
          />
          {fileQuery ? (
            <button
              className="kv-browse-filter__clear"
              onClick={() => setFileQuery("")}
              title="清除"
              type="button"
            >
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </div>
        <button
          className="kv-browse-refresh"
          disabled={loading}
          onClick={onRefresh}
          title="刷新目录"
          type="button"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="kv-browse-meta">
        {loading
          ? "正在扫描目录…"
          : queryNorm
            ? `匹配 ${matchCount} / ${totalCount} 篇`
            : `共 ${totalCount} 篇`}
      </div>
      <div className="kv-browse-tree" data-testid="kv-browse-tree">
        {loading ? (
          <div className="kv-empty-inline">正在加载文件夹结构…</div>
        ) : tree.children.length ? (
          tree.children.map((node) => (
            <VaultTreeNode
              depth={0}
              expanded={expanded}
              key={`${node.type}-${node.path || node.name}`}
              node={node}
              onPickFile={onPickFile}
              onToggle={toggleFolder}
              selectedPath={selectedPath}
            />
          ))
        ) : (
          <div className="kv-empty-inline">
            {queryNorm ? "没有匹配的文件" : "此 Vault 下没有可浏览的 Markdown 文件"}
          </div>
        )}
      </div>
    </div>
  );
}

function GraphExplorer({
  vaultId,
  vaultPath = "",
  vaultName = "",
  onPickFile,
  onEditFile,
  large = false,
}) {
  const [prepared, setPrepared] = useState(null);
  const [rawGraph, setRawGraph] = useState({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const cancelledRef = useRef(false);

  const [focusPath, setFocusPath] = useState(null);
  const [enabledClusters, setEnabledClusters] = useState(null);
  const [degreeMin, setDegreeMin] = useState(0);
  const [edgeMode, setEdgeMode] = useState("balanced");
  const [nodeSizeScale, setNodeSizeScale] = useState(1);
  const [labelDensity, setLabelDensity] = useState(1);
  const [meta, setMeta] = useState({
    favorites: vaultId ? loadFavorites(vaultId) : [],
    history: vaultId ? loadHistory(vaultId) : [],
    pinnedIds: [],
  });

  const runLoad = async () => {
    if (!vaultId) return;
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    try {
      const result = await fullGraphKnowledgeVault(vaultId, { max_nodes: 500, max_edges: 2000 });
      if (cancelledRef.current) return;
      const nodes = result?.nodes || [];
      const edges = result?.edges || result?.links || [];
      setRawGraph({ nodes, edges });
      const next = prepareForceGraphData(nodes, edges, {
        edgeMode: "balanced",
        compact: false,
        hubCount: 5,
      });
      setPrepared(next);
      setEnabledClusters(new Set((next.clusters || []).map((c) => c.id)));
    } catch (err) {
      if (cancelledRef.current) return;
      setError(String(err?.message || err || "加载失败"));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    runLoad();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const nodeCount = prepared?.stats?.nodeCount || 0;

  if (loading) {
    return (
      <div className="kv-graph-explorer">
        <div className="kv-graph-explorer__empty">
          <div className="kv-link-hub__loading-dot" />
          <span>正在加载全量图谱…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`kv-graph-explorer${large ? " is-large" : ""}`}>
        <div className="kv-graph-explorer__empty">
          <p className="kv-empty-title">图谱加载失败</p>
          <p className="kv-empty-desc">{error}</p>
          <button className="kv-button is-ghost" onClick={runLoad} type="button">
            重试
          </button>
        </div>
      </div>
    );
  }

  if (nodeCount === 0) {
    return (
      <div className={`kv-graph-explorer${large ? " is-large" : ""}`}>
        <div className="kv-graph-explorer__empty">
          <p className="kv-empty-title">暂无图谱数据</p>
          <p className="kv-empty-desc">知识库中还没有双向链接，先给文档添加 [[wikilink]] 试试</p>
        </div>
      </div>
    );
  }

  const openDoc = (node) => {
    const path = node?.path || node?.id;
    if (onPickFile && path) onPickFile(path);
  };
  const editDoc = (node) => {
    if (onEditFile && node?.path) onEditFile(node.path);
    else openDoc(node);
  };

  const toggleCluster = (id) => {
    setEnabledClusters((prev) => {
      const base = prev || new Set((prepared?.clusters || []).map((c) => c.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const graphProps = {
    prepared,
    rawNodes: rawGraph.nodes,
    rawEdges: rawGraph.edges,
    vaultId,
    vaultPath,
    vaultName,
    focusPath,
    onFocusPathChange: setFocusPath,
    enabledClusters,
    degreeMin,
    edgeMode,
    onEdgeModeChange: setEdgeMode,
    nodeSizeScale,
    onNodeSizeChange: setNodeSizeScale,
    labelDensity,
    onLabelDensityChange: setLabelDensity,
    onMetaChange: setMeta,
    onOpenDocument: openDoc,
    onEditDocument: editDoc,
    onNodeClick: (node, metaArg) => {
      if (metaArg?.open) openDoc(node);
    },
    showToolbar: large,
    showLegend: large,
    showDetailPanel: large,
    shellMode: large,
  };

  if (!large) {
    return (
      <div className="kv-graph-explorer">
        <div className="kv-graph-explorer__stats">
          <span><strong>{nodeCount}</strong> 个节点</span>
          <span><strong>{prepared?.stats?.edgeCount || 0}</strong> 条连接</span>
          <button
            className="kv-graph-explorer__expand"
            onClick={() => setExpanded(true)}
            title="全屏查看图谱"
            type="button"
          >
            <Icon name="eye" size={14} />
            大图
          </button>
        </div>
        <div className="kv-graph-explorer__canvas">
          <KnowledgeForceGraph {...graphProps} mode="compact" showToolbar={false} showDetailPanel={false} />
        </div>
        {expanded ? (
          <div className="kv-graph-fullscreen" onClick={() => setExpanded(false)}>
            <div className="kv-graph-fullscreen__dialog" onClick={(e) => e.stopPropagation()}>
              <div className="kv-graph-fullscreen__header">
                <h3>知识图谱 · 全览</h3>
                <button
                  className="kv-button is-ghost is-icon-only"
                  onClick={() => setExpanded(false)}
                  type="button"
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
              <div className="kv-graph-fullscreen__body">
                <div className="kv-knowledge-shell">
                  <KnowledgeNavExplorer
                    nodes={meta.nodes || prepared.nodes}
                    clusters={prepared.clusters || []}
                    focusPath={focusPath}
                    favorites={meta.favorites || []}
                    history={meta.history || []}
                    pinnedIds={meta.pinnedIds || []}
                    enabledClusters={enabledClusters}
                    onToggleCluster={toggleCluster}
                    degreeMin={degreeMin}
                    onDegreeMinChange={setDegreeMin}
                    edgeMode={edgeMode}
                    onEdgeModeChange={setEdgeMode}
                    nodeSizeScale={nodeSizeScale}
                    onNodeSizeChange={setNodeSizeScale}
                    labelDensity={labelDensity}
                    onLabelDensityChange={setLabelDensity}
                    onSelectNode={(n) => setFocusPath(n.path || n.id)}
                    onSearchLocate={(q) => setFocusPath(
                      (prepared.nodes.find((n) =>
                        `${n.name} ${n.path}`.toLowerCase().includes(String(q || "").toLowerCase())
                      ) || {}).path || null
                    )}
                  />
                  <div className="kv-knowledge-shell__graph">
                    <KnowledgeForceGraph
                      {...graphProps}
                      mode="large"
                      onOpenDocument={(node) => {
                        setExpanded(false);
                        openDoc(node);
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="kv-graph-explorer is-large kv-knowledge-shell">
      <KnowledgeNavExplorer
        nodes={meta.nodes || prepared.nodes}
        clusters={prepared.clusters || []}
        focusPath={focusPath}
        favorites={meta.favorites || []}
        history={meta.history || []}
        pinnedIds={meta.pinnedIds || []}
        enabledClusters={enabledClusters}
        onToggleCluster={toggleCluster}
        degreeMin={degreeMin}
        onDegreeMinChange={setDegreeMin}
        edgeMode={edgeMode}
        onEdgeModeChange={setEdgeMode}
        nodeSizeScale={nodeSizeScale}
        onNodeSizeChange={setNodeSizeScale}
        labelDensity={labelDensity}
        onLabelDensityChange={setLabelDensity}
        onSelectNode={(n) => setFocusPath(n.path || n.id)}
        onSearchLocate={(q) => {
          const hit = prepared.nodes.find((n) =>
            `${n.name} ${n.path}`.toLowerCase().includes(String(q || "").toLowerCase())
          );
          if (hit) setFocusPath(hit.path || hit.id);
        }}
      />
      <div className="kv-knowledge-shell__graph">
        <KnowledgeForceGraph {...graphProps} mode="large" />
      </div>
    </div>
  );
}

function VaultWorkspacePanel({
  vault,
  panelTab,
  onPanelTabChange,
  browseNotes,
  browseTotal,
  browseLoading,
  mode,
  query,
  topK,
  searchResults,
  searching,
  onModeChange,
  onQueryChange,
  onTopKChange,
  onSearch,
  onPickResult,
  onRefreshBrowse,
  selectedPath,
  semanticReady = null,
  compact = false,
  hideTabs = false,
}) {
  const vectorModesDisabled = semanticReady === false;
  return (
    <section className={`kv-explorer-panel ${compact ? "is-compact" : ""}`}>
      {!hideTabs ? (
        <div className="kv-explorer-panel__tabs">
          <button
            className={panelTab === "browse" ? "is-active" : ""}
            data-testid="kv-tab-browse"
            onClick={() => onPanelTabChange("browse")}
            type="button"
          >
            <Icon name="folder" size={16} />
            文件
          </button>
          <button
            className={panelTab === "search" ? "is-active" : ""}
            data-testid="kv-tab-search"
            onClick={() => onPanelTabChange("search")}
            type="button"
          >
            <Icon name="search" size={16} />
            搜索
          </button>
          <button
            className={panelTab === "graph" ? "is-active" : ""}
            data-testid="kv-tab-graph"
            onClick={() => onPanelTabChange("graph")}
            type="button"
          >
            <Icon name="link" size={16} />
            图谱
          </button>
        </div>
      ) : null}

      {panelTab === "browse" ? (
        <BrowsePanel
          loading={browseLoading}
          notes={browseNotes}
          onPickFile={onPickResult}
          onRefresh={onRefreshBrowse}
          selectedPath={selectedPath}
          total={browseTotal}
        />
      ) : panelTab === "graph" ? null : (
        <>
          <form
            className="kv-search-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <div className="kv-search-input">
              <input
                data-testid="kv-search-input"
                disabled={!vault}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="文件名 / 全文 / 语义检索…"
                value={query}
              />
              <button data-testid="kv-search-btn" disabled={!vault || searching} type="submit" title="搜索">
                <Icon name="search" size={20} />
              </button>
            </div>

            <div className="kv-search-toolbar">
              <div className="kv-segmented">
                {SEARCH_MODES.map((item) => {
                  const needsVector = item.value === "semantic" || item.value === "hybrid";
                  const disabled = !vault || (needsVector && vectorModesDisabled);
                  return (
                    <button
                      className={mode === item.value ? "is-active" : ""}
                      disabled={disabled}
                      key={item.value}
                      onClick={() => onModeChange(item.value)}
                      title={
                        needsVector && vectorModesDisabled
                          ? "向量索引未就绪，请重建索引或配置 Embedding API"
                          : undefined
                      }
                      type="button"
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <label className="kv-topk">
                <span>Top K</span>
                <select
                  disabled={!vault}
                  onChange={(event) => onTopKChange(Number(event.target.value))}
                  value={topK}
                >
                  {[5, 10, 15, 20].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {vectorModesDisabled ? (
              <p className="kv-search-hint" data-testid="kv-semantic-unavailable">
                向量索引未就绪（本地模型首次下载较慢）。当前建议使用「全文」；在「更多」中完成「重建索引」后再试混合/语义。
              </p>
            ) : null}
          </form>

          <div className="kv-search-results">
            {searching ? (
              <div className="kv-empty-inline">正在检索知识库...</div>
            ) : searchResults.length ? (
              searchResults.map((result, index) => (
                <button
                  className={`kv-result-card ${selectedPath === result.path ? "is-selected" : ""}`}
                  data-testid={`kv-result-${index}`}
                  key={`${result.path}-${index}`}
                  onClick={() => onPickResult(result)}
                  type="button"
                >
                  <div className="kv-result-card__top">
                    <strong>{result.title || result.path}</strong>
                    <span
                      className={`kv-score ${
                        Number(result.score) >= 0.85 ? "is-high" : Number(result.score) >= 0.7 ? "is-mid" : ""
                      }`}
                    >
                      {Number.isFinite(Number(result.score)) ? Number(result.score).toFixed(2) : "—"}
                    </span>
                  </div>
                  <p>{result.snippet || result.path}</p>
                  <div className="kv-tags">
                    {(result.tags || []).slice(0, 4).map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                </button>
              ))
            ) : (
              <div className="kv-empty-inline">
                {vault ? "输入关键词，选择搜索模式后开始检索" : "先从左侧选择一个 Vault"}
              </div>
            )}
          </div>

          {searchResults.length > 0 && (
            <div className="kv-result-footer" data-testid="kv-result-footer">
              共 {searchResults.length} 条搜索结果
            </div>
          )}
        </>
      )}
    </section>
  );
}

function VaultDetailToolbar({ vault, status, reindexJob, onBack, onAction }) {
  if (!vault) return null;
  const indexState = deriveIndexState(status, vault, reindexJob);
  const noteCount = indexState.noteCount;
  const reindexing = indexState.key === "indexing";
  const [menuOpen, setMenuOpen] = useState(false);

  const onTitlebarDblClick = (event) => {
    if (!(typeof window !== "undefined" && window.__TAURI_INTERNALS__)) return;
    // 点在按钮/菜单上不切换最大化
    if (event.target?.closest?.("[data-tauri-no-drag], button, a, input, textarea, select")) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      void getCurrentWindow().toggleMaximize(),
    );
  };

  return (
    <header
      className="kv-workspace-bar kv-workspace-bar--titlebar"
      data-testid="kv-detail-toolbar"
      title="拖动窗口 · 双击最大化"
      onDoubleClick={onTitlebarDblClick}
      {...KV_TAURI_DRAG}
    >
      <div className="kv-workspace-bar__left" data-tauri-no-drag="">
        <button className="kv-workspace-bar__back" data-testid="kv-back-list" onClick={onBack} title="返回" type="button">
          <Icon name="chevron-left" size={14} />
        </button>
        <div className="kv-workspace-bar__divider" />
        <div className="kv-workspace-bar__vault">
          <div className="kv-workspace-bar__icon">
            <Icon name="vault" size={14} />
          </div>
          <div>
            <h2>
              {vault.name}
              {vault.builtin ? <span className="kv-doc-badge is-builtin" style={{ marginLeft: 8 }}>内置</span> : null}
            </h2>
            <p title={vault.vaultPath}>{vault.vaultPath || "未配置来源路径"}</p>
          </div>
        </div>
      </div>
      <div className="kv-workspace-bar__center" data-tauri-no-drag="">
        <IndexStatusBadge indexState={indexState} vault={vault} />
        <span className="kv-workspace-pill">
          <strong>{Number(noteCount).toLocaleString()}</strong> 篇文档
        </span>
        <span className="kv-workspace-pill">
          最近同步 {formatSyncTime(indexState.lastIndexedAt || vault.lastIndexedAt)}
        </span>
      </div>
      <div className="kv-workspace-bar__actions" data-tauri-no-drag="">
        <button
          className="kv-button is-primary"
          data-testid="kv-toolbar-sync"
          disabled={reindexing}
          onClick={() => onAction("sync", vault)}
          type="button"
          title="同步知识库"
        >
          <Icon name="refresh" size={13} />
          {reindexing ? "同步中…" : "同步"}
        </button>
        <button
          className="kv-button is-ghost"
          data-testid="kv-toolbar-info"
          onClick={() => onAction("info", vault)}
          type="button"
          title="知识库信息"
        >
          <Icon name="eye" size={13} />
          信息
        </button>
        <button
          className="kv-button is-ghost"
          data-testid="kv-toolbar-test-search"
          onClick={() => onAction("test-retrieval", vault)}
          type="button"
          title="测试检索"
        >
          <Icon name="search" size={13} />
          测试检索
        </button>
        <div className="kv-tile__menu-wrap">
          <button
            className="kv-button is-ghost is-icon-only"
            data-testid="kv-detail-more"
            onClick={() => setMenuOpen((v) => !v)}
            type="button"
            title="更多"
          >
            <Icon name="more" />
          </button>
          {menuOpen ? (
            <div className="kv-tile__menu kv-detail-more-menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                disabled={reindexing}
                onClick={() => {
                  setMenuOpen(false);
                  onAction("reindex", vault);
                }}
              >
                <Icon name="refresh" size={15} />
                <span>重建索引</span>
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); onAction("edit", vault); }}>
                <Icon name="edit" size={15} />
                <span>编辑配置</span>
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); onAction("test", vault); }}>
                <Icon name="settings" size={15} />
                <span>测试连接</span>
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); onAction("open-folder", vault); }}>
                <Icon name="folder" size={15} />
                <span>打开目录</span>
              </button>
            </div>
          ) : null}
        </div>
        <TauriWindowControls />
      </div>
    </header>
  );
}

function NoteEditor({
  note,
  loading,
  canWrite,
  saving,
  dirty,
  draft,
  viewMode,
  onDraftChange,
  onViewModeChange,
  onSave,
  onOpen,
  graphExpanded,
  graphLoading,
  onToggleGraph,
}) {
  useEffect(() => {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (!note || !canWrite || !dirty || saving) return;
        event.preventDefault();
        onSave();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [note, canWrite, dirty, saving, onSave]);

  return (
    <section className="kv-panel kv-note-panel kv-note-editor">
      <header className="kv-doc-chrome">
        <div className="kv-doc-chrome__top">
          <div className="kv-doc-chrome__identity">
            <h2 className="kv-doc-chrome__title" data-testid="kv-preview-title">
              {note?.title || "笔记"}
            </h2>
            <p className="kv-doc-chrome__path" title={note?.path}>
              {note?.path || "选择左侧文档开始阅读或编辑"}
            </p>
          </div>
          <div className="kv-doc-chrome__meta">
            {saving ? <span className="kv-doc-badge is-saving">保存中</span> : null}
            {!saving && dirty ? <span className="kv-doc-badge is-dirty">未保存</span> : null}
            {!saving && !dirty && note ? <span className="kv-doc-badge is-synced">已同步</span> : null}
            {!canWrite ? <span className="kv-doc-badge is-readonly">只读</span> : null}
          </div>
        </div>
        <div className="kv-doc-chrome__bar">
          <div className="kv-doc-chrome__actions" style={{ marginLeft: 0 }}>
            <button
              className={`kv-doc-icon-btn${graphExpanded ? " is-active" : ""}`}
              data-testid="kv-graph-toggle"
              disabled={!note || graphLoading}
              onClick={onToggleGraph}
              title={graphExpanded ? "收起图谱" : "图谱"}
              type="button"
            >
              <Icon name="link" size={16} />
              <span className="kv-doc-icon-btn__label">
                {graphLoading ? "图谱…" : "图谱"}
              </span>
            </button>
            <button
              className="kv-doc-icon-btn"
              data-testid="kv-note-open-external"
              disabled={!note}
              onClick={onOpen}
              title="在 Obsidian 中打开"
              type="button"
            >
              <Icon name="external" size={16} />
              <span className="kv-doc-icon-btn__label">打开</span>
            </button>
            {canWrite ? (
              <button
                className="kv-doc-save"
                data-testid="kv-note-save"
                disabled={!note || !dirty || saving}
                onClick={onSave}
                title="保存 (Ctrl+S)"
                type="button"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <div className="kv-note-content">
        {loading ? (
          <div className="kv-empty-inline">正在读取笔记...</div>
        ) : note ? (
          <MarkdownDocumentView
            text={draft}
            mode={viewMode === "edit" && canWrite ? "edit" : "preview"}
            allowEdit={!!canWrite}
            onModeChange={onViewModeChange}
            onChange={onDraftChange}
            readOnly={!canWrite || saving}
            placeholder={canWrite ? "在此编辑 Markdown 原文…" : "当前知识库为只读模式"}
            testIdPrefix="kv-note"
            className="kv-md-doc"
          />
        ) : (
          <div className="kv-empty-inline">尚未选择笔记</div>
        )}
      </div>
      {note ? (
        <footer className="kv-doc-statusbar">
          <span>{viewMode === "edit" ? "Markdown 源码" : "渲染预览"}</span>
          <span className="kv-doc-statusbar__sep" aria-hidden="true" />
          {canWrite ? <span>Ctrl+S 保存</span> : <span>只读浏览</span>}
          <span className="kv-doc-statusbar__sep" aria-hidden="true" />
          <span>{draft.length.toLocaleString()} 字符</span>
        </footer>
      ) : null}
    </section>
  );
}

function summarizeGraphEdges(edges) {
  const items = edges || [];
  const outgoing = items.filter((edge) => edge.type !== "backlink").length;
  const incoming = items.filter((edge) => edge.type === "backlink").length;
  const parts = [];
  if (outgoing) parts.push(`${outgoing} 条引用`);
  if (incoming) parts.push(`${incoming} 条反链`);
  return parts.join(" · ") || "无关联";
}

function graphHasLinks(graphResponse) {
  if (!graphResponse) return false;
  const edges = graphResponse.edges || [];
  const unresolved = graphResponse.unresolved || [];
  return edges.length > 0 || unresolved.length > 0;
}

async function openObsidianUri(uri) {
  const target = String(uri || "").trim();
  if (!target) return false;
  const isCustomScheme = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:/i.test(target);
  try {
    if (window.__TAURI_INTERNALS__) {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(target);
      return true;
    }
  } catch (error) {
    console.warn("[kv] shell open failed", error);
    // WebView location.href for custom schemes only yields a noisy
    // "scheme does not have a registered handler" error after shell.open fails.
    if (isCustomScheme) return false;
  }
  try {
    window.location.href = target;
    return true;
  } catch {
    return false;
  }
}

function resolveGraphNode(nodes, path) {
  const key = String(path || "").trim();
  if (!key) return null;
  const found = (nodes || []).find((node) => node.path === key || node.id === key);
  if (found) return found;
  const leaf = key.split("/").pop() || key;
  return {
    id: key,
    path: key,
    title: leaf.replace(/\.md$/i, ""),
  };
}

function buildGraphLinkGroups(graph, noteTitle) {
  const centerPath = graph?.centerPath || "";
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const outgoing = [];
  const incoming = [];
  const seenOut = new Set();
  const seenIn = new Set();

  for (const edge of edges) {
    if (edge.type === "backlink") {
      if (edge.target === centerPath && !seenIn.has(edge.source)) {
        seenIn.add(edge.source);
        const node = resolveGraphNode(nodes, edge.source);
        if (node) incoming.push(node);
      }
      continue;
    }
    if (edge.source === centerPath && !seenOut.has(edge.target)) {
      seenOut.add(edge.target);
      const node = resolveGraphNode(nodes, edge.target);
      if (node) outgoing.push(node);
    }
  }

  const center =
    resolveGraphNode(nodes, centerPath) ||
    (centerPath
      ? { id: centerPath, path: centerPath, title: noteTitle || centerPath }
      : null);

  return {
    center,
    outgoing,
    incoming,
    unresolved: graph?.unresolved || [],
    truncated: Boolean(graph?.truncated),
  };
}

function GraphLinkRow({ node, direction, onSelect }) {
  const title = node.title || node.path;
  return (
    <button
      className={`kv-link-row kv-link-row--${direction}`}
      onClick={() => onSelect(node)}
      title={node.path}
      type="button"
    >
      <span className="kv-link-row__icon" aria-hidden="true">
        <Icon name={direction === "out" ? "arrow-right" : "chevron-left"} size={14} />
      </span>
      <span className="kv-link-row__body">
        <strong>{title}</strong>
        <span>{node.path}</span>
      </span>
    </button>
  );
}

function GraphLinkSection({ title, count, direction, items, emptyText, onSelectNode }) {
  return (
    <section className="kv-link-hub__section">
      <header className="kv-link-hub__section-head">
        <h3>{title}</h3>
        <span className="kv-link-hub__count">{count}</span>
      </header>
      {items.length ? (
        <div className="kv-link-hub__list">
          {items.map((node) => (
            <GraphLinkRow
              direction={direction}
              key={node.path || node.id}
              node={node}
              onSelect={onSelectNode}
            />
          ))}
        </div>
      ) : (
        <p className="kv-link-hub__empty">{emptyText}</p>
      )}
    </section>
  );
}

function GraphPanel({ graph, noteTitle, depth, loading, onDepthChange, onSelectNode, onCollapse }) {
  const edges = graph?.edges || [];
  const [viewMode, setViewMode] = useState("list"); // list | graph
  const linkGroups = useMemo(
    () => buildGraphLinkGroups(graph, noteTitle),
    [graph, noteTitle]
  );
  const hasLinks = graphHasLinks(graph);

  const preparedNoteGraph = useMemo(() => {
    if (!hasLinks || !graph?.nodes) return null;
    const centerPath = linkGroups.center?.path || linkGroups.center?.id || null;
    return prepareForceGraphData(graph.nodes, graph.edges || [], {
      edgeMode: "balanced",
      compact: false,
      centerPath,
      hubCount: 1,
    });
  }, [graph, hasLinks, linkGroups.center]);

  return (
    <section className="kv-panel kv-graph-panel kv-link-hub">
      <div className="kv-panel__title-row">
        <div className="kv-link-hub__title">
          <h2 data-testid="kv-graph-title">图谱</h2>
          <p>基于双向链接索引，非 AI 生成</p>
        </div>
        <div className="kv-graph-panel__actions">
          {hasLinks ? (
            <div className="kv-graph-view-toggle" role="tablist">
              <button
                className={viewMode === "list" ? "is-active" : ""}
                onClick={() => setViewMode("list")}
                title="列表视图"
                type="button"
              >
                列表
              </button>
              <button
                className={viewMode === "graph" ? "is-active" : ""}
                onClick={() => setViewMode("graph")}
                title="力导向图视图"
                type="button"
              >
                图谱
              </button>
            </div>
          ) : null}
          <label className="kv-link-hub__depth">
            <span>深度</span>
            <select onChange={(event) => onDepthChange(Number(event.target.value))} value={depth}>
              {[1, 2, 3].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button className="kv-button is-ghost is-icon-only" onClick={onCollapse} title="收起图谱" type="button">
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className="kv-link-hub__body">
        {loading ? (
          <div className="kv-link-hub__loading">
            <div className="kv-link-hub__loading-dot" />
            <span>正在解析双向链接…</span>
          </div>
        ) : hasLinks ? (
          viewMode === "list" ? (
            <>
              {linkGroups.center ? (
                <div className="kv-link-hub__center">
                  <span className="kv-link-hub__center-label">当前笔记</span>
                  <strong>{linkGroups.center.title || linkGroups.center.path}</strong>
                  <code>{linkGroups.center.path}</code>
                </div>
              ) : null}

              <GraphLinkSection
                count={linkGroups.outgoing.length}
                direction="out"
                emptyText="没有引用其他笔记"
                items={linkGroups.outgoing}
                onSelectNode={onSelectNode}
                title="引用"
              />

              <GraphLinkSection
                count={linkGroups.incoming.length}
                direction="in"
                emptyText="暂无其他笔记链接到本篇"
                items={linkGroups.incoming}
                onSelectNode={onSelectNode}
                title="反链"
              />

              {linkGroups.unresolved.length ? (
                <section className="kv-link-hub__section kv-link-hub__section--muted">
                  <header className="kv-link-hub__section-head">
                    <h3>未解析</h3>
                    <span className="kv-link-hub__count">{linkGroups.unresolved.length}</span>
                  </header>
                  <div className="kv-link-hub__chips">
                    {linkGroups.unresolved.slice(0, 8).map((item) => (
                      <span className="kv-link-hub__chip" key={item} title={item}>
                        {item}
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}

              {linkGroups.truncated ? (
                <p className="kv-link-hub__hint">关联较多，已截断显示。可调高深度或从列表继续浏览。</p>
              ) : null}
            </>
          ) : (
            <div className="kv-note-graph-canvas">
              <KnowledgeForceGraph
                prepared={preparedNoteGraph}
                mode="note"
                centerPath={linkGroups.center?.path || linkGroups.center?.id || null}
                vaultId={null}
                onNodeClick={(node, meta) => {
                  if (meta?.open && onSelectNode && node.path) onSelectNode(node.path);
                }}
                onOpenDocument={(node) => {
                  if (onSelectNode && node.path) onSelectNode(node.path);
                }}
                onEditDocument={(node) => {
                  if (onSelectNode && node.path) onSelectNode(node.path);
                }}
                showToolbar
                showLegend={false}
                showDetailPanel
              />
            </div>
          )
        ) : (
          <div className="kv-link-hub__empty-state">
            <Icon name="link" size={28} />
            <strong>暂无图谱关联</strong>
            <p>在笔记中使用 [[wikilink]] 建立引用后，这里会显示关联笔记。</p>
          </div>
        )}
      </div>

      {hasLinks && viewMode === "list" ? (
        <div className="kv-graph-edges" data-testid="kv-graph-edges">
          {summarizeGraphEdges(edges)}
        </div>
      ) : null}
    </section>
  );
}

function VaultOverview({ vault, status, reindexJob, onAction, onDismissJob }) {
  const data = status || vault || {};
  const indexState = deriveIndexState(status, vault, reindexJob);
  const reindexing = indexState.key === "indexing";
  const needInstall = kbPackagesNeedInstall(status);
  return (
    <section className="kv-panel kv-overview-panel">
      <div className="kv-overview-head">
        <h2>{vault?.name || "Vault"} 状态</h2>
        <IndexStatusBadge indexState={indexState} vault={vault} />
      </div>

      <ReindexProgressBanner job={reindexJob} onDismiss={onDismissJob} />

      <div className="kv-tabs">
        <button className="is-active">概览</button>
        <button>索引统计</button>
        <button>配置信息</button>
        <button>检索服务</button>
      </div>

      <div className="kv-stat-grid" data-testid="kv-index-stats">
        <div>
          <strong>{Number(indexState.noteCount || 0).toLocaleString()}</strong>
          <span>笔记总数</span>
        </div>
        <div>
          <strong>
            {indexState.indexInitialized === true
              ? "已初始化"
              : indexState.indexInitialized === false
                ? "未初始化"
                : "—"}
          </strong>
          <span>索引状态</span>
        </div>
        <div>
          <strong>{indexState.semanticReady ? "可用" : "不可用"}</strong>
          <span>语义检索</span>
        </div>
        <div>
          <strong>{formatDate(indexState.lastIndexedAt)}</strong>
          <span>最后索引时间</span>
        </div>
      </div>

      {indexState.key === "index_pending" ||
      indexState.key === "index_partial" ||
      indexState.key === "warming" ||
      indexState.tone === "error" ||
      needInstall ? (
        <p className="kv-index-hint" data-testid="kv-index-hint">
          {needInstall
            ? "本地检索组件尚未安装（正式安装包不含该组件，约需联网下载一次）。请点击下方「安装检索组件并重建」；需本机已安装 Node.js。"
            : indexState.key === "index_pending"
            ? "当前全文/语义索引未就绪，小V与页面检索可能搜不到内容。请点击下方「重建索引」；重建时会显示进度与结果。"
            : indexState.key === "index_partial"
              ? indexState.detail ||
                "全文索引可用，但语义检索不可用（常见原因：embedding 未配置或不可达）。仍可全文搜索；也可重建索引后重试。"
              : indexState.key === "warming"
                ? "检索服务正在后台启动，本地全文已可搜索；就绪后语义检索会自动可用。"
                : `检索异常：${indexState.detail || "请重建索引或检查知识库服务。"}`}
        </p>
      ) : null}

      <h3 className="kv-section-label">快速操作</h3>
      <div className="kv-quick-actions">
        <button onClick={() => onAction("test", vault)} type="button">
          <Icon name="settings" />
          <strong>测试连接</strong>
          <span>测试检索服务连接</span>
        </button>
        <button
          onClick={() => onAction(needInstall ? "install" : "reindex", vault)}
          data-testid="kv-overview-reindex"
          disabled={reindexing}
          type="button"
        >
          <Icon name="refresh" />
          <strong>
            {reindexing
              ? needInstall || reindexJob?.runInstall || reindexJob?.run_install
                ? "正在安装/重建…"
                : "正在重建…"
              : needInstall
                ? "安装检索组件并重建"
                : "重建索引"}
          </strong>
          <span>
            {reindexing
              ? "请查看上方进度"
              : needInstall
                ? "联网安装 obsidian-hybrid-search 后建索引"
                : "完整更新所有笔记，可看进度"}
          </span>
        </button>
        <button onClick={() => onAction("incremental", vault)} disabled={reindexing} type="button">
          <Icon name="refresh" />
          <strong>增量更新</strong>
          <span>更新新增或修改的笔记</span>
        </button>
        <button onClick={() => onAction("open-folder", vault)} type="button">
          <Icon name="folder" />
          <strong>打开文件夹</strong>
          <span>在文件管理器中打开</span>
        </button>
      </div>
    </section>
  );
}

function Modal({ title, children, onClose, footer }) {
  return (
    <div className="kv-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="kv-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="kv-icon-button" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="kv-modal__body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

function VaultFormModal({ initialValue, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(() =>
    initialValue ? { ...EMPTY_VAULT_FORM, ...initialValue } : { ...EMPTY_VAULT_FORM }
  );
  const isEditing = Boolean(initialValue?.id);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function pickDirectory() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") update("vaultPath", selected);
    } catch {
      window.alert("系统原生文件夹选择器不可用，请手动输入路径");
    }
  }

  return (
    <Modal
      title={isEditing ? "编辑 Vault" : "添加 Obsidian Vault"}
      onClose={onClose}
      footer={
        <>
          <button className="kv-button is-ghost" id="wiz-cancel" onClick={onClose} type="button">
            取消
          </button>
          <button
            className="kv-button is-primary"
            disabled={saving || !form.name.trim() || !form.vaultPath.trim()}
            onClick={() => onSubmit(form)}
            type="button"
          >
            {saving ? "保存中..." : isEditing ? "保存修改" : "添加知识库"}
          </button>
        </>
      }
    >
      {!isEditing ? (
        <p className="kv-index-hint" style={{ marginTop: 0 }}>
          首次添加会在后台安装本地检索组件（npm 包 obsidian-hybrid-search，不是 Obsidian
          应用），并自动建索引；完成后可在页面查看进度。
        </p>
      ) : null}
      <div className="kv-form-grid" data-testid="kv-wizard">
        <label>
          <span>名称</span>
          <input onChange={(event) => update("name", event.target.value)} value={form.name} placeholder="例如：我的知识库" />
        </label>

        <label className="is-full">
          <span>Vault 目录</span>
          <div className="kv-path-input">
            <input onChange={(event) => update("vaultPath", event.target.value)} value={form.vaultPath} placeholder="选择 Obsidian Vault 或 Markdown 文件夹" />
            <button className="kv-button is-ghost" onClick={pickDirectory} type="button">
              <Icon name="folder" />
              选择文件夹
            </button>
          </div>
        </label>
      </div>
    </Modal>
  );
}

function VaultInfoDrawer({ vault, status, reindexJob, agentNames = [], onClose }) {
  if (!vault) return null;
  const indexState = deriveIndexState(status, vault, reindexJob);
  const badge = displayIndexBadge(indexState, vault);
  const ignoreRules = Array.isArray(vault.ignorePatterns)
    ? vault.ignorePatterns
    : Array.isArray(vault.ignore_patterns)
      ? vault.ignore_patterns
      : [];
  return (
    <div className="kv-drawer-root" data-testid="kv-info-drawer">
      <div className="kv-drawer-mask" onClick={onClose} />
      <aside className="kv-drawer" role="dialog" aria-label="知识库信息">
        <header className="kv-drawer__head">
          <div>
            <h2>{vault.name}</h2>
            <p>{badge.label} · {sourceTypeLabel(vault)}</p>
          </div>
          <button className="kv-button is-ghost is-icon-only" onClick={onClose} type="button" aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="kv-drawer__body">
          <section className="kv-drawer-section">
            <h4>来源目录</h4>
            <p className="kv-drawer-mono">{vault.vaultPath || "—"}</p>
          </section>
          <section className="kv-drawer-section">
            <h4>同步方式</h4>
            <p>{vault.accessMode === "read_only" ? "只读挂载" : "可读写"} · {vault.launchMode || "managed_stdio"}</p>
          </section>
          <section className="kv-drawer-section">
            <h4>忽略规则</h4>
            <p>{ignoreRules.length ? ignoreRules.join("、") : "使用默认忽略（.obsidian、节点模块等）"}</p>
          </section>
          <section className="kv-drawer-section">
            <h4>关联智能体</h4>
            <p>{agentNames.length ? agentNames.join("、") : "暂无关联"}</p>
          </section>
          <section className="kv-drawer-section">
            <h4>关联应用</h4>
            <p className="kv-drawer-muted">当前版本暂无应用绑定</p>
          </section>
          <section className="kv-drawer-section">
            <h4>最近同步结果</h4>
            <p>
              {formatSyncTime(indexState.lastIndexedAt || vault.lastIndexedAt)} · {indexState.label}
              {indexState.noteCount != null ? ` · ${indexState.noteCount} 篇` : ""}
            </p>
          </section>
          <section className="kv-drawer-section">
            <h4>索引错误</h4>
            <pre className="kv-drawer-pre">{indexState.detail || vault.searchError || "无"}</pre>
          </section>
          <section className="kv-drawer-section">
            <h4>日志</h4>
            <pre className="kv-drawer-pre">{String(vault.message || status?.message || reindexJob?.message || "暂无日志")}</pre>
          </section>
        </div>
      </aside>
    </div>
  );
}

function TestRetrievalDrawer({ vault, onClose, onOpenResult }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");

  async function runTest(event) {
    event?.preventDefault?.();
    if (!vault?.id || !q.trim()) return;
    setLoading(true);
    setError("");
    try {
      const response = await searchKnowledgeVault(vault.id, {
        query: q.trim(),
        mode,
        topK: 8,
      });
      const list = response.items || response.results || response || [];
      setItems(Array.isArray(list) ? list : []);
      if (!list.length) setError("未召回文档");
    } catch (e) {
      setError(e.message || "检索失败");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="kv-drawer-root" data-testid="kv-test-retrieval">
      <div className="kv-drawer-mask" onClick={onClose} />
      <aside className="kv-drawer kv-drawer--wide" role="dialog" aria-label="测试检索">
        <header className="kv-drawer__head">
          <div>
            <h2>测试检索</h2>
            <p>{vault?.name}</p>
          </div>
          <button className="kv-button is-ghost is-icon-only" onClick={onClose} type="button" aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="kv-drawer__body">
          <form className="kv-test-form" onSubmit={runTest}>
            <textarea
              className="kv-test-input"
              placeholder="输入问题，例如：项目的发布流程是什么？"
              rows={3}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="kv-test-form__row">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                {SEARCH_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <button className="kv-button is-primary" disabled={loading || !q.trim()} type="submit">
                {loading ? "检索中…" : "开始检索"}
              </button>
            </div>
          </form>
          {error ? <p className="kv-drawer-error">{error}</p> : null}
          <div className="kv-test-results">
            {items.map((item, idx) => {
              const score = item.score ?? item.relevance ?? item.similarity;
              const scoreText = score == null ? "—" : Number(score).toFixed(3);
              return (
                <button
                  key={`${item.path || item.title}-${idx}`}
                  className="kv-test-hit"
                  type="button"
                  onClick={() => {
                    onOpenResult?.(item);
                    onClose?.();
                  }}
                >
                  <div className="kv-test-hit__head">
                    <strong>{item.title || item.path || "未命名"}</strong>
                    <span>相关度 {scoreText}</span>
                  </div>
                  <p className="kv-test-hit__path">{item.path}</p>
                  <p className="kv-test-hit__snippet">{item.snippet || item.content || item.index_text || "无引用片段"}</p>
                </button>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function KnowledgeVaultsPage() {
  const [vaults, setVaults] = useState([]);
  const [selectedVaultId, setSelectedVaultId] = useState(null);
  const [status, setStatus] = useState(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("fulltext");
  const [topK, setTopK] = useState(10);
  const [panelTab, setPanelTab] = useState("browse");
  const [graphVisited, setGraphVisited] = useState(false);
  const [pageView, setPageView] = useState("list");
  const [browseNotes, setBrowseNotes] = useState([]);
  const [browseTotal, setBrowseTotal] = useState(0);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [selectedResult, setSelectedResult] = useState(null);
  const [note, setNote] = useState(null);
  const [graph, setGraph] = useState(null);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [depth, setDepth] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [searching, setSearching] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [editorView, setEditorView] = useState("preview");
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [reindexJob, setReindexJob] = useState(null);
  const [vaultAgentMap, setVaultAgentMap] = useState(() => new Map());
  const [listFilter, setListFilter] = useState({
    q: "",
    source: "",
    status: "",
    updated: "",
    sort: "updated",
  });
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(() => readStoredPageSize(VAULTS_PAGE_SIZE_KEY));
  const [infoOpen, setInfoOpen] = useState(false);
  const [testRetrievalOpen, setTestRetrievalOpen] = useState(false);

  const selectedVault = useMemo(
    () => vaults.find((item) => item.id === selectedVaultId) || vaults[0] || null,
    [vaults, selectedVaultId]
  );

  const filteredVaults = useMemo(() => {
    let list = [...vaults];
    const q = listFilter.q.trim().toLowerCase();
    if (q) {
      list = list.filter((v) => {
        const text = `${v.name} ${v.vaultPath}`.toLowerCase();
        return text.includes(q);
      });
    }
    if (listFilter.source) {
      list = list.filter((v) => {
        const src = sourceTypeLabel(v);
        if (listFilter.source === "builtin") return v.builtin;
        if (listFilter.source === "obsidian") return src === "Obsidian";
        if (listFilter.source === "folder") return src === "本地目录";
        return true;
      });
    }
    if (listFilter.status) {
      list = list.filter((v) => {
        const st = deriveIndexState(v, v);
        const badge = displayIndexBadge(st, v);
        return badge.key === listFilter.status;
      });
    }
    if (listFilter.updated) {
      const days = Number(listFilter.updated);
      if (Number.isFinite(days) && days > 0) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        list = list.filter((v) => {
          const t = new Date(v.lastIndexedAt || v.updatedAt || v.createdAt || 0).getTime();
          return Number.isFinite(t) && t >= cutoff;
        });
      }
    }
    list.sort((a, b) => {
      let primary;
      if (listFilter.sort === "name") {
        primary = String(a.name || "").localeCompare(String(b.name || ""), "zh");
      } else if (listFilter.sort === "docs") {
        primary =
          Number(b.listSortDocs ?? b.indexedNotes ?? 0) -
          Number(a.listSortDocs ?? a.indexedNotes ?? 0);
      } else {
        // Prefer frozen listSortAt so status enrichment / polling cannot reshuffle cards.
        const ta = new Date(a.listSortAt || a.lastIndexedAt || a.createdAt || 0).getTime();
        const tb = new Date(b.listSortAt || b.lastIndexedAt || b.createdAt || 0).getTime();
        primary = tb - ta;
      }
      if (primary !== 0) return primary;
      // Stable tiebreaker: createdAt asc → id asc.
      const ca = new Date(a.createdAt || 0).getTime();
      const cb = new Date(b.createdAt || 0).getTime();
      if (ca !== cb) return ca - cb;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
    return list;
  }, [vaults, listFilter]);

  useEffect(() => {
    setListPage(1);
  }, [listFilter]);

  const pagedVaults = useMemo(
    () => paginateItems(filteredVaults, listPage, listPageSize),
    [filteredVaults, listPage, listPageSize],
  );

  useEffect(() => {
    if (pagedVaults.page !== listPage) setListPage(pagedVaults.page);
  }, [pagedVaults.page, listPage]);

  const listSummary = useMemo(() => {
    let docs = 0;
    let ready = 0;
    let pending = 0;
    for (const v of vaults) {
      const st = deriveIndexState(v, v);
      docs += Number(st.noteCount || v.indexedNotes || 0);
      const badge = displayIndexBadge(st, v);
      if (badge.key === "ready") ready += 1;
      if (badge.key === "pending" || badge.key === "syncing" || badge.key === "failed") pending += 1;
    }
    return { vaults: vaults.length, docs, ready, pending };
  }, [vaults]);

  const selectedAgentNames = useMemo(() => {
    if (!selectedVault?.id) return [];
    return vaultAgentMap.get(selectedVault.id) || [];
  }, [selectedVault?.id, vaultAgentMap]);

  const canWriteNote = useMemo(() => {
    const mode = selectedVault?.accessMode || selectedVault?.access_mode;
    return mode === "read_write";
  }, [selectedVault]);

  const noteDirty = Boolean(note?.path) && draftContent !== savedContent;

  useEffect(() => {
    const content = note?.content ?? "";
    setDraftContent(content);
    setSavedContent(content);
  }, [note?.path, note?.content]);

  useEffect(() => {
    loadVaults();
  }, []);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("evopanel_pending_kb_connect") === "1") {
        sessionStorage.removeItem("evopanel_pending_kb_connect");
        setModal({ type: "form", value: null });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const inDetail = pageView === "detail";
    setKnowledgeVaultDetailShellMode(inDetail);
    return () => setKnowledgeVaultDetailShellMode(false);
  }, [pageView]);

  useEffect(() => {
    if (!selectedVault?.id) return;
    setSelectedVaultId(selectedVault.id);
    loadStatus(selectedVault.id);
    loadBrowseNotes(selectedVault.id);
  }, [selectedVault?.id]);

  // Poll while MCP is warming so the badge clears once the session is ready/failed.
  useEffect(() => {
    const vaultId = selectedVault?.id;
    if (!vaultId) return undefined;
    const warming =
      status?.mcpWarming === true ||
      status?.mcp_warming === true ||
      (status?.mcpWarming == null &&
        status?.mcp_warming == null &&
        /启动中/.test(String(status?.message || "")));
    if (!warming) return undefined;
    let cancelled = false;
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      if (cancelled || ticks > 60) {
        window.clearInterval(id);
        return;
      }
      void loadStatus(vaultId);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedVault?.id, status?.mcpWarming, status?.mcp_warming, status?.message, status?.mcpReady]);

  useEffect(() => {
    const ready = status?.semanticReady ?? status?.semantic_ready;
    if (ready === false && (mode === "semantic" || mode === "hybrid")) {
      setMode("fulltext");
    }
  }, [status?.semanticReady, status?.semantic_ready, mode]);

  useEffect(() => {
    if (!selectedResult?.path || !selectedVault?.id) {
      setNote(null);
      setGraph(null);
      setGraphExpanded(false);
      return;
    }
    setGraphExpanded(false);
    setGraph(null);
    loadNote(selectedResult.path);
  }, [selectedResult?.path, selectedVault?.id]);

  useEffect(() => {
    if (!graphExpanded || !selectedResult?.path || !selectedVault?.id) return;
    loadGraph(selectedResult.path, depth);
  }, [graphExpanded, selectedResult?.path, selectedVault?.id, depth]);

  function openVault(vault) {
    if (!vault?.id) return;
    setSelectedVaultId(vault.id);
    setPageView("detail");
    setPanelTab("browse");
    setSearchResults([]);
    setSelectedResult(null);
    setNote(null);
    setGraph(null);
    setGraphExpanded(false);
  }

  function backToVaultList() {
    setPageView("list");
    setSelectedResult(null);
    setNote(null);
    setGraph(null);
    setGraphExpanded(false);
  }

  function notify(message, type = "success") {
    setToast({ message, type });
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(null), 3200);
  }

  async function loadVaults() {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await listKnowledgeVaults();
      const items = (response.items || response.vaults || response || []).map(normalizeVault);
      if (items.length) {
        setSelectedVaultId((current) => current || items[0].id);
      }
      // 关联智能体（员工岗位 knowledge_vault_ids）— parallel with status enrich
      const rolesPromise = (async () => {
        try {
          const { api } = await import("../lib/tauri-api.js");
          const rolesRes = await api.proactiveListRoles().catch(() => ({ roles: [] }));
          const map = new Map();
          for (const role of rolesRes?.roles || []) {
            const ids = role?.config?.knowledge_vault_ids || role?.knowledge_vault_ids || [];
            const label = role.role_name || role.agent_code || role.name || "智能体";
            for (const id of ids) {
              const key = String(id || "").trim();
              if (!key) continue;
              if (!map.has(key)) map.set(key, []);
              map.get(key).push(label);
            }
          }
          setVaultAgentMap(map);
        } catch {
          setVaultAgentMap(new Map());
        }
      })();

      // Enrich all statuses first, then paint once — avoids list reorder mid-load.
      const enriched = await Promise.all(
        items.map(async (vault) => {
          try {
            const st = await getKnowledgeVaultStatus(vault.id);
            const lastIndexedAt =
              st.lastIndexedAt || st.last_indexed_at || vault.lastIndexedAt || null;
            const noteCount = st.noteCount ?? st.note_count ?? vault.indexedNotes;
            return normalizeVault({
              ...vault,
              ...st,
              searchReady: st.searchReady ?? st.search_ready,
              indexInitialized: st.indexInitialized ?? st.index_initialized,
              semanticReady: st.semanticReady ?? st.semantic_ready,
              searchError: st.searchError ?? st.search_error,
              noteCount,
              indexedNotes: noteCount,
              lastIndexedAt,
              listSortAt: lastIndexedAt || vault.createdAt || null,
              listSortDocs: Number(noteCount || 0),
            });
          } catch {
            return normalizeVault({
              ...vault,
              listSortAt: vault.lastIndexedAt || vault.createdAt || null,
              listSortDocs: Number(vault.indexedNotes || 0),
            });
          }
        })
      );
      await rolesPromise;
      setVaults(enriched);
    } catch (error) {
      const message = error.message || "加载 Vault 失败";
      setLoadError(message);
      setVaults([]);
      notify(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function loadBrowseNotes(vaultId) {
    setBrowseLoading(true);
    try {
      const response = await listKnowledgeNotes(vaultId, { limit: 500 });
      const items = response.items || [];
      setBrowseNotes(items);
      setBrowseTotal(response.total ?? items.length);
    } catch (error) {
      notify(error.message || "加载文档目录失败", "error");
    } finally {
      setBrowseLoading(false);
    }
  }

  async function loadStatus(vaultId) {
    try {
      const response = await getKnowledgeVaultStatus(vaultId);
      setStatus(response);
      if (response?.reindexJob) setReindexJob(response.reindexJob);
      setVaults((current) =>
        current.map((vault) =>
          vault.id === vaultId ? applyVaultStatus(vault, response) : vault
        )
      );
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    const st = String(reindexJob?.state || "").toLowerCase();
    if (st !== "queued" && st !== "running") return undefined;
    const vaultId = selectedVaultId || reindexJob?.vaultId || reindexJob?.vault_id;
    if (!vaultId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await getKnowledgeVaultReindexJob(vaultId);
        if (cancelled) return;
        setReindexJob(job);
        if (job?.state === "done" || job?.state === "error") {
          await loadStatus(vaultId);
          if (job.state === "done") notify(job.message || "索引重建完成");
          else notify(job.error || job.message || "索引重建失败", "error");
        }
      } catch {
        /* keep polling */
      }
    };
    const id = window.setInterval(tick, 1500);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [reindexJob?.state, reindexJob?.jobId, selectedVaultId]);

  async function handleSearch() {
    if (!selectedVault?.id) return;
    setSearching(true);
    try {
      const response = await searchKnowledgeVault(selectedVault.id, {
        query,
        mode,
        topK,
      });
      const items = response.items || response.results || response || [];
      setSearchResults(items);
      setPanelTab("search");
      setSelectedResult(items[0] || null);
      if (!items.length) notify("没有检索到相关笔记", "warning");
    } catch (error) {
      const message = error.message || "搜索失败";
      if (/provider_unavailable|closedresource|503/i.test(message)) {
        notify(`${message}。请在右上角「更多」中重建索引`, "error");
      } else {
        notify(message, "error");
      }
    } finally {
      setSearching(false);
    }
  }

  async function loadNote(path) {
    setReading(true);
    try {
      const readResponse = await readKnowledgeNotes(selectedVault.id, {
        paths: [path],
        maxContentChars: 100000,
      });
      const notes = readResponse.items || readResponse.notes || readResponse || [];
      setNote(Array.isArray(notes) ? notes[0] || null : notes);
    } catch (error) {
      notify(error.message || "读取笔记失败", "error");
    } finally {
      setReading(false);
    }
  }

  async function loadGraph(path, graphDepth = depth) {
    setGraphLoading(true);
    try {
      const graphResponse = await graphKnowledgeVault(selectedVault.id, {
        path,
        depth: graphDepth,
        direction: "both",
      });
      setGraph(graphResponse);
    } catch (error) {
      setGraph(null);
      notify(error.message || "加载关系图失败", "error");
    } finally {
      setGraphLoading(false);
    }
  }

  async function saveCurrentNote() {
    if (!selectedVault?.id || !note?.path || !noteDirty || !canWriteNote) return;
    setSavingNote(true);
    try {
      const response = await saveKnowledgeNote(selectedVault.id, {
        path: note.path,
        content: draftContent,
      });
      const saved = response.item || response.note || { ...note, content: draftContent };
      setNote(saved);
      setSavedContent(draftContent);
      notify("已保存");
    } catch (error) {
      const message = error.message || "保存失败";
      if (/write_disabled|403/i.test(message)) {
        notify("当前知识库为只读，请在设置中开启读写模式", "error");
      } else if (/path_forbidden/i.test(message)) {
        notify("该路径不在允许写入的目录范围内", "error");
      } else {
        notify(message, "error");
      }
    } finally {
      setSavingNote(false);
    }
  }

  function toggleGraphPanel() {
    if (graphExpanded) {
      setGraphExpanded(false);
      return;
    }
    if (!selectedResult?.path) return;
    setGraphExpanded(true);
  }

  async function saveVault(form) {
    setSaving(true);
    try {
      const payload = {
        name: form.name?.trim(),
        vaultPath: form.vaultPath?.trim(),
        accessMode: form.accessMode || "read_write",
        launchMode: form.launchMode || "managed_stdio",
        defaultInboxPath: form.defaultInboxPath || "00-Inbox",
        allowedWritePaths: Array.isArray(form.allowedWritePaths)
          ? form.allowedWritePaths.filter(Boolean)
          : ["*"],
        embeddingMode: form.embeddingMode || "local",
        enabled: form.enabled !== false,
      };
      if (!payload.allowedWritePaths.length) {
        payload.allowedWritePaths = ["*"];
      }
      let createdId = form.id;
      if (form.id) {
        await updateKnowledgeVault(form.id, payload);
        await loadVaults();
        setModal(null);
        notify("Vault 已更新");
        return;
      }

      const created = await createKnowledgeVault(payload);
      createdId = created?.id;
      // 先关弹窗并进入详情，避免首次 npm 安装长时间卡在「保存中」
      setModal(null);
      await loadVaults();
      if (createdId) {
        setSelectedVaultId(createdId);
        setPageView("detail");
        setPanelTab("browse");
      }
      notify("知识库已添加，正在后台安装检索组件并建索引…", "warning");

      if (createdId) {
        try {
          const res = await installKnowledgeVault(createdId);
          if (res?.reindexJob) setReindexJob(res.reindexJob);
        } catch (installErr) {
          notify(
            installErr?.message || "已创建连接，但未能启动初始化，可稍后在概览页点击「重建索引」或「安装检索组件并重建」",
            "warning",
          );
        }
      }
    } catch (error) {
      notify(error.message || "保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleVaultAction(action, vault) {
    if (!vault) return;

    try {
      if (action === "search") {
        openVault(vault);
        setPanelTab("search");
      } else if (action === "edit") {
        setModal({ type: "form", value: vault });
      } else if (action === "info") {
        setInfoOpen(true);
      } else if (action === "test-retrieval") {
        setTestRetrievalOpen(true);
      } else if (action === "test") {
        notify("正在测试连接...", "warning");
        const response = await testKnowledgeVault(vault.id);
        notify(response.message || "连接测试成功");
        await loadStatus(vault.id);
      } else if (action === "sync" || action === "incremental") {
        notify("正在同步知识库…", "warning");
        const job = await reindexKnowledgeVault(vault.id, { force: false });
        setReindexJob(job);
        setPageView("detail");
        setSelectedVaultId(vault.id);
      } else if (action === "install" || action === "reindex") {
        const needInstall =
          action === "install" || kbPackagesNeedInstall(status);
        if (needInstall) {
          if (
            !window.confirm(
              "将联网安装本地检索组件（obsidian-hybrid-search，不是 Obsidian 应用）并重建索引。需本机已安装 Node.js，首次可能需几分钟。确定继续？",
            )
          ) {
            return;
          }
          notify("已开始安装检索组件并建索引，进度见页面提示", "warning");
          const res = await installKnowledgeVault(vault.id);
          if (res?.reindexJob) setReindexJob(res.reindexJob);
        } else {
          if (!window.confirm("重建索引将重新扫描全部文档，可能耗时较长。确定继续？")) return;
          notify("已开始重建索引，进度见页面提示", "warning");
          const job = await reindexKnowledgeVault(vault.id, { force: true });
          setReindexJob(job);
        }
        setPageView("detail");
        setSelectedVaultId(vault.id);
      } else if (action === "open-folder") {
        try {
          const openerId = "@tauri-apps/plugin-opener";
          const { openPath } = await import(/* @vite-ignore */ openerId);
          await openPath(vault.vaultPath);
        } catch {
          notify(vault.vaultPath, "warning");
        }
      } else if (action === "menu") {
        setModal({ type: "manage", value: vault });
      } else if (action === "delete") {
        await removeVault(vault);
      }
    } catch (error) {
      notify(error.message || "操作失败", "error");
    }
  }

  async function removeVault(vault) {
    if (vault?.builtin) {
      notify("系统内置知识库不可删除，可在设置中停用", "warning");
      return;
    }
    if (!window.confirm(`确认删除“${vault.name}”的连接配置？不会删除 Vault 文件。`)) return;
    try {
      await deleteKnowledgeVault(vault.id);
      setModal(null);
      setSearchResults([]);
      setBrowseNotes([]);
      setBrowseTotal(0);
      setSelectedResult(null);
      await loadVaults();
      notify("连接配置已删除");
    } catch (error) {
      notify(error.message || "删除失败", "error");
    }
  }

  async function openSelectedNote() {
    if (!selectedVault || !note?.path) return;
    const fallback = `obsidian://open?vault=${encodeURIComponent(selectedVault.name)}&file=${encodeURIComponent(note.path)}`;
    const failHint = "无法在 Obsidian 中打开。请确认已安装 Obsidian，并至少启动过一次以注册协议。";
    try {
      const response = await openKnowledgeNote(selectedVault.id, { path: note.path });
      const uri = response?.uri || fallback;
      const ok = await openObsidianUri(uri);
      if (!ok) notify(failHint, "error");
    } catch (error) {
      const ok = await openObsidianUri(fallback);
      if (!ok) notify(error.message || failHint, "error");
    }
  }

  return (
    <main className={`kv-page${pageView === "detail" ? " is-detail" : " is-hub"}`}>
      {pageView !== "detail" ? (
        <header className="kv-page-head" data-testid="kv-page-header">
          <div className="kv-page-head__copy">
            <h1 data-testid="kv-page-title">Obsidian（遗留）</h1>
            <p>
              外部 Vault 挂载已降级为过渡能力。新知识请使用「知识库」；Agent 检索默认走知识库。
            </p>
          </div>
          <div className="kv-page-head__right">
            <KnowledgeSourceTabs active="obsidian" />
            <div className="kv-page-head__actions">
              <button className="kv-button is-ghost" onClick={loadVaults} type="button">
                <Icon name="refresh" />
                刷新
              </button>
              <button
                className="kv-button is-primary"
                data-testid="kv-add-vault"
                onClick={() => setModal({ type: "form", value: null })}
                type="button"
              >
                <Icon name="plus" />
                连接知识库
              </button>
            </div>
          </div>
        </header>
      ) : null}

      {loadError ? (
        <section className="kv-empty-state" data-testid="kv-error">
          <h2>加载失败</h2>
          <p>{loadError}</p>
          <button className="kv-button is-primary" onClick={loadVaults} type="button">
            重试
          </button>
        </section>
      ) : loading ? (
        <div className="kv-page-loading">正在加载知识库...</div>
      ) : vaults.length === 0 ? (
        <section className="kv-empty-hero" data-testid="kv-empty">
          <div className="kv-empty-hero__icon">
            <Icon name="vault" size={44} />
          </div>
          <h2>尚未连接知识库</h2>
          <p>添加一个本地 Vault 后，即可浏览文档、全文检索，并为智能体提供长期记忆。</p>
          <button
            className="kv-button is-primary"
            data-testid="kv-empty-add"
            onClick={() => setModal({ type: "form", value: null })}
            type="button"
          >
            <Icon name="plus" />
            连接第一个知识库
          </button>
        </section>
      ) : pageView === "list" ? (
        <section className="kv-gallery" data-testid="kv-list-view">
          <div className="kv-summary" data-testid="kv-summary">
            <div><strong>{listSummary.vaults}</strong><span>知识库</span></div>
            <div><strong>{listSummary.docs.toLocaleString()}</strong><span>文档总数</span></div>
            <div><strong>{listSummary.ready}</strong><span>可用</span></div>
            <div><strong>{listSummary.pending}</strong><span>待处理</span></div>
          </div>
          <div className="kv-list-toolbar">
            <div className="kv-list-search">
              <Icon name="search" size={15} />
              <input
                placeholder="搜索知识库"
                value={listFilter.q}
                onChange={(e) => setListFilter((f) => ({ ...f, q: e.target.value }))}
              />
            </div>
            <select
              aria-label="来源类型"
              value={listFilter.source}
              onChange={(e) => setListFilter((f) => ({ ...f, source: e.target.value }))}
            >
              <option value="">来源：全部</option>
              <option value="obsidian">Obsidian</option>
              <option value="folder">本地目录</option>
              <option value="builtin">系统内置</option>
            </select>
            <select
              aria-label="索引状态"
              value={listFilter.status}
              onChange={(e) => setListFilter((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="">状态：全部</option>
              <option value="ready">索引就绪</option>
              <option value="syncing">同步中</option>
              <option value="pending">待索引</option>
              <option value="failed">同步失败</option>
              <option value="path_invalid">目录失效</option>
            </select>
            <select
              aria-label="最近更新"
              value={listFilter.updated}
              onChange={(e) => setListFilter((f) => ({ ...f, updated: e.target.value }))}
            >
              <option value="">最近更新：全部</option>
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
              <option value="90">近 90 天</option>
            </select>
            <select
              aria-label="排序"
              value={listFilter.sort}
              onChange={(e) => setListFilter((f) => ({ ...f, sort: e.target.value }))}
            >
              <option value="updated">按最近更新</option>
              <option value="name">按名称</option>
              <option value="docs">按文档数量</option>
            </select>
            <span className="kv-list-count">共 {filteredVaults.length} 个</span>
          </div>
          <div className="kv-gallery__grid" data-testid="kv-card-grid">
            {pagedVaults.items.map((vault) => (
              <VaultCard
                key={vault.id}
                agentCount={(vaultAgentMap.get(vault.id) || []).length}
                onAction={handleVaultAction}
                onOpen={openVault}
                vault={vault}
              />
            ))}
          </div>
          {pagedVaults.total > 0 ? (
            <div className="kb-list-pager-wrap">
              <div className="ef-list-pager" role="navigation" aria-label="列表分页">
                <span className="ef-list-pager-meta">
                  共 {pagedVaults.total} 个 · 第 {pagedVaults.from}–{pagedVaults.to} 个
                </span>
                <label className="ef-list-pager-size">
                  每页
                  <select
                    aria-label="每页条数"
                    value={listPageSize}
                    onChange={(e) => {
                      const next = Number(e.target.value) || 20;
                      setListPageSize(next);
                      setListPage(1);
                      writeStoredPageSize(VAULTS_PAGE_SIZE_KEY, next);
                    }}
                  >
                    {LIST_PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="ef-list-pager-nav">
                  <button
                    type="button"
                    className="ef-list-pager-btn"
                    disabled={pagedVaults.page <= 1}
                    onClick={() => setListPage(pagedVaults.page - 1)}
                  >
                    上一页
                  </button>
                  <span className="ef-list-pager-cur">
                    {pagedVaults.page} / {pagedVaults.pageCount}
                  </span>
                  <button
                    type="button"
                    className="ef-list-pager-btn"
                    disabled={pagedVaults.page >= pagedVaults.pageCount}
                    onClick={() => setListPage(pagedVaults.page + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {!filteredVaults.length ? <div className="kv-empty-inline">没有匹配的知识库</div> : null}
        </section>
      ) : selectedVault ? (
        <div className="kv-workspace" data-testid="kv-detail-view">
          <VaultDetailToolbar
            onAction={handleVaultAction}
            onBack={backToVaultList}
            reindexJob={reindexJob}
            status={status}
            vault={selectedVault}
          />
          {reindexJob && reindexJob.state !== "idle" ? (
            <div className="kv-workspace__banner">
              <ReindexProgressBanner
                job={reindexJob}
                onDismiss={() => setReindexJob(null)}
              />
            </div>
          ) : null}
          <div className={`kv-workspace__body${panelTab === "graph" ? " is-graph-workspace" : ""}`}>
            <nav className="kv-rail" aria-label="工作区导航">
              <button
                className={panelTab === "browse" ? "is-active" : ""}
                data-testid="kv-tab-browse"
                onClick={() => setPanelTab("browse")}
                title="文件"
                type="button"
              >
                <Icon name="folder" size={20} />
                <span className="kv-rail__label">文件</span>
              </button>
              <button
                className={panelTab === "search" ? "is-active" : ""}
                data-testid="kv-rail-tab-search"
                onClick={() => setPanelTab("search")}
                title="搜索"
                type="button"
              >
                <Icon name="search" size={20} />
                <span className="kv-rail__label">搜索</span>
              </button>
              <button
                className={panelTab === "graph" ? "is-active" : ""}
                data-testid="kv-rail-tab-graph"
                onClick={() => {
                  setGraphVisited(true);
                  setPanelTab("graph");
                }}
                title="图谱"
                type="button"
              >
                <Icon name="link" size={20} />
                <span className="kv-rail__label">图谱</span>
              </button>
            </nav>
            {panelTab !== "graph" ? (
              <aside className="kv-explorer">
                <VaultWorkspacePanel
                  browseLoading={browseLoading}
                  browseNotes={browseNotes}
                  browseTotal={browseTotal}
                  compact
                  hideTabs
                  mode={mode}
                  onModeChange={setMode}
                  onPanelTabChange={setPanelTab}
                  onPickResult={setSelectedResult}
                  onQueryChange={setQuery}
                  onRefreshBrowse={() => loadBrowseNotes(selectedVault.id)}
                  onSearch={handleSearch}
                  onTopKChange={setTopK}
                  panelTab={panelTab}
                  query={query}
                  searchResults={searchResults}
                  searching={searching}
                  semanticReady={status?.semanticReady ?? status?.semantic_ready ?? null}
                  selectedPath={selectedResult?.path}
                  topK={topK}
                  vault={selectedVault}
                />
              </aside>
            ) : null}
            <main className={`kv-stage${panelTab === "graph" ? " is-graph-mode" : ""}`}>
              <div
                className="kv-stage__graph-host"
                style={{ display: panelTab === "graph" ? "flex" : "none", height: "100%", minHeight: 0, flex: 1 }}
              >
                {(panelTab === "graph" || graphVisited) ? (
                <GraphExplorer
                  large
                  vaultId={selectedVault?.id}
                  vaultPath={selectedVault?.vaultPath || selectedVault?.vault_path || ""}
                  vaultName={selectedVault?.name || ""}
                  onPickFile={(path) => {
                    setGraphVisited(true);
                    setSelectedResult({ path });
                    setPanelTab("browse");
                  }}
                  onEditFile={(path) => {
                    setGraphVisited(true);
                    setSelectedResult({ path });
                    setPanelTab("browse");
                    setEditorView("edit");
                  }}
                />
                ) : null}
              </div>
              {panelTab !== "graph" ? (
                selectedResult ? (
                <div className={`kv-stage__reader${graphExpanded ? " has-graph" : ""}`}>
                  <NoteEditor
                    canWrite={canWriteNote}
                    dirty={noteDirty}
                    draft={draftContent}
                    graphExpanded={graphExpanded}
                    graphLoading={graphLoading}
                    loading={reading}
                    note={note}
                    onDraftChange={setDraftContent}
                    onOpen={openSelectedNote}
                    onSave={saveCurrentNote}
                    onToggleGraph={toggleGraphPanel}
                    onViewModeChange={setEditorView}
                    saving={savingNote}
                    viewMode={editorView}
                  />
                  {graphExpanded ? (
                    <GraphPanel
                      depth={depth}
                      graph={graph}
                      loading={graphLoading}
                      noteTitle={note?.title}
                      onCollapse={() => setGraphExpanded(false)}
                      onDepthChange={setDepth}
                      onSelectNode={(node) => setSelectedResult({ path: node.path, title: node.title })}
                    />
                  ) : null}
                </div>
                ) : (
                <section className="kv-stage-empty">
                  <div className="kv-stage-empty__inner">
                    <Icon name="file" size={36} />
                    <h3>选择一篇文档</h3>
                    <p>从左侧文件夹浏览，或切换到搜索查找内容</p>
                  </div>
                </section>
                )
              ) : null}
            </main>
          </div>
        </div>
      ) : (
        <div className="kv-page-loading">正在打开知识库…</div>
      )}

      {modal?.type === "form" && (
        <VaultFormModal initialValue={modal.value} onClose={() => setModal(null)} onSubmit={saveVault} saving={saving} />
      )}

      {modal?.type === "manage" && (
        <Modal
          title={modal.value.name}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="kv-button is-danger" onClick={() => removeVault(modal.value)}>
                <Icon name="trash" />
                删除配置
              </button>
              <button className="kv-button is-ghost" onClick={() => setModal(null)}>关闭</button>
            </>
          }
        >
          <div className="kv-manage-list">
            <button onClick={() => { setModal(null); handleVaultAction("edit", modal.value); }}>
              <Icon name="edit" /> 编辑 Vault 配置
            </button>
            <button onClick={() => { setModal(null); handleVaultAction("test", modal.value); }}>
              <Icon name="settings" /> 测试连接
            </button>
            <button onClick={() => { setModal(null); handleVaultAction("sync", modal.value); }}>
              <Icon name="refresh" /> 同步
            </button>
            <button onClick={() => { setModal(null); handleVaultAction("reindex", modal.value); }}>
              <Icon name="refresh" /> 重建索引
            </button>
            <button
              onClick={async () => {
                try {
                  await updateKnowledgeVault(modal.value.id, { enabled: !modal.value.enabled });
                  setModal(null);
                  await loadVaults();
                  notify(modal.value.enabled ? "已禁用" : "已启用");
                } catch (error) {
                  notify(error.message || "更新失败", "error");
                }
              }}
            >
              <Icon name="settings" /> {modal.value.enabled ? "禁用 Vault" : "启用 Vault"}
            </button>
          </div>
        </Modal>
      )}

      {toast && <div className={`kv-toast is-${toast.type}`}>{toast.message}</div>}
      {infoOpen && selectedVault ? (
        <VaultInfoDrawer
          agentNames={selectedAgentNames}
          onClose={() => setInfoOpen(false)}
          reindexJob={reindexJob}
          status={status}
          vault={selectedVault}
        />
      ) : null}
      {testRetrievalOpen && selectedVault ? (
        <TestRetrievalDrawer
          onClose={() => setTestRetrievalOpen(false)}
          onOpenResult={(item) => {
            setSelectedResult(item);
            setPanelTab("search");
          }}
          vault={selectedVault}
        />
      ) : null}
    </main>
  );
}
