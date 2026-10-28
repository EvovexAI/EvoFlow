import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/tauri-api.js";
import {
  folderPathFromRelative,
  shouldSkipKnowledgeDir,
  shouldSkipKnowledgeRelPath,
} from "../lib/knowledge-file-filter.js";
import { collectEmbeddingModelOptions } from "../lib/model-classification.js";
import { KnowledgeHubLayout } from "./knowledge-owned-hub.jsx";
import {
  DocumentChunksPanel,
  DocumentToc,
  KnowledgeRailCards,
  parseMarkdownHeadings,
  scrollToHeading,
  useReaderMarkdownEnhance,
} from "./knowledge-owned-reader.jsx";
import {
  findOwnedDocByWorkspacePath,
  KnowledgeV4FileTree,
  KnowledgeV4Markdown,
} from "./knowledge-v4-preview.jsx";
import { syncKnowledgeAsideForDetail } from "./knowledge-owned-aside.js";
import "./knowledge-source-tabs.css";

/**
 * 知识图谱（G1/G2）UI 总开关：默认关。
 * 关着时不展示「图谱」入口；功能成熟后再翻成 true。
 */
const KB_GRAPH_UI_ENABLED = false;

// 知识图谱为重型图渲染（react-force-graph-2d / d3-force），仅在切到「图谱」tab 时
// 才动态加载，避免打进知识库页面首屏 chunk 导致打开慢。
// KnowledgeForceGraph 是命名导出，转成 default 供 React.lazy 使用。
const LazyKnowledgeForceGraph = KB_GRAPH_UI_ENABLED
  ? React.lazy(() =>
      import("../react/components/KnowledgeForceGraph.jsx").then((m) => ({
        default: m.KnowledgeForceGraph,
      })),
    )
  : null;

function openModelsEmbeddingSettings() {
  window.location.hash = "#/settings?tab=models";
}

function statusBadge(status) {
  const s = String(status || "");
  if (s === "completed") return { cls: "ok", kind: "ready", label: "已就绪" };
  if (s === "processing" || s === "pending") {
    return {
      cls: "busy",
      kind: "processing",
      label: s === "pending" ? "排队中" : "处理中",
    };
  }
  if (s === "failed") return { cls: "err", kind: "attention", label: "失败" };
  return { cls: "", kind: "empty", label: s || "—" };
}

/** Prefer fileName in trees/headers — folder path already lives in the left rail. */
function docDisplayName(doc) {
  const fileName = String(doc?.fileName || "").trim();
  if (fileName) return fileName;
  const title = String(doc?.title || "").trim();
  if (title) return title;
  return String(doc?.id || "文档");
}

function IconPencil() {
  return (
    <svg fill="none" height="14" viewBox="0 0 16 16" width="14" aria-hidden="true">
      <path
        d="M11.3 1.7a1.5 1.5 0 0 1 2.12 0l.88.88a1.5 1.5 0 0 1 0 2.12L6.2 12.8 2 14l1.2-4.2z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg fill="none" height="14" viewBox="0 0 16 16" width="14" aria-hidden="true">
      <path
        d="M3.5 4.5h9M6 4.5V3.2A1.2 1.2 0 0 1 7.2 2h1.6A1.2 1.2 0 0 1 10 3.2v1.3M4.5 4.5l.6 8.2A1.2 1.2 0 0 0 6.3 14h3.4a1.2 1.2 0 0 0 1.2-1.1l.6-8.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function IconChunks() {
  return (
    <svg fill="none" height="14" viewBox="0 0 16 16" width="14" aria-hidden="true">
      <path
        d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function formatSyncBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function SyncPreviewModal({
  open,
  loading,
  plan,
  path,
  mode,
  pruneMissing,
  onPruneChange,
  busy,
  error,
  onClose,
  onConfirm,
  onRetry,
}) {
  if (!open) return null;
  const createTotal = Number(plan?.createTotal || 0);
  const updateTotal = Number(plan?.updateTotal || 0);
  const pruneTotal = Number(plan?.pruneTotal || 0);
  const unchanged = Number(plan?.unchanged || 0);
  const skipped = Number(plan?.skipped || 0);
  const hasChanges = Boolean(plan?.hasChanges);
  const title = mode === "import" ? "核对导入清单" : "核对同步清单";
  const confirmLabel = mode === "import" ? "确认导入" : "确认同步";
  const canClose = !busy && !loading;

  const Section = ({ kind, label, total, items }) => {
    if (!total) return null;
    const sample = Array.isArray(items) ? items : [];
    const more = Math.max(0, total - sample.length);
    return (
      <section className={`ko-sync-preview__section is-${kind}`}>
        <header>
          <strong>{label}</strong>
          <span>{total}</span>
        </header>
        <ul>
          {sample.map((item) => (
            <li key={`${kind}:${item.relPath || item.fileName}`}>
              <code title={item.relPath}>{item.relPath || item.fileName}</code>
              {item.sizeBytes != null ? (
                <span className="ko-sync-preview__size">{formatSyncBytes(item.sizeBytes)}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {more > 0 ? <p className="ko-sync-preview__more">…还有 {more} 项未列出</p> : null}
      </section>
    );
  };

  return (
    <div
      className="ko-modal-backdrop"
      onMouseDown={(e) => {
        // Only the dimmed backdrop closes; ignore dialog clicks and opening click-through.
        if (e.target !== e.currentTarget || !canClose) return;
        onClose?.();
      }}
      role="presentation"
    >
      <div
        className="ko-modal ko-sync-preview"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ko-sync-preview-title"
      >
        <h2 id="ko-sync-preview-title">{title}</h2>
        <p className="ko-modal__hint ko-sync-preview__path" title={path || plan?.sourcePath || ""}>
          源目录：{path || plan?.sourcePath || "—"}
        </p>
        {loading ? (
          <p className="ko-modal__hint">正在扫描本地文件夹与知识库差异…</p>
        ) : error ? (
          <div className="ko-sync-preview__error">
            <p className="ko-modal__hint is-warn">{error}</p>
            <button className="ko-btn" disabled={busy} onClick={onRetry} type="button">
              重试扫描
            </button>
          </div>
        ) : plan ? (
          <>
            <div className="ko-sync-preview__stats" aria-label="同步差异摘要">
              <div><strong>{createTotal}</strong><span>新增</span></div>
              <div><strong>{updateTotal}</strong><span>更新</span></div>
              <div><strong>{unchanged}</strong><span>未变</span></div>
              <div><strong>{pruneTotal}</strong><span>将清理</span></div>
              <div><strong>{skipped}</strong><span>已跳过</span></div>
            </div>
            {!hasChanges ? (
              <p className="ko-modal__hint">没有需要同步的变更。仍可确认以刷新记住的源路径。</p>
            ) : null}
            <div className="ko-sync-preview__lists">
              <Section kind="create" label="将新增" total={createTotal} items={plan.create} />
              <Section kind="update" label="将更新" total={updateTotal} items={plan.update} />
              <Section kind="prune" label="源中已删除（可选清理）" total={pruneTotal} items={plan.prune} />
            </div>
            <label className="ko-modal__toggle">
              <input
                checked={Boolean(pruneMissing)}
                disabled={busy || pruneTotal === 0}
                onChange={(e) => onPruneChange?.(e.target.checked)}
                type="checkbox"
              />
              <span>同步后清理知识库中源目录已不存在的文档{pruneTotal ? `（${pruneTotal}）` : ""}</span>
            </label>
          </>
        ) : (
          <p className="ko-modal__hint is-warn">未能生成同步清单</p>
        )}
        <div className="ko-modal__actions">
          <button className="ko-btn" disabled={!canClose} onClick={onClose} type="button">
            取消
          </button>
          <button
            className="ko-btn primary"
            disabled={busy || loading || !plan || Boolean(error)}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "同步中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Human label for kb_jobs.type — index vs summary must stay distinct. */
function jobTypeLabel(type) {
  const t = String(type || "").trim();
  if (t === "parse_index" || t === "reindex") return "索引";
  if (t === "summary_doc") return "摘要";
  if (t === "wiki_ingest" || t === "wiki_finalize") return "Wiki";
  if (t === "kg_extract") return "图谱";
  return t || "任务";
}

function jobTypeClass(type) {
  const t = String(type || "").trim();
  if (t === "parse_index" || t === "reindex") return "index";
  if (t === "summary_doc") return "summary";
  if (t === "wiki_ingest" || t === "wiki_finalize") return "wiki";
  if (t === "kg_extract") return "kg";
  return "other";
}

function jobProgressText(job) {
  const p = job?.progress && typeof job.progress === "object" ? job.progress : {};
  const msg = String(p.message || "").trim();
  const pct = Number(p.percent);
  if (msg && Number.isFinite(pct) && pct > 0) return `${msg} · ${Math.round(pct)}%`;
  if (msg) return msg;
  if (Number.isFinite(pct) && pct > 0) return `${Math.round(pct)}%`;
  if (String(job?.state || "") === "running") return "处理中…";
  return "等待中";
}

function jobDocLabel(job, docsById) {
  const title = String(job?.docTitle || "").trim();
  if (title) return title;
  const did = String(job?.docId || job?.doc_id || "").trim();
  if (did && docsById?.[did]) {
    const d = docsById[did];
    return String(d.title || d.fileName || did).trim() || did;
  }
  return did ? `文档 ${did.slice(0, 10)}…` : "库级任务";
}

/** Map legacy English reclaim errors (and new Chinese ones) to a clear UI line. */
function jobErrorHeadline(raw) {
  const s = String(raw || "").trim();
  if (!s) return "任务失败，但服务端没有返回详细原因。";
  if (/retry budget exhausted|多次超时.*停止重试|多次超时.*用尽重试/i.test(s)) {
    return "处理失败：任务多次超时，已停止重试（可点下方「重试」再跑）";
  }
  if (/reclaimed stale running job|任务超时.*重新排队/i.test(s)) {
    return "任务超时未完成，已重新排队";
  }
  if (/task timed out repeatedly/i.test(s)) {
    return "处理失败：任务多次超时，已停止重试";
  }
  return s.split("\n[traceback] ")[0] || s;
}

function isPdfName(name) {
  return /\.pdf$/i.test(String(name || ""));
}

const ASK_HINTS = ["总结当前文档要点", "这份知识库讲了什么？", "有哪些关键结论或数据？"];

function HitAssets({ assets }) {
  const list = Array.isArray(assets) ? assets : [];
  const [urls, setUrls] = useState({});
  useEffect(() => {
    let cancelled = false;
    const created = [];
    (async () => {
      const next = {};
      for (const a of list.slice(0, 4)) {
        try {
          const u = await api.fetchOwnedKnowledgeAssetObjectUrl(a.id);
          created.push(u);
          if (!cancelled) next[a.id] = u;
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [list.map((a) => a.id).join("|")]);
  if (!list.length) return null;
  return (
    <div className="ko-hit-assets">
      {list.slice(0, 4).map((a) =>
        urls[a.id] ? (
          <img alt={a.alt || "图片"} key={a.id} src={urls[a.id]} title={a.alt || a.id} />
        ) : (
          <span className="ko-badge" key={a.id}>
            {a.alt || "图片"}
          </span>
        )
      )}
    </div>
  );
}

function parseOwnedRoute() {
  const path = String(window.location.hash || "")
    .replace(/^#/, "")
    .split("?")[0] || "/knowledge/owned";
  if (
    path === "/knowledge" ||
    path === "/knowledge/" ||
    path === "/knowledge/owned" ||
    path === "/knowledge/owned/"
  ) {
    return { view: "list", kbId: "" };
  }
  const m = path.match(/^\/knowledge\/owned\/([^/]+)$/);
  if (m && m[1]) {
    return { view: "detail", kbId: decodeURIComponent(m[1]) };
  }
  // Legacy: /knowledge/:id (when not vaults) → treat as owned detail
  const legacy = path.match(/^\/knowledge\/([^/]+)$/);
  if (legacy && legacy[1] && legacy[1] !== "vaults" && legacy[1] !== "owned") {
    return { view: "detail", kbId: decodeURIComponent(legacy[1]) };
  }
  return { view: "list", kbId: "" };
}

function goOwnedList() {
  window.location.hash = "/knowledge/owned";
}

function goOwnedDetail(kbId) {
  if (!kbId) {
    goOwnedList();
    return;
  }
  window.location.hash = `/knowledge/owned/${encodeURIComponent(kbId)}`;
}

function goOwnedDetailAsk(kbId, prompt) {
  try {
    sessionStorage.setItem("ko-open-ask", "1");
    if (prompt) sessionStorage.setItem("ko-pending-ask", String(prompt));
  } catch {
    /* ignore */
  }
  goOwnedDetail(kbId);
}

function formatUpdatedAt(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** Keep one doc per folderPath+fileName (newest updatedAt wins). */
function dedupeDocsByRelPath(docs) {
  const best = new Map();
  for (const doc of docs || []) {
    const folder = String(doc.folderPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const name = String(doc.fileName || doc.title || doc.id || "").trim();
    const key = `${folder}\0${name}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, doc);
      continue;
    }
    const prevTs = String(prev.updatedAt || prev.createdAt || "");
    const nextTs = String(doc.updatedAt || doc.createdAt || "");
    if (nextTs >= prevTs) best.set(key, doc);
  }
  return Array.from(best.values());
}

/** Build Lexiang-like folder tree from documents' folderPath + explicit folders. */
function buildDocTree(docs, folders) {
  const root = { type: "folder", name: "", path: "", children: [], docs: [] };
  const pathHasSkippedDir = (rawPath) => {
    const parts = String(rawPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    return parts.some((part) => shouldSkipKnowledgeDir(part));
  };
  const ensureFolder = (rawPath) => {
    const raw = String(rawPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    if (!raw) return root;
    if (pathHasSkippedDir(raw)) return null;
    const parts = raw.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.type === "folder" && c.name === part);
      if (!child) {
        child = { type: "folder", name: part, path: acc, children: [], docs: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };
  for (const f of folders || []) {
    ensureFolder(f.path || f);
  }
  for (const doc of docs || []) {
    const node = ensureFolder(doc.folderPath);
    if (node) node.docs.push(doc);
  }
  // Drop empty folders (explicit empties, or dirs that only held skipped files).
  const pruneEmpty = (n) => {
    n.children = n.children.map(pruneEmpty).filter((c) => c.children.length > 0 || c.docs.length > 0);
    return n;
  };
  pruneEmpty(root);
  const sortNode = (n) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    n.docs.sort((a, b) => {
      const so = Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
      if (so !== 0) return so;
      return String(a.title || a.fileName || "").localeCompare(
        String(b.title || b.fileName || ""),
        "zh"
      );
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function IconFolder() {
  return (
    <svg fill="currentColor" height="16" viewBox="0 0 16 16" width="16" aria-hidden="true">
      <path d="M7 2c.325 0 .64.105.9.3l1.2.9c.26.195.575.3.9.3h3a2 2 0 0 1 2 2V12l-.01.204a2 2 0 0 1-1.786 1.785L13 14H3l-.204-.01A2 2 0 0 1 1 12V4a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function IconFile({ active }) {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" aria-hidden="true">
      <path
        d="M2 3a2 2 0 0 1 2-2h4.757a3 3 0 0 1 2.122.879L13.12 4.12A3 3 0 0 1 14 6.243V13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"
        fill={active ? "#0064DB" : "currentColor"}
        opacity={active ? 0.08 : 0}
      />
      <path
        d="M9.054 1.015a3 3 0 0 1 1.825.864L13.12 4.12A3 3 0 0 1 14 6.242V13a2 2 0 0 1-1.796 1.99L12 15H4a2 2 0 0 1-1.99-1.796L2 13V3a2 2 0 0 1 2-2h4.758zM4 2.2a.8.8 0 0 0-.8.8v10a.8.8 0 0 0 .8.8h8a.8.8 0 0 0 .8-.8V6.242a1.8 1.8 0 0 0-.527-1.272L10.03 2.728A1.8 1.8 0 0 0 8.758 2.2z"
        fill={active ? "#0064DB" : "currentColor"}
      />
    </svg>
  );
}

function IconChevron({ open }) {
  return open ? (
    <svg fill="currentColor" height="14" viewBox="0 0 12 12" width="14" aria-hidden="true">
      <path d="M9.924 3.958a.6.6 0 0 1 0 .847L7.299 7.43a1.836 1.836 0 0 1-2.598 0L2.076 4.805a.599.599 0 1 1 .848-.847l2.625 2.625a.64.64 0 0 0 .902 0l2.625-2.625a.6.6 0 0 1 .848 0" />
    </svg>
  ) : (
    <svg fill="currentColor" height="14" viewBox="0 0 12 12" width="14" aria-hidden="true">
      <path d="M7.761 7.052a1.425 1.425 0 0 0 0-2.015L4.844 2.12a.599.599 0 1 0-.847.847l2.916 2.917a.225.225 0 0 1 0 .319L3.997 9.12a.599.599 0 1 0 .847.847z" />
    </svg>
  );
}

function CatalogTreeNodes({
  node,
  level,
  expanded,
  onToggle,
  selectedDocId,
  onSelectDoc,
  onRenameFolder,
  onDeleteFolder,
  onMoveDoc,
  onCreateSubfolder,
  onDropDoc,
  onDropFolder,
  dragDocId,
  setDragDocId,
  dragFolderPath,
  setDragFolderPath,
}) {
  return (
    <>
      {node.children.map((folder) => {
        const open = expanded.has(folder.path);
        const hasKids = folder.children.length > 0 || folder.docs.length > 0;
        const dragging = dragFolderPath === folder.path;
        return (
          <div key={`f:${folder.path}`}>
            <div
              className={`ko-tree-item${dragging ? " is-dragging" : ""}`}
              draggable
              style={{ "--level": level }}
              title={`${folder.name}（可拖拽到其他文件夹）`}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/ko-folder-path", folder.path);
                e.dataTransfer.effectAllowed = "move";
                setDragFolderPath?.(folder.path);
                setDragDocId?.("");
              }}
              onDragEnd={() => setDragFolderPath?.("")}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                e.currentTarget.classList.add("is-drop");
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove("is-drop")}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.classList.remove("is-drop");
                const folderFrom =
                  e.dataTransfer.getData("text/ko-folder-path") || dragFolderPath;
                const docId = e.dataTransfer.getData("text/ko-doc-id") || dragDocId;
                if (folderFrom) {
                  if (folderFrom !== folder.path) {
                    onDropFolder?.({ fromPath: folderFrom, parentPath: folder.path });
                  }
                  return;
                }
                if (docId) onDropDoc?.({ docId, folderPath: folder.path });
              }}
            >
              <button
                className="ko-tree-chevron"
                disabled={!hasKids}
                onClick={() => onToggle(folder.path)}
                type="button"
                title={open ? "收起" : "展开"}
              >
                {hasKids ? <IconChevron open={open} /> : <span className="ko-tree-chevron-spacer" />}
              </button>
              <button
                className="ko-tree-label"
                onClick={() => onToggle(folder.path)}
                title={folder.name}
                type="button"
              >
                <span className="ko-tree-type-icon">
                  <IconFolder />
                </span>
                <span className="ko-tree-title">{folder.name}</span>
              </button>
              <div className="ko-tree-ops">
                <button
                  className="ko-tree-op"
                  onClick={() => onCreateSubfolder?.(folder.path)}
                  title="新建子文件夹"
                  type="button"
                >
                  +
                </button>
                <button
                  className="ko-tree-op"
                  onClick={() => onRenameFolder?.(folder.path, folder.name)}
                  title="重命名"
                  type="button"
                >
                  改
                </button>
                <button
                  className="ko-tree-op"
                  onClick={() => onDeleteFolder?.(folder.path)}
                  title="删除文件夹"
                  type="button"
                >
                  删
                </button>
              </div>
            </div>
            {open ? (
              <CatalogTreeNodes
                dragDocId={dragDocId}
                dragFolderPath={dragFolderPath}
                expanded={expanded}
                level={level + 1}
                node={folder}
                onCreateSubfolder={onCreateSubfolder}
                onDeleteFolder={onDeleteFolder}
                onDropDoc={onDropDoc}
                onDropFolder={onDropFolder}
                onMoveDoc={onMoveDoc}
                onRenameFolder={onRenameFolder}
                onSelectDoc={onSelectDoc}
                onToggle={onToggle}
                selectedDocId={selectedDocId}
                setDragDocId={setDragDocId}
                setDragFolderPath={setDragFolderPath}
              />
            ) : null}
          </div>
        );
      })}
      {node.docs.map((doc) => {
        const active = doc.id === selectedDocId;
        const title = docDisplayName(doc);
        const extIdx = title.lastIndexOf(".");
        const stem = extIdx > 0 ? title.slice(0, extIdx) : title;
        const ext = extIdx > 0 ? title.slice(extIdx) : "";
        return (
          <div
            className={`ko-tree-item${active ? " is-active" : ""}${dragDocId === doc.id ? " is-dragging" : ""}`}
            draggable
            key={doc.id}
            style={{ "--level": level }}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/ko-doc-id", doc.id);
              e.dataTransfer.effectAllowed = "move";
              setDragDocId?.(doc.id);
              setDragFolderPath?.("");
            }}
            onDragEnd={() => setDragDocId?.("")}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              e.currentTarget.classList.add("is-drop");
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove("is-drop")}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.classList.remove("is-drop");
              const folderFrom =
                e.dataTransfer.getData("text/ko-folder-path") || dragFolderPath;
              if (folderFrom) {
                // Drop folder onto a doc → move folder to that doc's parent folder
                const parent = String(doc.folderPath || "");
                onDropFolder?.({ fromPath: folderFrom, parentPath: parent });
                return;
              }
              const id = e.dataTransfer.getData("text/ko-doc-id") || dragDocId;
              if (id && id !== doc.id) onDropDoc?.({ docId: id, beforeDocId: doc.id });
            }}
          >
            <span className="ko-tree-chevron-spacer" />
            <button
              className={`ko-tree-label${active ? " is-active" : ""}`}
              onClick={() => onSelectDoc(doc.id)}
              title={`${title}（可拖拽排序/移入文件夹）`}
              type="button"
            >
              <span className="ko-tree-type-icon">
                <IconFile active={active} />
              </span>
              <span className="ko-tree-title">
                <span className="ko-tree-title__stem">{stem}</span>
                {ext ? <span className="ko-tree-title__ext">{ext}</span> : null}
              </span>
            </button>
            <div className="ko-tree-ops">
              <button
                className="ko-tree-op"
                onClick={() => onMoveDoc?.(doc)}
                title="移动到文件夹"
                type="button"
              >
                移
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function AskAiPanel({
  messages,
  askInput,
  onInput,
  onAsk,
  askBusy,
  askListRef,
  askModel,
  chatModels,
  effectiveChatModel,
  onAskModelChange,
  onClear,
  onHint,
  onCitation,
  selectedTitle,
  emptyHint,
}) {
  const canSend = !askBusy && Boolean(String(askInput || "").trim());
  return (
    <div className="ko-ask" data-testid="ko-ask-panel">
      <header className="ko-ask__header">
        <div className="ko-ask__heading">
          <span className="ko-ask__eyebrow">KNOWLEDGE Q&A</span>
          <h2>问知识库</h2>
          <p>{selectedTitle ? `当前聚焦：${selectedTitle}` : emptyHint || "基于整个知识库检索、归纳并回答"}</p>
        </div>
        <button
          aria-label="新建问答会话"
          className="ko-ask__new"
          disabled={!messages.length || askBusy}
          onClick={onClear}
          title="新建会话"
          type="button"
        >
          <span aria-hidden="true">＋</span>
          新会话
        </button>
      </header>

      <div className="ko-ask__toolbar">
        <div className="ko-ask__scope">
          <span className="ko-ask__scope-dot" aria-hidden="true" />
          <span>{selectedTitle ? "当前文档" : "整个知识库"}</span>
          {!askModel && effectiveChatModel ? (
            <span className="ko-ask__scope-model" title="未选择时使用知识库默认对话模型">
              {effectiveChatModel}
            </span>
          ) : null}
        </div>
        {chatModels.length > 0 ? (
          <select
            className="ko-ask__model-select"
            disabled={askBusy}
            onChange={(e) => onAskModelChange(e.target.value)}
            value={askModel || ""}
          >
            <option value="">默认模型</option>
            {chatModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="ko-ask__thread" ref={askListRef}>
        {!messages.length && !askBusy ? (
          <div className="ko-ask__empty">
            <p className="ko-ask__empty-title">问知识库</p>
            <p className="ko-ask__empty-desc">用自然语言检索与归纳，回答会附带可跳转的引用。</p>
            <div className="ko-ask__chips">
              {ASK_HINTS.map((h) => (
                <button className="ko-ask__chip" key={h} onClick={() => onHint(h)} type="button">
                  {h}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((m) => (
          <div
            className={`ko-ask__msg ko-ask__msg--${m.role}${m.error ? " is-error" : ""}`}
            key={m.id}
          >
            {m.role === "assistant" ? <div className="ko-ask__role">回答</div> : null}
            <div className="ko-ask__body">{m.content}</div>
            {m.role === "assistant" && m.citations?.length ? (
              <div className="ko-ask__refs">
                {m.citations.map((c, i) => (
                  <button
                    className="ko-ask__ref"
                    key={c.chunkId || `${c.docId}-${i}`}
                    onClick={() => onCitation(c.docId)}
                    title={c.snippet || ""}
                    type="button"
                  >
                    <span>{i + 1}</span>
                    {c.title || "文档"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {askBusy ? (
          <div className="ko-ask__msg ko-ask__msg--assistant is-pending">
            <div className="ko-ask__role">回答</div>
            <div className="ko-ask__pending">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>

      <div className="ko-ask__dock">
        <textarea
          disabled={askBusy}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onAsk();
            }
          }}
          placeholder="输入问题，Enter 发送 · Shift+Enter 换行"
          rows={2}
          value={askInput}
        />
        <button
          className="ko-ask__send"
          disabled={!canSend}
          onClick={() => onAsk()}
          type="button"
        >
          发送
        </button>
      </div>
    </div>
  );
}

function ManualNoteModal({ title, onTitleChange, body, onBodyChange, onSubmit, onClose, busy }) {
  // ESC closes; backdrop click closes. Body scroll is locked while open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      aria-modal="true"
      className="ko-manual-modal"
      data-testid="ko-manual-modal"
      onMouseDown={(e) => {
        // Click on the backdrop (not the panel) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="ko-manual-modal__panel">
        <header className="ko-manual-modal__head">
          <h2>手写 Markdown</h2>
          <button
            aria-label="关闭"
            className="ko-manual-modal__close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="ko-manual-modal__body">
          <input
            autoFocus
            className="ko-manual-modal__title"
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="标题"
            type="text"
            value={title}
          />
          <textarea
            className="ko-manual-modal__textarea"
            onChange={(e) => onBodyChange(e.target.value)}
            placeholder="正文 Markdown…（⌘/Ctrl+Enter 保存，Esc 取消）"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (!busy && String(title || "").trim() && String(body || "").trim()) {
                  onSubmit();
                }
              }
            }}
            rows={18}
            value={body}
          />
        </div>
        <footer className="ko-manual-modal__foot">
          <span className="ko-manual-modal__hint">保存后会自动进入索引</span>
          <div className="ko-manual-modal__actions">
            <button className="ko-btn" onClick={onClose} type="button">
              取消
            </button>
            <button
              className="ko-btn primary"
              disabled={busy || !String(title || "").trim() || !String(body || "").trim()}
              onClick={onSubmit}
              type="button"
            >
              保存并索引
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SearchPanel({
  query,
  onQuery,
  onSearch,
  busy,
  hits,
  tagFilter,
  onTagFilter,
  kbTags,
  searchMode,
  onSearchMode,
  onOpenDoc,
}) {
  return (
    <div className="ko-search" data-testid="ko-search-panel">
      <div className="ko-search__bar">
        <div className="ko-search__modes" role="group" aria-label="检索模式">
          {[
            { id: "hybrid", label: "混合" },
            { id: "keyword", label: "关键词" },
            { id: "semantic", label: "语义" },
          ].map((m) => (
            <button
              className={`ko-search__mode${searchMode === m.id ? " is-active" : ""}`}
              key={m.id}
              onClick={() => onSearchMode(m.id)}
              type="button"
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="ko-search__input-row">
          <input
            autoFocus
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSearch();
            }}
            placeholder="检索知识库分块…"
            type="search"
            value={query}
          />
          <button className="ko-btn primary" disabled={busy || !String(query || "").trim()} onClick={onSearch} type="button">
            {busy ? "检索中…" : "检索"}
          </button>
        </div>
        {(kbTags || []).length ? (
          <div className="ko-tags ko-tags--filter">
            {(kbTags || []).slice(0, 20).map((t) => (
              <button
                className={`ko-tag${tagFilter === t.tag ? " is-active" : ""}`}
                key={t.tag}
                onClick={() => onTagFilter?.(tagFilter === t.tag ? "" : t.tag)}
                type="button"
              >
                #{t.tag}
                <span className="ko-meta"> {t.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ko-search__results" data-testid="ko-search-hits">
        {!hits?.length ? (
          <div className="ko-search__empty">
            <p className="ko-search__empty-title">{query.trim() ? "没有匹配结果" : "检索分块"}</p>
            <p className="ko-search__empty-desc">
              {query.trim()
                ? "试试换关键词，或切换混合 / 关键词 / 语义模式。"
                : "混合检索会同时使用关键词与向量；点结果可打开对应文档。"}
            </p>
          </div>
        ) : (
          <>
            <div className="ko-search__count">{hits.length} 条结果</div>
            {hits.map((h) => (
              <article className="ko-search__hit" key={h.chunkId}>
                <button
                  className="ko-search__hit-head"
                  onClick={() => onOpenDoc?.(h.docId)}
                  type="button"
                >
                  <strong>{h.title || h.fileName || "文档"}</strong>
                  <span>{h.chunkKind || "text"}</span>
                </button>
                {h.tags?.length ? (
                  <div className="ko-tags">
                    {h.tags.map((t) => (
                      <span className="ko-tag" key={t}>
                        #{t}
                      </span>
                    ))}
                  </div>
                ) : null}
                <pre>{h.content}</pre>
                <HitAssets assets={h.assets} />
              </article>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function KnowledgeHome({ base, docs, recentDocs, onAsk, onOpenDoc, onSearch, onSyncFolder, onWrite, globalSettings }) {
  const baseName = String(base?.name || "知识库");
  const description = String(base?.description || "集中阅读、检索和维护团队知识");
  return (
    <div className="ko-reader-home" data-testid="ko-reader-home">
      <div className="ko-reader-home__intro">
        <span className="ko-reader-home__eyebrow">KNOWLEDGE BASE</span>
        <h1>{baseName}</h1>
        <p>{description}</p>
        <div className="ko-reader-home__search" role="button" tabIndex={0} onClick={onSearch} onKeyDown={(e) => e.key === "Enter" && onSearch()}>
          <span aria-hidden="true">⌕</span>
          <span>搜索文档、主题和关键词</span>
          <kbd>⌘ K</kbd>
        </div>
      </div>
      <div className="ko-reader-home__stats" aria-label="知识库统计">
        <div><strong>{docs.length}</strong><span>篇文档</span></div>
        <div><strong>{base?.vectorized ? "已就绪" : "待索引"}</strong><span>检索状态</span></div>
        <div><strong>{recentDocs.length}</strong><span>近期更新</span></div>
      </div>
      <p className="ko-reader-home__runtime" data-testid="ko-runtime-models">
        问答 / 摘要模型：
        <strong>{globalSettings?.effectiveChatModel || "未配置"}</strong>
        {globalSettings?.chatModel ? "（知识库专用）" : "（跟随全局默认）"}
        <span aria-hidden="true"> · </span>
        自动摘要：<strong>{base?.summaryEnabled ? "已开启" : "已关闭"}</strong>
      </p>
      <section className="ko-reader-home__section">
        <div className="ko-reader-home__section-head"><h2>开始使用</h2><span>选择一个入口</span></div>
        <div className="ko-reader-home__actions">
          <button type="button" onClick={onAsk}><span>✦</span><strong>问 AI</strong><small>从知识库获得答案</small></button>
          <button type="button" onClick={onSyncFolder}><span>↻</span><strong>同步本地文件夹</strong><small>改文件后核对清单再同步</small></button>
          <button type="button" onClick={onWrite}><span>＋</span><strong>写一篇笔记</strong><small>记录可复用的知识</small></button>
        </div>
      </section>
      {recentDocs.length ? (
        <section className="ko-reader-home__section">
          <div className="ko-reader-home__section-head"><h2>最近更新</h2><button type="button" onClick={onSearch}>查看全部</button></div>
          <div className="ko-reader-home__recent">
            {recentDocs.map((doc) => (
              <button key={doc.id} type="button" onClick={() => onOpenDoc(doc.id)}>
                <span className="ko-reader-home__file">{String(doc.fileName || doc.title || "文档").split(".").pop().toUpperCase()}</span>
                <span><strong>{doc.title || doc.fileName || "未命名文档"}</strong><small>{doc.folderPath || "根目录"}</small></span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default function KnowledgeOwnedPage() {
  const [route, setRoute] = useState(() => parseOwnedRoute());
  const [bases, setBases] = useState([]);
  const selectedId = route.view === "detail" ? route.kbId : "";
  const [docs, setDocs] = useState([]);
  const [folders, setFolders] = useState([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retryingDocs, setRetryingDocs] = useState(() => new Set());
  const [reindexingAll, setReindexingAll] = useState(false);
  const [toast, setToast] = useState("");
  const [listFilter, setListFilter] = useState("");
  const [docFilter, setDocFilter] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [tab, setTab] = useState("docs"); // docs | ask | search | wiki | graph
  const [searchMode, setSearchMode] = useState("hybrid"); // hybrid | keyword | semantic
  const [wikiPages, setWikiPages] = useState([]);
  const [wikiSlug, setWikiSlug] = useState("");
  const [wikiPage, setWikiPage] = useState(null);
  const [wikiDraft, setWikiDraft] = useState("");
  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });
  const [graphKind, setGraphKind] = useState("wiki"); // wiki | entity | documents
  const [docLinks, setDocLinks] = useState(null);
  const [tagFilter, setTagFilter] = useState("");
  const [kbTags, setKbTags] = useState([]);
  const [jobStats, setJobStats] = useState(null);
  const [jobItems, setJobItems] = useState([]);
  // Default dismissed: processing shows a corner chip; user opens the full ledger on demand.
  const [syncPopupDismissed, setSyncPopupDismissed] = useState(true);
  const [docCounts, setDocCounts] = useState({});
  const [selectedDocId, setSelectedDocId] = useState("");
  const [expandedFolders, setExpandedFolders] = useState(() => new Set());
  const [docContent, setDocContent] = useState(null);
  const [docContentLoading, setDocContentLoading] = useState(false);
  const [docContentEpoch, setDocContentEpoch] = useState(0);
  const [pdfObjectUrl, setPdfObjectUrl] = useState("");
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false);
  const [relatedDocs, setRelatedDocs] = useState([]);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [rightMode, setRightMode] = useState("reader"); // reader | ask
  const [askInput, setAskInput] = useState("");
  const [askMessages, setAskMessages] = useState([]);
  const [askBusy, setAskBusy] = useState(false);
  const [askModel, setAskModel] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [editDirty, setEditDirty] = useState(false);
  const [bodyEditing, setBodyEditing] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const [dragDocId, setDragDocId] = useState("");
  const [dragFolderPath, setDragFolderPath] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [detailMoreOpen, setDetailMoreOpen] = useState(false);
  const [detailMorePos, setDetailMorePos] = useState({ top: 0, left: 0 });
  const detailMoreRef = useRef(null);
  const detailMoreBtnRef = useRef(null);
  const [tocFloatOpen, setTocFloatOpen] = useState(false);
  const [activeHeading, setActiveHeading] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [createName, setCreateName] = useState("我的知识库");
  const [createEmbRef, setCreateEmbRef] = useState("");
  const [embOptions, setEmbOptions] = useState([]);
  const [defaultEmbRef, setDefaultEmbRef] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsKbId, setSettingsKbId] = useState("");
  const [settingsName, setSettingsName] = useState("");
  const [settingsDesc, setSettingsDesc] = useState("");
  const [settingsChatModel, setSettingsChatModel] = useState("");
  const [settingsEmbRef, setSettingsEmbRef] = useState("");
  const [settingsRebind, setSettingsRebind] = useState(false);
  const [settingsSummary, setSettingsSummary] = useState(false);
  const [syncPreviewOpen, setSyncPreviewOpen] = useState(false);
  const [syncPreviewLoading, setSyncPreviewLoading] = useState(false);
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncPreviewPath, setSyncPreviewPath] = useState("");
  const [syncPreviewMode, setSyncPreviewMode] = useState("resync"); // resync | import
  const [syncPruneMissing, setSyncPruneMissing] = useState(true);
  const [syncPreviewError, setSyncPreviewError] = useState("");
  const [chunksPanelOpen, setChunksPanelOpen] = useState(false);
  const syncPreviewGuardRef = useRef(0);
  const folderRef = useRef(null);
  const askListRef = useRef(null);
  const prevParseStatusRef = useRef("");
  const readerBodyRef = useRef(null);

  const notify = useCallback((msg) => {
    setToast(String(msg || ""));
    window.clearTimeout(notify._t);
    notify._t = window.setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => {
    const sync = () => setRoute(parseOwnedRoute());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // Detail keeps the global left nav (no setKnowledgeDetailShellMode immersion).
  // 仅从列表进详情时默认收成图标栏；菜单进「知识库」列表不折叠。
  useEffect(() => {
    syncKnowledgeAsideForDetail(route.view === "detail");
  }, [route.view]);

  useEffect(() => {
    if (!detailMoreOpen) return undefined;
    const place = () => {
      const btn = detailMoreBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const menuW = 200;
      const left = Math.min(
        Math.max(8, r.right - menuW),
        Math.max(8, window.innerWidth - menuW - 8),
      );
      setDetailMorePos({ top: Math.round(r.bottom + 6), left: Math.round(left) });
    };
    place();
    const onPointer = (e) => {
      if (detailMoreRef.current && !detailMoreRef.current.contains(e.target)) {
        setDetailMoreOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setDetailMoreOpen(false);
    };
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [detailMoreOpen]);

  // Load available chat models for the Ask AI model selector
  const [chatModels, setChatModels] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { models = [] } = await api.listModels();
        if (!cancelled) setChatModels(models.filter((m) => m.supportsChat !== false));
      } catch {
        if (!cancelled) setChatModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Knowledge-scope settings (chat model + summary default) drive every
  // "which model actually runs" hint in this page.
  const [kbGlobalSettings, setKbGlobalSettings] = useState(null);
  const reloadKbGlobalSettings = useCallback(async () => {
    try {
      const data = (await api.getOwnedKnowledgeSettings()) || null;
      setKbGlobalSettings(data);
      return data;
    } catch {
      setKbGlobalSettings(null);
      return null;
    }
  }, []);

  const loadBases = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const includeHidden = !!opts?.includeHidden;
      const { takeNavWarm } = await import("../lib/nav-panel-prefetch.js");
      // Hover-warm cache holds the default (non-hidden) list, so only use it for
      // the default view; the "显示已停用" view always refetches.
      let res = includeHidden ? null : takeNavWarm("knowledge:bases");
      if (!res) {
        res = await api.listOwnedKnowledgeBases({ includeHidden });
      }
      const items = res.items || [];
      setBases(items);
      // Prefer server-side documentCount (single query); fall back only if missing.
      const counts = {};
      const needFetch = [];
      for (const b of items.slice(0, 24)) {
        const n = b.documentCount ?? b.document_count;
        if (typeof n === "number" && Number.isFinite(n)) {
          counts[b.id] = n;
        } else {
          needFetch.push(b);
        }
      }
      if (needFetch.length) {
        await Promise.all(
          needFetch.map(async (b) => {
            try {
              const d = await api.listOwnedKnowledgeDocuments(b.id);
              counts[b.id] = (d.items || []).length;
            } catch {
              counts[b.id] = 0;
            }
          })
        );
      }
      setDocCounts(counts);
    } catch (e) {
      notify(e?.message || "加载知识库失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  const loadDocs = useCallback(async (kbId) => {
    if (!kbId) {
      setDocs([]);
      setFolders([]);
      setKbTags([]);
      setJobStats(null);
      setJobItems([]);
      return;
    }
    try {
      const [res, tagsRes, jobsRes] = await Promise.all([
        api.listOwnedKnowledgeDocuments(kbId),
        api.listOwnedKnowledgeTags(kbId).catch(() => ({ items: [] })),
        // activeOnly: ledger of queued/running; stats still includes error counts + error rows
        api.listOwnedKnowledgeJobs(kbId, { limit: 80, activeOnly: true }).catch(() => ({
          stats: null,
          items: [],
        })),
      ]);
      setDocs(dedupeDocsByRelPath(res.items || []));
      setFolders(res.folders || []);
      setKbTags(tagsRes.items || []);
      setJobStats(jobsRes.stats || null);
      setJobItems(Array.isArray(jobsRes.items) ? jobsRes.items : []);
      // list_documents soft-deletes path duplicates; refresh hub counts.
      void loadBases({ includeHidden: showHidden });
    } catch (e) {
      notify(e?.message || "加载文档失败");
    }
  }, [notify, loadBases, showHidden]);

  useEffect(() => {
    loadBases({ includeHidden: showHidden });
  }, [loadBases, showHidden]);

  useEffect(() => {
    reloadKbGlobalSettings();
  }, [reloadKbGlobalSettings]);

  /** 停用/忽略内置库：隐藏后不在默认列表展示（仍随版本同步，可随时恢复）。 */
  async function setBaseHidden(base, nextHidden) {
    const kbId = typeof base === "string" ? base : base?.id;
    if (!kbId) return;
    const name = typeof base === "string" ? "" : base?.name || "";
    if (
      nextHidden &&
      !window.confirm(`停用「${name || kbId}」？停用后不在列表中显示，可随时在「显示已停用」中恢复。`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.updateOwnedKnowledgeBase(kbId, { hidden: !!nextHidden });
      await loadBases({ includeHidden: showHidden });
      if (nextHidden && selectedId === kbId) goOwnedList();
      notify(nextHidden ? "已停用，可在「显示已停用」中恢复" : "已恢复显示");
    } catch (e) {
      notify(e?.message || (nextHidden ? "停用失败" : "恢复失败"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadDocs(selectedId);
    setHits([]);
    setQuery("");
    setAskInput("");
    setAskMessages([]);
    setRelatedDocs([]);
    setWikiPages([]);
    setWikiPage(null);
    setWikiSlug("");
    setGraphData({ nodes: [], edges: [] });
    setTab("docs");
    setRightMode("reader");
    setChunksPanelOpen(false);
    if (!selectedId) return;
    // Detail payload includes syncSourcePath; list rows can lag after import.
    void api
      .getOwnedKnowledgeBase(selectedId)
      .then((base) => {
        if (!base?.id) return;
        setBases((prev) => {
          const i = prev.findIndex((b) => b.id === base.id);
          if (i < 0) return [...prev, base];
          const next = prev.slice();
          next[i] = { ...next[i], ...base };
          return next;
        });
      })
      .catch(() => {});
  }, [selectedId, loadDocs]);

  const loadWiki = useCallback(async (kbId) => {
    if (!kbId) return;
    try {
      const res = await api.listOwnedWikiPages(kbId);
      setWikiPages(res.items || []);
    } catch (e) {
      notify(e?.message || "加载 Wiki 失败");
    }
  }, [notify]);

  const openWikiPage = useCallback(async (kbId, slug) => {
    if (!kbId || !slug) return;
    try {
      const page = await api.getOwnedWikiPage(kbId, slug);
      setWikiSlug(slug);
      setWikiPage(page);
      setWikiDraft(page.bodyMd || "");
    } catch (e) {
      notify(e?.message || "打开 Wiki 页失败");
    }
  }, [notify]);

  const loadGraph = useCallback(async (kbId, kind = graphKind) => {
    if (!kbId) return;
    try {
      let g;
      if (kind === "entity") {
        g = await api.getOwnedKgGraph(kbId);
      } else if (kind === "documents") {
        g = await api.getOwnedKnowledgeDocGraph(kbId, {
          center: selectedDocId || undefined,
          depth: 2,
        });
      } else {
        g = await api.getOwnedWikiGraph(kbId, { depth: 2 });
      }
      setGraphData({ nodes: g.nodes || [], edges: g.edges || [], kind: g.kind || kind });
    } catch (e) {
      notify(e?.message || "加载图谱失败");
    }
  }, [notify, graphKind, selectedDocId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    if (tab === "wiki") loadWiki(selectedId);
    if (KB_GRAPH_UI_ENABLED && tab === "graph") loadGraph(selectedId);
    return undefined;
  }, [tab, selectedId, loadWiki, loadGraph]);

  // 图谱 UI 关闭时，避免残留 hash/状态停在 graph 空页。
  useEffect(() => {
    if (!KB_GRAPH_UI_ENABLED && tab === "graph") setTab("docs");
  }, [tab]);

  const [preparedGraph, setPreparedGraph] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setPreparedGraph(null);
    if (
      !KB_GRAPH_UI_ENABLED ||
      tab !== "graph" ||
      !(graphData.nodes?.length || graphData.edges?.length)
    ) {
      return undefined;
    }
    void import("../react/components/KnowledgeForceGraph.jsx")
      .then((m) => {
        if (cancelled) return;
        setPreparedGraph(
          m.prepareForceGraphData(graphData.nodes, graphData.edges, { compact: true }),
        );
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [tab, graphData]);

  // When jobs finish (or KB changes), keep the ledger closed — corner chip reappears next run.
  useEffect(() => {
    setSyncPopupDismissed(true);
  }, [selectedId]);

  // Poll while any doc is pending/processing
  useEffect(() => {
    const need =
      docs.some((d) => d.parseStatus === "pending" || d.parseStatus === "processing") ||
      (jobStats && (jobStats.active > 0 || jobStats.pendingDocs > 0));
    if (!need || !selectedId) return undefined;
    const id = window.setInterval(() => loadDocs(selectedId), 2000);
    return () => window.clearInterval(id);
  }, [docs, selectedId, loadDocs, jobStats]);

  async function openKbLocation() {
    if (!selectedId) return;
    const sourcePath = String(selected?.syncSourcePath || "").trim();
    const storageDir = String(selected?.resolvedStorageDir || selected?.storageDir || "").trim();
    if (!sourcePath && !storageDir) {
      notify("该知识库还没有可打开的目录");
      return;
    }
    // Prefer the user's source folder; fall back to the KB data dir when the
    // source is missing (e.g. the imported folder was moved or deleted).
    const candidates = [sourcePath, storageDir].filter((p, i, a) => p && a.indexOf(p) === i);
    let lastErr = "";
    for (const target of candidates) {
      try {
        await api.revealPathInFileManager(target);
        notify(
          target === sourcePath
            ? `已在文件管理器中打开源目录：${sourcePath}`
            : `已在文件管理器中打开库目录：${storageDir}`
        );
        return;
      } catch (e) {
        lastErr = e?.message || String(e || "");
      }
    }
    notify(lastErr || "打开目录失败（仅桌面端可用）");
  }

  async function openSyncPreview({ mode = "resync", path = "" } = {}) {
    if (!selectedId) return;
    let sourcePath = String(path || selected?.syncSourcePath || "").trim();
    let sourceType = String(selected?.syncSourceType || "").trim();
    // List rows can lag; refresh detail so remembered sync source is reliable.
    if (mode === "resync" && (!sourcePath || !sourceType)) {
      try {
        const fresh = await api.getOwnedKnowledgeBase(selectedId);
        if (fresh?.id) {
          sourcePath = String(fresh.syncSourcePath || sourcePath || "").trim();
          sourceType = String(fresh.syncSourceType || sourceType || "").trim();
          setBases((prev) => {
            const i = prev.findIndex((b) => b.id === fresh.id);
            if (i < 0) return [...prev, fresh];
            const next = prev.slice();
            next[i] = { ...next[i], ...fresh };
            return next;
          });
        }
      } catch {
        /* keep whatever we already have */
      }
    }
    if (mode === "resync" && !sourceType && !sourcePath) {
      notify("还没有记住的同步源，请先「选择本地文件夹」");
      return;
    }
    setSyncPreviewMode(mode);
    setSyncPreviewPath(sourcePath);
    setSyncPruneMissing(true);
    setSyncPreview(null);
    setSyncPreviewError("");
    syncPreviewGuardRef.current = Date.now();
    setSyncPreviewOpen(true);
    setSyncPreviewLoading(true);
    try {
      const plan = await api.previewOwnedKnowledgeSync(selectedId, {
        path: sourcePath || undefined,
      });
      setSyncPreview(plan);
      setSyncPreviewError("");
      if (plan?.sourcePath) setSyncPreviewPath(String(plan.sourcePath));
    } catch (e) {
      // Keep the modal open so the failure is visible (closing looked like a flash).
      setSyncPreview(null);
      setSyncPreviewError(e?.message || "无法生成同步清单");
      notify(e?.message || "无法生成同步清单");
    } finally {
      setSyncPreviewLoading(false);
    }
  }

  async function confirmSyncPreview() {
    if (!selectedId || !syncPreview) return;
    setBusy(true);
    try {
      let res;
      if (syncPreviewMode === "import") {
        const path = String(syncPreviewPath || syncPreview.sourcePath || "").trim();
        if (!path) throw new Error("缺少本地文件夹路径");
        res = await api.importOwnedKnowledgeFolder(selectedId, path, {
          pruneMissing: Boolean(syncPruneMissing),
        });
      } else {
        res = await api.resyncOwnedKnowledgeBase(selectedId, {
          pruneMissing: Boolean(syncPruneMissing),
        });
      }
      const fresh = await api.getOwnedKnowledgeBase(selectedId).catch(() => null);
      if (fresh?.id) {
        setBases((prev) => {
          const i = prev.findIndex((b) => b.id === fresh.id);
          if (i < 0) return [...prev, fresh];
          const next = prev.slice();
          next[i] = { ...next[i], ...fresh };
          return next;
        });
      }
      await loadDocs(selectedId);
      await loadBases();
      setSyncPreviewOpen(false);
      setSyncPreview(null);
      notify(
        `${syncPreviewMode === "import" ? "导入" : "再同步"}：新增 ${res.created || 0} · 更新 ${res.updated || 0} · 未变 ${res.unchanged || 0}` +
          `${res.pruned ? ` · 清理 ${res.pruned}` : ""}` +
          `${res.skipped ? ` · 跳过 ${res.skipped}` : ""}`,
      );
    } catch (e) {
      notify(e?.message || "同步失败");
    } finally {
      setBusy(false);
    }
  }

  function resyncRemembered() {
    void openSyncPreview({ mode: "resync" });
  }
  const selected = useMemo(
    () => bases.find((b) => b.id === selectedId) || null,
    [bases, selectedId]
  );

  // 库名挂到客户端全局顶栏（#tauri-main-chrome），不占页面内顶区。
  useEffect(() => {
    if (route.view !== "detail") return undefined;
    const chrome = document.getElementById("tauri-main-chrome");
    const drag = chrome?.querySelector(".tauri-main-chrome-drag");
    if (!chrome || !drag) return undefined;

    let el = document.getElementById("ko-chrome-title");
    if (!el) {
      el = document.createElement("div");
      el.id = "ko-chrome-title";
      el.className = "tauri-main-chrome-kb-title";
      el.setAttribute("data-testid", "ko-page-title");
      drag.appendChild(el);
    }
    el.textContent = selected?.name || "…";
    el.title = selected?.name || "";
    chrome.classList.add("tauri-main-chrome--kb-detail");

    return () => {
      el?.remove();
      chrome.classList.remove("tauri-main-chrome--kb-detail");
    };
  }, [route.view, selected?.name]);

  const settingsBase = useMemo(
    () => bases.find((b) => b.id === settingsKbId) || selected,
    [bases, settingsKbId, selected]
  );

  const docsById = useMemo(() => {
    const map = {};
    for (const d of docs || []) {
      if (d?.id) map[d.id] = d;
    }
    return map;
  }, [docs]);

  const jobLedger = useMemo(() => {
    const running = [];
    const queued = [];
    for (const job of jobItems || []) {
      const st = String(job?.state || "");
      if (st === "running") running.push(job);
      else if (st === "queued") queued.push(job);
    }
    const activeDocIds = new Set(
      [...running, ...queued]
        .map((j) => String(j.docId || j.doc_id || "").trim())
        .filter(Boolean),
    );
    // Docs waiting on parse without an active job yet (orphan pending).
    const pendingDocs = (docs || [])
      .filter((d) => {
        const ps = String(d.parseStatus || "");
        return (ps === "pending" || ps === "processing") && !activeDocIds.has(String(d.id || ""));
      })
      .slice(0, 30);
    return { running, queued, pendingDocs };
  }, [jobItems, docs]);

  const showJobLedger =
    !!jobStats &&
    (jobStats.active > 0 || jobStats.pendingDocs > 0 || jobStats.error > 0);

  const jobChipBusy = !!(jobStats && (jobStats.active > 0 || jobStats.pendingDocs > 0));
  const jobChipLabel = useMemo(() => {
    if (!jobStats) return "";
    if (jobChipBusy) {
      const running = jobLedger.running[0];
      const pct = Number(running?.progress?.percent);
      const pctText = Number.isFinite(pct) && pct > 0 ? ` · ${Math.round(pct)}%` : "";
      const name = running ? jobDocLabel(running, docsById) : "";
      if (name && pctText) return `索引中 ${name}${pctText}`;
      return `索引中 · 排队 ${jobStats.queued || 0} · 进行 ${jobStats.running || 0}`;
    }
    if (jobStats.error) return `索引失败 ${jobStats.error} 项 · 点开查看`;
    return "处理进度";
  }, [jobStats, jobChipBusy, jobLedger.running, docsById]);

  // Current embedding binding of the base being edited (ref prefers model name).
  const settingsCurrentRef = String(
    settingsBase?.embeddingModelRef || settingsBase?.embeddingModel || ""
  ).trim();

  // Dropdown options; always surface the current binding so the select never
  // falls back to an unrelated first option when it is not in the model catalog.
  const settingsEmbOptions = useMemo(() => {
    const opts = Array.isArray(embOptions) ? embOptions : [];
    if (!settingsCurrentRef) return opts;
    if (opts.some((o) => String(o.value) === settingsCurrentRef)) return opts;
    return [
      { value: settingsCurrentRef, label: `${settingsCurrentRef}（当前 · 不在模型列表中）` },
      ...opts,
    ];
  }, [embOptions, settingsCurrentRef]);

  const settingsEmbChanged = useMemo(() => {
    const next = String(settingsEmbRef || "").trim();
    return !!(next && next !== settingsCurrentRef);
  }, [settingsEmbRef, settingsCurrentRef]);

  const settingsChatChanged = useMemo(() => {
    const next = String(settingsChatModel || "").trim();
    const prev = String(kbGlobalSettings?.chatModel || "").trim();
    return next !== prev;
  }, [settingsChatModel, kbGlobalSettings?.chatModel]);

  const settingsDirty = useMemo(() => {
    if (!settingsBase) return false;
    const name = String(settingsName || "").trim();
    const desc = String(settingsDesc || "").trim();
    return (
      name !== String(settingsBase.name || "").trim() ||
      desc !== String(settingsBase.description || "").trim() ||
      settingsEmbChanged ||
      settingsChatChanged ||
      settingsSummary !== Boolean(settingsBase.summaryEnabled)
    );
  }, [
    settingsBase,
    settingsName,
    settingsDesc,
    settingsEmbChanged,
    settingsChatChanged,
    settingsSummary,
  ]);

  // Hub Insight → open first base in Ask mode (optional pending prompt)
  useEffect(() => {
    if (route.view !== "detail" || !selected) return;
    let openAsk = false;
    let pending = "";
    try {
      openAsk = sessionStorage.getItem("ko-open-ask") === "1";
      pending = sessionStorage.getItem("ko-pending-ask") || "";
      if (openAsk) sessionStorage.removeItem("ko-open-ask");
      if (pending) sessionStorage.removeItem("ko-pending-ask");
    } catch {
      /* ignore */
    }
    if (!openAsk) return;
    setTab("docs");
    setRightMode("ask");
    if (pending) setAskInput(pending);
  }, [route.view, selected?.id]);

  const filteredBases = useMemo(() => {
    const q = listFilter.trim().toLowerCase();
    if (!q) return bases;
    return bases.filter(
      (b) =>
        String(b.name || "")
          .toLowerCase()
          .includes(q) ||
        String(b.description || "")
          .toLowerCase()
          .includes(q)
    );
  }, [bases, listFilter]);

  const filteredDocs = useMemo(() => {
    const q = docFilter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((doc) =>
      [doc.title, doc.fileName, doc.folderPath, doc.summaryText]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [docs, docFilter]);

  const docTree = useMemo(() => buildDocTree(filteredDocs, folders), [filteredDocs, folders]);

  const recentDocs = useMemo(
    () => [...docs].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))).slice(0, 4),
    [docs],
  );

  const selectedDoc = useMemo(
    () => docs.find((d) => d.id === selectedDocId) || null,
    [docs, selectedDocId]
  );

  /** Bound local folder for V4 WorkspaceFileTree (same component as chat workspace-browse). */
  const localTreeRoot = useMemo(
    () => String(selected?.syncSourcePath || "").trim(),
    [selected?.syncSourcePath],
  );

  // Only force-reveal in the tree for non-tree opens (search / citation).
  // Binding every selectedDoc → activePreviewPath re-runs ancestor loadDirectory
  // (and empty-dir deep scans) on every click, which feels like a multi-second stall.
  const [treeRevealPath, setTreeRevealPath] = useState(null);

  function absPathForDoc(doc) {
    if (!localTreeRoot || !doc) return null;
    const folder = String(doc.folderPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const name = String(doc.fileName || "").trim();
    if (!name) return null;
    const rel = folder ? `${folder}/${name}` : name;
    return `${localTreeRoot.replace(/[/\\]+$/, "")}/${rel}`.replace(/\\/g, "/");
  }

  function openDocFromTreePath(absPath) {
    const hit = findOwnedDocByWorkspacePath(docs, localTreeRoot, absPath);
    if (hit?.id) {
      // Tree already highlighted the row — skip activePreviewPath expand/scan.
      setTreeRevealPath(null);
      setSelectedDocId(hit.id);
      setTab("docs");
      setRightMode("reader");
      return;
    }
    notify("该文件尚未入库索引；可在上方「再同步」后重试");
  }

  useEffect(() => {
    const paths = new Set();
    const walk = (n) => {
      n.children.forEach((c) => {
        paths.add(c.path);
        walk(c);
      });
    };
    walk(docTree);
    setExpandedFolders(paths);
  }, [selectedId, docs.map((d) => d.id).join("|")]);

  useEffect(() => {
    if (selectedDocId && !docs.some((d) => d.id === selectedDocId)) {
      setSelectedDocId("");
      setDocContent(null);
    }
  }, [docs, selectedDocId]);

  useEffect(() => {
    if (!selectedDocId) {
      setDocContent(null);
      setPdfObjectUrl("");
      setPdfLoadFailed(false);
      setRelatedDocs([]);
      setDocLinks(null);
      setBodyEditing(false);
      setEditDirty(false);
      return undefined;
    }
    setBodyEditing(false);
    setEditDirty(false);
    setDocLinks(null);
    let cancelled = false;
    setDocContentLoading(true);
    (async () => {
      try {
        // Content first — don't block the reader on links / related graph.
        const payload = await api.getOwnedKnowledgeDocumentContent(selectedDocId);
        if (cancelled) return;
        setDocContent(payload);
        setEditDraft(payload?.content || "");
        setEditDirty(false);
        setDocContentLoading(false);
        const links = await api.getOwnedKnowledgeDocumentLinks(selectedDocId).catch(() => null);
        if (!cancelled) setDocLinks(links);
      } catch (e) {
        if (!cancelled) {
          setDocContent(null);
          setDocLinks(null);
          setDocContentLoading(false);
          notify(e?.message || "加载文档内容失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDocId, notify, docContentEpoch]);

  useEffect(() => {
    setChunksPanelOpen(false);
  }, [selectedDocId]);

  // After parse finishes (pending/processing → completed), refresh reader body.
  useEffect(() => {
    if (!selectedDocId) {
      prevParseStatusRef.current = "";
      return;
    }
    const st = String(selectedDoc?.parseStatus || "");
    const prev = prevParseStatusRef.current;
    if (prev && (prev === "pending" || prev === "processing") && st === "completed") {
      setDocContentEpoch((n) => n + 1);
    }
    prevParseStatusRef.current = st;
  }, [selectedDocId, selectedDoc?.parseStatus]);

  const activeFileName = (docContent || selectedDoc)?.fileName || "";
  const activeIsPdf = isPdfName(activeFileName);
  const canEditBody = useMemo(() => {
    const name = String(activeFileName || "").toLowerCase();
    const source = String(docContent?.source || "");
    if (activeIsPdf) return false;
    if (/\.(docx?|pptx?|xlsx?)$/i.test(name)) return false;
    return source === "raw" || /\.(md|markdown|mdx|txt)$/i.test(name);
  }, [activeFileName, activeIsPdf, docContent?.source]);

  const readerMarkdown = bodyEditing ? editDraft : docContent?.content || "";
  const docHeadings = useMemo(
    () => parseMarkdownHeadings(readerMarkdown),
    [readerMarkdown]
  );
  useReaderMarkdownEnhance(readerBodyRef, `${selectedDocId}:${readerMarkdown.length}:${bodyEditing}`);

  useEffect(() => {
    setTocFloatOpen(false);
    setActiveHeading("");
  }, [selectedDocId]);

  useEffect(() => {
    if (!selectedDocId || !activeIsPdf) {
      setPdfObjectUrl("");
      setPdfLoadFailed(false);
      return undefined;
    }
    let cancelled = false;
    let created = "";
    setPdfLoadFailed(false);
    (async () => {
      try {
        const url = await api.fetchOwnedKnowledgeDocumentFileObjectUrl(selectedDocId);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        created = url;
        setPdfObjectUrl(url);
      } catch {
        if (!cancelled) {
          setPdfObjectUrl("");
          setPdfLoadFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setPdfObjectUrl("");
    };
  }, [selectedDocId, activeIsPdf]);

  // Poll document while summary is generating
  useEffect(() => {
    const st = String((docContent || selectedDoc)?.summaryStatus || "");
    if (!selectedDocId || (st !== "pending" && st !== "processing")) return undefined;
    const id = window.setInterval(async () => {
      try {
        const d = await api.getOwnedKnowledgeDocument(selectedDocId);
        setDocContent((prev) => (prev ? { ...prev, ...d } : d));
        setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...d } : x)));
        if (["completed", "failed", "skipped"].includes(String(d.summaryStatus || ""))) {
          window.clearInterval(id);
          setSummaryBusy(false);
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [selectedDocId, (docContent || selectedDoc)?.summaryStatus]);

  // Related knowledge via title search, fallback to keyword (exclude current)
  useEffect(() => {
    if (!selectedId || !selectedDocId) {
      setRelatedDocs([]);
      return undefined;
    }
    const title = String(
      (docContent || selectedDoc)?.title || (docContent || selectedDoc)?.fileName || ""
    ).trim();
    if (!title) {
      setRelatedDocs([]);
      return undefined;
    }
    let cancelled = false;
    const pickRelated = (hits) => {
      const seen = new Set();
      const items = [];
      for (const h of hits || []) {
        if (!h.docId || h.docId === selectedDocId || seen.has(h.docId)) continue;
        seen.add(h.docId);
        items.push({
          docId: h.docId,
          title: h.title || h.fileName || "相关文档",
          snippet: String(h.content || "").slice(0, 120),
        });
        if (items.length >= 3) break;
      }
      return items;
    };
    (async () => {
      try {
        let items = [];
        const titleRes = await api.searchOwnedKnowledge(selectedId, {
          query: title,
          mode: "title",
          topK: 8,
        });
        items = pickRelated(titleRes.items);
        if (!items.length) {
          const kw = await api.searchOwnedKnowledge(selectedId, {
            query: title,
            mode: "keyword",
            topK: 8,
          });
          items = pickRelated(kw.items);
        }
        if (!cancelled) setRelatedDocs(items);
      } catch {
        if (!cancelled) setRelatedDocs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedDocId, (docContent || selectedDoc)?.title, (docContent || selectedDoc)?.fileName]);

  useEffect(() => {
    if (askListRef.current) {
      askListRef.current.scrollTop = askListRef.current.scrollHeight;
    }
  }, [askMessages, askBusy]);

  function toggleFolder(path) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const loadEmbeddingOptions = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([
        api.listModels(),
        api.getOwnedKnowledgeSettings().catch(() => ({})),
      ]);
      const models = Array.isArray(list?.models) ? list.models : [];
      const opts = collectEmbeddingModelOptions(models);
      setEmbOptions(opts);
      const effective = String(
        settings?.effectiveEmbeddingModel || settings?.defaultEmbeddingModel || "",
      );
      setDefaultEmbRef(effective);
      return { opts, effective };
    } catch {
      setEmbOptions([]);
      return { opts: [], effective: "" };
    }
  }, []);

  async function openCreateBase() {
    const { opts, effective } = await loadEmbeddingOptions();
    setCreateName("我的知识库");
    setCreateEmbRef(effective || opts[0]?.value || "");
    setCreateOpen(true);
  }

  async function submitCreateBase() {
    const name = String(createName || "").trim();
    if (!name) {
      notify("请填写知识库名称");
      return;
    }
    if (!embOptions.length) {
      notify("请先在 设置 → 模型 → 向量模型 中添加向量模型");
      return;
    }
    setBusy(true);
    try {
      const base = await api.createOwnedKnowledgeBase({
        name,
        embeddingModelRef: createEmbRef || undefined,
      });
      setCreateOpen(false);
      await loadBases();
      goOwnedDetail(base.id);
      notify("已创建知识库");
    } catch (e) {
      notify(e?.message || "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function openBaseSettings(baseOrNull) {
    // Guard: callers may pass a click event (onClick={openBaseSettings}); only
    // accept a real base object, otherwise fall back to the selected base.
    const base = baseOrNull && baseOrNull.id ? baseOrNull : selected;
    if (!base) return;
    const { opts } = await loadEmbeddingOptions();
    const current =
      base.embeddingModelRef ||
      opts.find((o) => o.value === base.embeddingModel)?.value ||
      base.embeddingModel ||
      defaultEmbRef ||
      "";
    setSettingsKbId(base.id);
    setSettingsName(base.name || "");
    setSettingsDesc(base.description || "");
    setSettingsEmbRef(current);
    setSettingsRebind(false);
    setSettingsSummary(Boolean(base.summaryEnabled));
    setSettingsOpen(true);
    const global = await reloadKbGlobalSettings();
    setSettingsChatModel(String(global?.chatModel || "").trim());
  }

  async function submitBaseSettings() {
    const kbId = settingsKbId || selectedId;
    if (!kbId) return;
    const base = bases.find((b) => b.id === kbId) || settingsBase;
    const name = String(settingsName || "").trim();
    if (!name) {
      notify("请填写知识库名称");
      return;
    }
    const description = String(settingsDesc || "").trim();
    const prev = String(base?.embeddingModelRef || base?.embeddingModel || "").trim();
    const next = String(settingsEmbRef || "").trim();
    const embChanged = !!(next && next !== prev);
    const chatNext = String(settingsChatModel || "").trim();
    const chatPrev = String(kbGlobalSettings?.chatModel || "").trim();
    const chatChanged = chatNext !== chatPrev;
    const nameChanged = name !== String(base?.name || "").trim();
    const descChanged = description !== String(base?.description || "").trim();
    const summaryChanged = settingsSummary !== Boolean(base?.summaryEnabled);

    if (embChanged) {
      const ok = window.confirm(
        `更换向量模型将清空现有向量并按「${next}」整库重建索引，是否继续？`,
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      let res = null;
      if (chatChanged) {
        await api.setOwnedKnowledgeSettings({ chatModel: chatNext || null });
      }

      const metaPatch = {};
      if (nameChanged) metaPatch.name = name;
      if (descChanged) metaPatch.description = description;
      if (summaryChanged) metaPatch.summaryEnabled = settingsSummary;

      // Only touch embedding binding when it actually changed; a metadata-only
      // save must never trigger a reindex. In-place rebuild is a separate action.
      if (Object.keys(metaPatch).length || embChanged) {
        res = await api.updateOwnedKnowledgeBase(kbId, {
          ...metaPatch,
          ...(embChanged ? { embeddingModelRef: next } : {}),
        });
      }

      setSettingsOpen(false);
      setSettingsKbId("");
      await loadBases();
      await reloadKbGlobalSettings();
      if (res?.reindexQueued) {
        notify(`正在向量化 ${res.reindexQueued} 篇文档…`);
      } else {
        notify("知识库设置已保存");
      }
    } catch (e) {
      notify(e?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function rebuildVectors() {
    const kbId = settingsKbId || selectedId;
    const base = bases.find((b) => b.id === kbId) || settingsBase;
    if (!kbId) return;
    // In-place rebuild: keep the current binding, do NOT pass embeddingModelRef.
    const current = String(base?.embeddingModelRef || base?.embeddingModel || "").trim();
    if (!current) {
      notify("当前知识库尚未绑定向量模型，请先在下方选择模型并保存。");
      return;
    }
    const ok = window.confirm(
      base?.embeddingDim
        ? `将按当前模型「${current}」清空并整库重建索引（不更换模型），是否继续？`
        : `将按当前模型「${current}」为该库建立索引，是否继续？`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.reindexOwnedKnowledgeBase(kbId, { force: true });
      setSettingsOpen(false);
      setSettingsKbId("");
      await loadBases();
      notify(
        res?.reindexQueued
          ? `已排队向量化 ${res.reindexQueued} 篇文档`
          : "已提交向量化任务",
      );
    } catch (e) {
      notify(e?.message || "向量化失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteBase(kbId, name) {
    const target = bases.find((b) => b.id === kbId);
    if (target?.builtin) {
      notify("系统内置知识库不可删除");
      return;
    }
    if (!window.confirm(`删除知识库「${name || kbId}」？文档与索引将一并移除。`)) return;
    setBusy(true);
    try {
      await api.deleteOwnedKnowledgeBase(kbId);
      if (selectedId === kbId) goOwnedList();
      await loadBases();
      notify("已删除知识库");
    } catch (e) {
      notify(e?.message || "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function pickAndImportLocalFolder() {
    if (!selectedId) return;
    // Desktop: plugin-dialog → sync-preview checklist → import-folder.
    const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
    if (isTauri) {
      try {
        const dlg = await import("@tauri-apps/plugin-dialog");
        const picked = await dlg.open({
          directory: true,
          multiple: false,
          title: "选择要同步到知识库的本地文件夹",
        });
        const path = Array.isArray(picked) ? picked[0] : picked;
        if (!path) return;
        await openSyncPreview({ mode: "import", path: String(path) });
      } catch (e) {
        notify(e?.message || "选择本地文件夹失败");
      }
      return;
    }
    // Web fallback: browser directory picker (upserts; no disk sync source).
    folderRef.current?.click();
  }

  async function onPickFolderFiles(fileList) {
    if (!selectedId || !fileList?.length) return;
    setBusy(true);
    try {
      let uploaded = 0;
      let skipped = 0;
      for (const file of Array.from(fileList)) {
        const rel = file.webkitRelativePath || file.name;
        if (shouldSkipKnowledgeRelPath(rel)) {
          skipped += 1;
          continue;
        }
        const folderPath = folderPathFromRelative(rel);
        try {
          await api.uploadOwnedKnowledgeDocument(selectedId, file, folderPath);
          uploaded += 1;
        } catch (e) {
          const msg = String(e?.message || e || "");
          if (/unsupported file type/i.test(msg)) {
            skipped += 1;
            continue;
          }
          throw e;
        }
      }
      await loadDocs(selectedId);
      await loadBases();
      if (uploaded === 0) {
        notify(
          skipped
            ? `没有可导入的文件（已跳过 ${skipped} 个压缩包/隐藏/临时文件）`
            : "没有可导入的文件",
        );
      } else {
        notify(
          `已从本地文件夹导入 ${uploaded} 个文件，正在索引…` +
            (skipped ? `（已跳过 ${skipped} 个）` : ""),
        );
      }
    } catch (e) {
      notify(e?.message || "导入本地文件夹失败");
    } finally {
      setBusy(false);
      if (folderRef.current) folderRef.current.value = "";
    }
  }

  async function submitManual() {
    if (!selectedId || !manualTitle.trim() || !manualBody.trim()) return;
    setBusy(true);
    try {
      await api.createOwnedKnowledgeManual(selectedId, {
        title: manualTitle.trim(),
        content: manualBody,
      });
      setManualOpen(false);
      setManualTitle("");
      setManualBody("");
      await loadDocs(selectedId);
      notify("已写入笔记并开始索引");
    } catch (e) {
      notify(e?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!selectedId || !query.trim()) return;
    setBusy(true);
    try {
      const tags = tagFilter
        .split(/[,，\s]+/)
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean);
      const res = await api.searchOwnedKnowledge(selectedId, {
        query: query.trim(),
        mode: searchMode || "hybrid",
        topK: 8,
        tags,
      });
      setHits(res.items || []);
      if (res.degraded) notify("语义索引未就绪，已降级为关键词检索");
    } catch (e) {
      notify(e?.message || "检索失败");
    } finally {
      setBusy(false);
    }
  }

  async function runAsk(rawQuery) {
    const q = String(rawQuery ?? askInput).trim();
    if (!selectedId || !q || askBusy) return;
    setAskBusy(true);
    setAskInput("");
    const userMsg = { id: `u_${Date.now()}`, role: "user", content: q };
    setAskMessages((prev) => [...prev, userMsg]);
    try {
      const res = await api.askOwnedKnowledge(selectedId, {
        query: q,
        docId: selectedDocId || undefined,
        topK: 6,
        modelName: askModel || undefined,
      });
      setAskMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: "assistant",
          content: res.answer || "",
          citations: res.citations || [],
          degraded: !!res.degraded,
        },
      ]);
      if (res.degraded) notify("检索已降级或模型回退，回答仅供参考");
    } catch (e) {
      setAskMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: "assistant",
          content: e?.message || "提问失败",
          citations: [],
          error: true,
        },
      ]);
    } finally {
      setAskBusy(false);
    }
  }

  async function generateOverview(force = false) {
    if (!selectedDocId || summaryBusy) return;
    setSummaryBusy(true);
    try {
      const res = await api.enqueueOwnedKnowledgeDocumentSummary(selectedDocId, { force });
      if (res.summaryText && !res.queued) {
        setDocContent((prev) =>
          prev
            ? { ...prev, summaryText: res.summaryText, summaryStatus: res.status || "completed" }
            : prev
        );
        setSummaryBusy(false);
        notify("已有知识概览");
        return;
      }
      notify(force ? "正在重新生成概览…" : "已开始生成知识概览…");
      const d = await api.getOwnedKnowledgeDocument(selectedDocId);
      setDocContent((prev) => (prev ? { ...prev, ...d } : d));
      setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...d } : x)));
    } catch (e) {
      setSummaryBusy(false);
      notify(e?.message || "生成概览失败");
    }
  }

  function openDocFromCitation(docId) {
    if (!docId) return;
    const doc = docs.find((d) => d.id === docId);
    const reveal = absPathForDoc(doc);
    if (reveal) setTreeRevealPath(reveal);
    setSelectedDocId(docId);
    setTab("docs");
    setRightMode("reader");
  }

  async function removeDoc(docId) {
    if (!window.confirm("删除该文档？")) return;
    try {
      await api.deleteOwnedKnowledgeDocument(docId);
      await loadDocs(selectedId);
    } catch (e) {
      notify(e?.message || "删除失败");
    }
  }

  async function saveDocContent() {
    if (!selectedDocId || !canEditBody || savingDoc) return;
    setSavingDoc(true);
    try {
      await api.updateOwnedKnowledgeDocumentContent(selectedDocId, {
        content: editDraft,
        title: (docContent || selectedDoc)?.title || undefined,
      });
      setEditDirty(false);
      setBodyEditing(false);
      setDocContentEpoch((n) => n + 1);
      await loadDocs(selectedId);
      notify("已保存并重新索引");
    } catch (e) {
      notify(e?.message || "保存失败");
    } finally {
      setSavingDoc(false);
    }
  }

  async function createFolderAt(parentPath = "") {
    if (!selectedId) return;
    const name = window.prompt(parentPath ? `在「${parentPath}」下新建文件夹` : "新建文件夹名称", "新文件夹");
    if (!name?.trim()) return;
    try {
      const res = await api.createOwnedKnowledgeFolder(selectedId, {
        parentPath: parentPath || "",
        path: name.trim(),
      });
      await loadDocs(selectedId);
      if (res.path) {
        setExpandedFolders((prev) => new Set([...prev, res.path, parentPath].filter(Boolean)));
      }
      notify(`已创建文件夹 ${res.path || name}`);
    } catch (e) {
      notify(e?.message || "创建文件夹失败");
    }
  }

  async function renameFolderAt(path, currentName) {
    if (!selectedId || !path) return;
    const next = window.prompt("重命名文件夹", currentName || path.split("/").pop());
    if (!next?.trim()) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const toPath = parent ? `${parent}/${next.trim()}` : next.trim();
    if (toPath === path) return;
    try {
      await api.renameOwnedKnowledgeFolder(selectedId, { fromPath: path, toPath });
      await loadDocs(selectedId);
      notify("已重命名文件夹");
    } catch (e) {
      notify(e?.message || "重命名失败");
    }
  }

  async function deleteFolderAt(path) {
    if (!selectedId || !path) return;
    const moveUp = window.confirm(
      `删除文件夹「${path}」？\n\n确定：文档上移到父级\n取消：再问是否连文档一起删`
    );
    if (!moveUp) {
      const wipe = window.confirm(`是否连同「${path}」内文档一并删除？不可恢复。`);
      if (!wipe) return;
      try {
        await api.deleteOwnedKnowledgeFolder(selectedId, path, "delete_docs");
        await loadDocs(selectedId);
        notify("已删除文件夹及文档");
      } catch (e) {
        notify(e?.message || "删除失败");
      }
      return;
    }
    try {
      await api.deleteOwnedKnowledgeFolder(selectedId, path, "move_up");
      await loadDocs(selectedId);
      notify("已删除文件夹，文档已上移");
    } catch (e) {
      notify(e?.message || "删除失败");
    }
  }

  async function moveDocToFolder(doc) {
    if (!selectedId || !doc?.id) return;
    const folderList = (folders || []).map((f) => f.path).filter(Boolean);
    const hint = folderList.length
      ? `可选：\n(空=根目录)\n${folderList.slice(0, 30).join("\n")}`
      : "输入目标文件夹路径（空=根目录）";
    const target = window.prompt(`移动「${doc.title || doc.fileName}」到文件夹\n${hint}`, doc.folderPath || "");
    if (target === null) return;
    try {
      await api.moveOwnedKnowledgeDocument(doc.id, String(target).trim());
      await loadDocs(selectedId);
      notify("已移动文档");
    } catch (e) {
      notify(e?.message || "移动失败");
    }
  }

  async function handleDropDoc({ docId, folderPath, beforeDocId }) {
    if (!selectedId || !docId) return;
    try {
      if (beforeDocId) {
        await api.moveOwnedKnowledgeDocument(docId, undefined, { beforeDocId });
      } else {
        await api.moveOwnedKnowledgeDocument(docId, folderPath == null ? "" : folderPath);
      }
      await loadDocs(selectedId);
      setDragDocId("");
    } catch (e) {
      notify(e?.message || "拖拽移动失败");
    }
  }

  async function handleDropFolder({ fromPath, parentPath }) {
    if (!selectedId || !fromPath) return;
    const parent = parentPath == null ? "" : String(parentPath);
    if (parent === fromPath || parent.startsWith(`${fromPath}/`)) {
      notify("不能移入自身或子文件夹");
      setDragFolderPath("");
      return;
    }
    try {
      await api.moveOwnedKnowledgeFolder(selectedId, fromPath, parent);
      await loadDocs(selectedId);
      if (parent) {
        const leaf = fromPath.split("/").pop();
        const newPath = `${parent}/${leaf}`;
        setExpandedFolders((prev) => new Set([...prev, parent, newPath]));
      }
      setDragFolderPath("");
      notify(parent ? `已移入「${parent}」` : "已移到根目录");
    } catch (e) {
      notify(e?.message || "文件夹移动失败");
      setDragFolderPath("");
    }
  }

  return (
    <div
      className={`knowledge-owned-page${route.view === "list" ? " is-hub" : " is-detail"}`}
      data-testid="knowledge-owned-ui"
    >
      {route.view === "list" ? (
        <KnowledgeHubLayout
          bases={bases}
          busy={busy}
          docCounts={docCounts}
          filteredBases={filteredBases}
          listFilter={listFilter}
          loading={loading}
          onAssistantPrompt={(prompt) => {
            const target = filteredBases[0] || bases[0];
            if (!target) {
              notify("请先新建知识库");
              return;
            }
            goOwnedDetailAsk(target.id, prompt);
          }}
          onCreate={openCreateBase}
          onDelete={deleteBase}
          onFilterChange={setListFilter}
          onOpen={goOwnedDetail}
          onSettings={(base) => openBaseSettings(base)}
          onToggleHidden={setBaseHidden}
          showHidden={showHidden}
          onToggleShowHidden={() => setShowHidden((v) => !v)}
          onRevealDir={(base) => {
            const dir = base.resolvedStorageDir || base.storageDir;
            if (!dir) return;
            api.revealPathInFileManager(dir).catch((err) => {
              console.error("[kb] reveal dir failed", err);
            });
          }}
        />
      ) : (
        <div className="ko-shell ko-shell--full">
          <div className="ko-workspace">
          <input
            hidden
            multiple
            onChange={(e) => onPickFolderFiles(e.target.files)}
            ref={folderRef}
            type="file"
            webkitdirectory=""
          />

          {selected && selected.documentCount > 0 && !selected.vectorized ? (
            <div className="ko-sync-popup is-idle" data-testid="ko-embedding-pending">
              <div className="ko-sync-popup__body">
                <strong>
                  {selected.embeddedChunks > 0 ? "向量索引未完成" : "尚未向量化"}
                </strong>
                <span>
                  {selected.embeddedChunks > 0
                    ? `已完成 ${selected.embeddedChunks}/${selected.totalChunks || 0} 个分块，仍缺 ${selected.missingEmbeddingChunks || 0} 个。`
                    : "库内文档还未按向量模型建索引。可在「库设置」选择 Agent Plan / 向量模型页中的模型，再点「按当前模型建立索引」。"}
                </span>
              </div>
              <button className="ko-btn primary" disabled={busy} onClick={() => openBaseSettings()} type="button">
                打开库设置
              </button>
            </div>
          ) : null}

          {showJobLedger && syncPopupDismissed ? (
            <button
              type="button"
              className={`ko-sync-chip${jobChipBusy ? " is-active" : " is-idle"}`}
              data-testid="ko-sync-chip"
              onClick={() => setSyncPopupDismissed(false)}
              title="打开处理进度"
            >
              <span className="ko-sync-chip__dot" aria-hidden="true" />
              <span className="ko-sync-chip__label">处理进度</span>
              <span className="ko-sync-chip__text">{jobChipLabel}</span>
            </button>
          ) : null}

          {showJobLedger && !syncPopupDismissed ? (
            <div
              className={`ko-sync-popup ko-sync-popup--modal${
                jobStats.active > 0 || jobStats.pendingDocs > 0 ? " is-active" : " is-idle"
              }`}
              data-testid="ko-sync-banner"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ko-sync-banner-title"
              style={{
                position: "fixed",
                top: "50%",
                left: "50%",
                right: "auto",
                bottom: "auto",
                transform: "translate(-50%, -50%)",
                width: "min(900px, calc(100vw - 80px))",
                maxWidth: "none",
                maxHeight: "min(78vh, 640px)",
                alignItems: "stretch",
              }}
            >
              <div className="ko-sync-popup__head">
                <h3 id="ko-sync-banner-title">
                  {jobStats.active > 0 || jobStats.pendingDocs > 0 ? "处理进度" : "处理状态"}
                </h3>
                <button
                  aria-label="关闭"
                  className="ko-sync-popup__close"
                  onClick={() => setSyncPopupDismissed(true)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <div className="ko-sync-popup__body">
                <strong>作业台账</strong>
                <span>
                  {jobStats.active > 0 || jobStats.pendingDocs > 0
                    ? `排队 ${jobStats.queued || 0} · 进行 ${jobStats.running || 0} · 待解析 ${jobStats.pendingDocs || 0}`
                    : `共 ${jobStats.error} 项失败`}
                  {jobStats.error
                    ? `${jobStats.active > 0 || jobStats.pendingDocs > 0 ? " · " : ""}失败 ${jobStats.error}`
                    : null}
                </span>
                {jobStats.error ? (
                  <div className="ko-sync-popup__actions">
                    <button
                      className="ko-btn"
                      disabled={reindexingAll}
                      onClick={async () => {
                        if (!window.confirm(
                          "将对当前知识库全部文档重新触发索引，可能耗时较长，确定继续？",
                        )) return;
                        setReindexingAll(true);
                        try {
                          const res = await api.reindexOwnedKnowledgeBase(selectedId, { force: true });
                          notify(
                            res?.reindexQueued
                              ? `已重新解析整个知识库（${res.reindexQueued} 篇入队）`
                              : "已触发整库重新解析",
                          );
                          await loadDocs(selectedId);
                        } catch (e) {
                          notify(e?.message || "整库重新解析失败");
                        } finally {
                          setReindexingAll(false);
                        }
                      }}
                      type="button"
                      title="对当前知识库全部文档重新触发索引"
                    >
                      {reindexingAll ? "整库重试中…" : "重新解析整个 KB"}
                    </button>
                    <button
                      className="ko-btn"
                      onClick={async () => {
                        try {
                          const res = await api.purgeOrphanOwnedJobs(selectedId);
                          const purged = Number(res?.purged ?? 0);
                          notify(
                            purged > 0
                              ? `已清理 ${purged} 个失效任务`
                              : "没有发现失效任务",
                          );
                          await loadDocs(selectedId);
                        } catch (e) {
                          notify(e?.message || "清理失效任务失败");
                        }
                      }}
                      type="button"
                    >
                      一键清理失效任务
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="ko-sync-ledger">
                {jobLedger.running.length ? (
                  <section className="ko-sync-ledger__section">
                    <h4>进行中 · {jobLedger.running.length}</h4>
                    <ul className="ko-sync-ledger__list">
                      {jobLedger.running.map((job) => {
                        const pct = Number(job?.progress?.percent);
                        return (
                          <li className="ko-sync-job is-running" key={job.id}>
                            <span className={`ko-sync-job__type is-${jobTypeClass(job.type)}`}>
                              {jobTypeLabel(job.type)}
                            </span>
                            <div className="ko-sync-job__main">
                              <strong>{jobDocLabel(job, docsById)}</strong>
                              <span>{jobProgressText(job)}</span>
                              {Number.isFinite(pct) && pct > 0 ? (
                                <div className="ko-sync-job__bar" aria-hidden="true">
                                  <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                                </div>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}

                {jobLedger.queued.length ? (
                  <section className="ko-sync-ledger__section">
                    <h4>
                      排队中 · {jobLedger.queued.length}
                      {(jobStats.queued || 0) > jobLedger.queued.length
                        ? `（显示前 ${jobLedger.queued.length} / 共 ${jobStats.queued}）`
                        : ""}
                    </h4>
                    <ul className="ko-sync-ledger__list">
                      {jobLedger.queued.slice(0, 40).map((job) => (
                        <li className="ko-sync-job is-queued" key={job.id}>
                          <span className={`ko-sync-job__type is-${jobTypeClass(job.type)}`}>
                            {jobTypeLabel(job.type)}
                          </span>
                          <div className="ko-sync-job__main">
                            <strong>{jobDocLabel(job, docsById)}</strong>
                            <span>等待执行</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {jobLedger.pendingDocs.length ? (
                  <section className="ko-sync-ledger__section">
                    <h4>待解析文档 · {jobLedger.pendingDocs.length}</h4>
                    <ul className="ko-sync-ledger__list">
                      {jobLedger.pendingDocs.map((doc) => (
                        <li className="ko-sync-job is-pending" key={doc.id}>
                          <span className="ko-sync-job__type is-index">索引</span>
                          <div className="ko-sync-job__main">
                            <strong>{doc.title || doc.fileName || doc.id}</strong>
                            <span>
                              {String(doc.parseStatus) === "processing" ? "解析中（无活跃任务）" : "等待入队"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {!jobLedger.running.length &&
                !jobLedger.queued.length &&
                !jobLedger.pendingDocs.length &&
                !(jobStats.error && jobStats.errors?.length) ? (
                  <p className="ko-sync-ledger__empty">暂无进行中的作业。</p>
                ) : null}
              </div>

              {jobStats.error && jobStats.errors?.length ? (
                <div className="ko-sync-popup__errors">
                  <h4 className="ko-sync-ledger__fail-title">失败 · {jobStats.errors.length}</h4>
                  {jobStats.errors.map((item) => {
                    const raw = String(item.error_message || "");
                    const headline = jobErrorHeadline(raw);
                    const tail = raw.includes("\n[traceback] ")
                      ? raw.split("\n[traceback] ").slice(1).join("\n[traceback] ")
                      : "";
                    const docId = String(item.docId || "").trim();
                    const rowRetrying = docId && retryingDocs.has(docId);
                    return (
                      <div className="ko-sync-error" key={item.id}>
                        <div className="ko-sync-error__head">
                          <strong>{jobTypeLabel(item.type)}</strong>
                          <span>{jobDocLabel(item, docsById)}</span>
                        </div>
                        <p>{headline}</p>
                        {tail ? (
                          <details>
                            <summary>查看 traceback</summary>
                            <pre className="ko-sync-error__trace">{tail}</pre>
                          </details>
                        ) : null}
                        <small>
                          重试 {item.attempts || 0}/{item.max_attempts || 0} ·{" "}
                          {item.finished_at || item.updated_at || ""}
                        </small>
                        {docId ? (
                          <button
                            className="ko-btn ghost ko-sync-error__retry"
                            disabled={rowRetrying}
                            onClick={async () => {
                              setRetryingDocs((prev) => {
                                const next = new Set(prev);
                                next.add(docId);
                                return next;
                              });
                              try {
                                await api.retryOwnedDocument(selectedId, docId);
                                notify(`已重新加入队列: ${jobDocLabel(item, docsById)}`);
                                await loadDocs(selectedId);
                              } catch (e) {
                                notify(e?.message || "重试失败");
                              } finally {
                                setRetryingDocs((prev) => {
                                  const next = new Set(prev);
                                  next.delete(docId);
                                  return next;
                                });
                              }
                            }}
                            type="button"
                            title="对该文档重新触发索引任务"
                          >
                            {rowRetrying ? "重试中…" : "重试"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          {showJobLedger && !syncPopupDismissed ? (
            <div
              className="ko-sync-overlay"
              onClick={() => setSyncPopupDismissed(true)}
              aria-hidden="true"
            />
          ) : null}

          {!selected && !loading ? (
            <div className="ko-empty">
              未找到该知识库。
              <button className="ko-btn" onClick={goOwnedList} style={{ marginLeft: 8 }} type="button">
                返回列表
              </button>
            </div>
          ) : loading && !selected ? (
            <div className="ko-empty">加载中…</div>
          ) : (
            <div
              className={`ko-detail${catalogOpen ? " is-catalog-open" : ""}${railOpen ? " is-rail-open" : ""}`}
            >
              {(catalogOpen || railOpen) ? (
                <button
                  aria-label="关闭侧栏"
                  className="ko-detail-backdrop"
                  onClick={() => {
                    setCatalogOpen(false);
                    setRailOpen(false);
                  }}
                  type="button"
                />
              ) : null}
              <aside
                className={`ko-catalog${detailMoreOpen ? " is-more-open" : ""}`}
                data-testid="ko-tabs"
              >
                <div className="ko-catalog__head">
                  <span className="ko-catalog__head-icon" aria-hidden="true">
                    <IconFolder />
                  </span>
                  <span className="ko-catalog__head-title">文件</span>
                  <div className="ko-catalog__head-actions">
                    <button
                      className="ko-icon-btn"
                      disabled={busy}
                      onClick={() => createFolderAt("")}
                      title="新建文件夹"
                      type="button"
                    >
                      <svg fill="none" height="16" viewBox="0 0 16 16" width="16" aria-hidden="true">
                        <path
                          d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3.1c.3 0 .58.12.79.33L8.5 4.5H12.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"
                          stroke="currentColor"
                          strokeWidth="1.2"
                        />
                        <path d="M8 7.2v4M6 9.2h4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
                      </svg>
                    </button>
                    <div className="ko-catalog__more" data-tauri-no-drag="" ref={detailMoreRef}>
                      <button
                        ref={detailMoreBtnRef}
                        aria-expanded={detailMoreOpen}
                        aria-haspopup="menu"
                        aria-label="更多操作"
                        className={`ko-more-btn${detailMoreOpen ? " is-open" : ""}`}
                        onClick={() => setDetailMoreOpen((v) => !v)}
                        title="更多"
                        type="button"
                      >
                        <span aria-hidden="true">⋯</span>
                      </button>
                      {detailMoreOpen ? (
                        <div
                          className="ko-more-menu"
                          role="menu"
                          style={{ top: detailMorePos.top, left: detailMorePos.left }}
                        >
                          <button
                            data-testid="ko-back-list"
                            onClick={() => {
                              setDetailMoreOpen(false);
                              goOwnedList();
                            }}
                            role="menuitem"
                            type="button"
                          >
                            返回列表
                          </button>
                          <div className="ko-more-menu__sep" role="separator" />
                          <button
                            className={tab === "docs" && rightMode === "reader" ? "is-active" : ""}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setTab("docs");
                              setRightMode("reader");
                            }}
                            role="menuitem"
                            type="button"
                          >
                            文档
                          </button>
                          <button
                            className={tab === "docs" && rightMode === "ask" ? "is-active" : ""}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setTab("docs");
                              setRightMode("ask");
                            }}
                            role="menuitem"
                            type="button"
                          >
                            问 AI
                          </button>
                          <button
                            className={tab === "search" ? "is-active" : ""}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setTab("search");
                            }}
                            role="menuitem"
                            type="button"
                          >
                            检索
                          </button>
                          <button
                            className={tab === "wiki" ? "is-active" : ""}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setTab("wiki");
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Wiki
                          </button>
                          {KB_GRAPH_UI_ENABLED ? (
                            <button
                              className={tab === "graph" ? "is-active" : ""}
                              onClick={() => {
                                setDetailMoreOpen(false);
                                setTab("graph");
                              }}
                              role="menuitem"
                              type="button"
                            >
                              图谱
                            </button>
                          ) : null}
                          <div className="ko-more-menu__sep" role="separator" />
                          <button
                            className="ko-more-menu__mobile-only"
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setCatalogOpen((v) => !v);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            目录
                          </button>
                          <button
                            className="ko-more-menu__mobile-only"
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setRailOpen((v) => !v);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            概览
                          </button>
                          <div className="ko-more-menu__sep ko-more-menu__mobile-only" role="separator" />
                          <button
                            disabled={busy}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              openBaseSettings();
                            }}
                            role="menuitem"
                            type="button"
                          >
                            库设置
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              void pickAndImportLocalFolder();
                            }}
                            role="menuitem"
                            title="选择本机文件夹；导入前会核对同步清单"
                            type="button"
                          >
                            选择本地文件夹
                          </button>
                          <button
                            disabled={
                              busy ||
                              !(
                                selected?.syncSourcePath ||
                                selected?.resolvedStorageDir ||
                                selected?.storageDir
                              )
                            }
                            onClick={() => {
                              setDetailMoreOpen(false);
                              openKbLocation();
                            }}
                            role="menuitem"
                            type="button"
                          >
                            打开位置
                          </button>
                          <button
                            disabled={busy || (!selected?.syncSourceType && !selected?.syncSourcePath)}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              resyncRemembered();
                            }}
                            role="menuitem"
                            type="button"
                          >
                            再同步
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setDetailMoreOpen(false);
                              setTab("docs");
                              setManualOpen(true);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            手写笔记
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                {localTreeRoot ? (
                  <KnowledgeV4FileTree
                    activePreviewPath={treeRevealPath}
                    onOpenFile={openDocFromTreePath}
                    workspacePath={localTreeRoot}
                  />
                ) : (
                  <div className="ko-catalog-bind" data-testid="ko-doc-list">
                    <div className="ko-catalog-bind__card">
                      <strong>侧栏使用 V4 文件树</strong>
                      <p>
                        需要先绑定本机文件夹（与对话右侧工作区文件树同一套组件）。当前库还没有同步源，所以不会显示旧版目录树。
                      </p>
                      <button
                        className="ko-btn primary"
                        disabled={busy}
                        onClick={() => void pickAndImportLocalFolder()}
                        type="button"
                      >
                        选择本地文件夹
                      </button>
                    </div>
                    {filteredDocs.length ? (
                      <div className="ko-catalog-bind__list" aria-label="已入库文档（绑定前临时列表）">
                        <div className="ko-catalog-bind__list-head">已入库 · {filteredDocs.length}</div>
                        {filteredDocs.map((doc) => {
                          const active = doc.id === selectedDocId;
                          const title = docDisplayName(doc);
                          return (
                            <button
                              key={doc.id}
                              className={`ko-catalog-bind__row${active ? " is-active" : ""}`}
                              onClick={() => {
                                setSelectedDocId(doc.id);
                                setTab("docs");
                                setRightMode("reader");
                              }}
                              title={title}
                              type="button"
                            >
                              {title}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
              </aside>

              <section className="ko-main">
              {tab === "docs" ? (
                <>
                  {selectedDocId ? (
                    <div className="ko-page-view" data-testid="ko-doc-reader">
                      <div className="ko-page-view__bar">
                        <div className="ko-page-view__titles">
                          <h2 title={docDisplayName(docContent || selectedDoc)}>
                            {docDisplayName(docContent || selectedDoc)}
                          </h2>
                          {docContent?.truncated ? (
                            <span className="ko-page-view__hint">已截断</span>
                          ) : null}
                        </div>
                        <div className="ko-page-view__actions">
                          {selectedDoc
                            ? (() => {
                                const badge = statusBadge(selectedDoc.parseStatus);
                                return (
                                  <span
                                    className={`ko-status-lamp is-${badge.kind}${
                                      badge.kind === "ready" ? " is-breathe" : ""
                                    }${badge.kind === "processing" ? " is-pulse" : ""}`}
                                    title={badge.label}
                                    aria-label={badge.label}
                                  />
                                );
                              })()
                            : null}
                          <button
                            className="ko-icon-btn"
                            onClick={() => setChunksPanelOpen(true)}
                            title={`查看分块${selectedDoc?.chunkCount != null ? `（${selectedDoc.chunkCount}）` : ""}`}
                            type="button"
                          >
                            <IconChunks />
                          </button>
                          {canEditBody && rightMode === "reader" ? (
                            bodyEditing ? (
                              <>
                                <button
                                  className="ko-icon-btn"
                                  disabled={savingDoc}
                                  onClick={() => {
                                    setBodyEditing(false);
                                    setEditDirty(false);
                                    setEditDraft(docContent?.content || "");
                                  }}
                                  title="取消"
                                  type="button"
                                >
                                  取消
                                </button>
                                <button
                                  className="ko-icon-btn is-primary"
                                  disabled={savingDoc || !editDirty}
                                  onClick={saveDocContent}
                                  title={savingDoc ? "保存中…" : "保存"}
                                  type="button"
                                >
                                  {savingDoc ? "…" : "保存"}
                                </button>
                              </>
                            ) : (
                              <button
                                className="ko-icon-btn"
                                onClick={() => {
                                  setEditDraft(docContent?.content || "");
                                  setEditDirty(false);
                                  setBodyEditing(true);
                                }}
                                title="编辑"
                                type="button"
                              >
                                <IconPencil />
                              </button>
                            )
                          ) : null}
                          <button
                            className="ko-icon-btn is-danger"
                            onClick={() => removeDoc(selectedDocId)}
                            title="删除"
                            type="button"
                          >
                            <IconTrash />
                          </button>
                        </div>
                      </div>

                      {rightMode === "reader" ? (
                        <>
                          {docContentLoading ? (
                            <div className="ko-empty">加载正文…</div>
                          ) : activeIsPdf && pdfObjectUrl && !pdfLoadFailed ? (
                            <article className="ko-page-body ko-page-body--pdf" data-testid="ko-pdf-frame">
                              <object
                                className="ko-pdf-iframe"
                                data={pdfObjectUrl}
                                type="application/pdf"
                                title={(docContent || selectedDoc)?.title || "PDF"}
                              >
                                <iframe
                                  className="ko-pdf-iframe"
                                  src={pdfObjectUrl}
                                  title={(docContent || selectedDoc)?.title || "PDF"}
                                />
                              </object>
                            </article>
                          ) : docContent?.content || (canEditBody && bodyEditing) ? (
                            <article
                              className="ko-page-body ko-page-body--v4"
                              data-testid="ko-md-reader"
                              ref={readerBodyRef}
                            >
                              {activeIsPdf && pdfLoadFailed ? (
                                <p className="ko-meta ko-pdf-fallback">PDF 预览失败，已显示解析正文。</p>
                              ) : null}
                              {canEditBody && bodyEditing ? (
                                <textarea
                                  className="ko-md-edit"
                                  data-testid="ko-md-edit"
                                  disabled={savingDoc}
                                  onChange={(e) => {
                                    setEditDraft(e.target.value);
                                    setEditDirty(true);
                                  }}
                                  spellCheck={false}
                                  value={editDraft}
                                />
                              ) : (
                                <KnowledgeV4Markdown content={docContent?.content || ""} />
                              )}
                              {docHeadings.length ? (
                                <div className={`ko-toc-float${tocFloatOpen ? " is-open" : ""}`}>
                                  <button
                                    aria-expanded={tocFloatOpen}
                                    className="ko-toc-float__toggle"
                                    onClick={() => setTocFloatOpen((v) => !v)}
                                    title={tocFloatOpen ? "收起大纲" : "展开大纲"}
                                    type="button"
                                  >
                                    大纲
                                    <span aria-hidden="true">{tocFloatOpen ? " ›" : " ‹"}</span>
                                  </button>
                                  {tocFloatOpen ? (
                                    <div className="ko-toc-float__panel" role="navigation" aria-label="文档大纲">
                                      <DocumentToc
                                        activeText={activeHeading}
                                        headings={docHeadings}
                                        onJump={(text) => {
                                          setActiveHeading(text);
                                          scrollToHeading(readerBodyRef.current, text);
                                        }}
                                      />
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </article>
                          ) : (
                            <div className="ko-empty">
                              {selectedDoc?.parseStatus === "processing" ||
                              selectedDoc?.parseStatus === "pending"
                                ? "文档仍在解析，完成后可查看解析正文（PDF/Office）。"
                                : "暂无正文。文本类可检查原文件；Office/PDF 需解析完成。"}
                            </div>
                          )}
                        </>
                      ) : (
                        <AskAiPanel
                          askBusy={askBusy}
                          askInput={askInput}
                          askListRef={askListRef}
                          askModel={askModel}
                          chatModels={chatModels}
                          effectiveChatModel={kbGlobalSettings?.effectiveChatModel || ""}
                          messages={askMessages}
                          onAsk={runAsk}
                          onAskModelChange={setAskModel}
                          onClear={() => setAskMessages([])}
                          onCitation={openDocFromCitation}
                          onHint={(h) => {
                            setAskInput(h);
                            runAsk(h);
                          }}
                          onInput={setAskInput}
                          selectedTitle={
                            (docContent || selectedDoc)?.title ||
                            (docContent || selectedDoc)?.fileName ||
                            ""
                          }
                        />
                      )}
                    </div>
                  ) : rightMode === "ask" ? (
                    <AskAiPanel
                      askBusy={askBusy}
                      askInput={askInput}
                      askListRef={askListRef}
                      emptyHint={
                        docs.length
                          ? "从左侧目录打开文档查看正文，或直接提问整个知识库"
                          : "绑定本地文件夹并同步后即可阅读与提问"
                      }
                      messages={askMessages}
                      onAsk={runAsk}
                      onAskModelChange={setAskModel}
                      onClear={() => setAskMessages([])}
                      onCitation={openDocFromCitation}
                      onHint={(h) => {
                        setAskInput(h);
                        runAsk(h);
                      }}
                      onInput={setAskInput}
                      askModel={askModel}
                      chatModels={chatModels}
                      effectiveChatModel={kbGlobalSettings?.effectiveChatModel || ""}
                      selectedTitle=""
                    />
                  ) : (
                    <KnowledgeHome
                      base={selected}
                      globalSettings={kbGlobalSettings}
                      docs={docs}
                      recentDocs={recentDocs}
                      onAsk={() => setRightMode("ask")}
                      onOpenDoc={(id) => openDocFromCitation(id)}
                      onSearch={() => setTab("search")}
                      onSyncFolder={() => {
                        if (selected?.syncSourceType || selected?.syncSourcePath) {
                          resyncRemembered();
                        } else {
                          void pickAndImportLocalFolder();
                        }
                      }}
                      onWrite={() => setManualOpen(true)}
                    />
                  )}

                  {manualOpen ? (
                    <ManualNoteModal
                      busy={busy}
                      body={manualBody}
                      onBodyChange={setManualBody}
                      onClose={() => setManualOpen(false)}
                      onSubmit={submitManual}
                      title={manualTitle}
                      onTitleChange={setManualTitle}
                    />
                  ) : null}
                </>
              ) : tab === "search" ? (
                <SearchPanel
                  busy={busy}
                  hits={hits}
                  kbTags={kbTags}
                  onOpenDoc={(docId) => openDocFromCitation(docId)}
                  onQuery={setQuery}
                  onSearch={runSearch}
                  onSearchMode={setSearchMode}
                  onTagFilter={setTagFilter}
                  query={query}
                  searchMode={searchMode}
                  tagFilter={tagFilter}
                />
              ) : tab === "wiki" ? (
                <div className="ko-wiki" data-testid="ko-wiki">
                  <div className="ko-toolbar">
                    <button
                      className="ko-btn primary"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api.rebuildOwnedWiki(selectedId);
                          notify("已排队生成 Wiki…");
                          window.setTimeout(() => loadWiki(selectedId), 1500);
                        } catch (e) {
                          notify(e?.message || "Wiki 生成失败");
                        } finally {
                          setBusy(false);
                        }
                      }}
                      type="button"
                    >
                      生成 / 重建 Wiki
                    </button>
                    {wikiPage ? (
                      <button
                        className="ko-btn"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            const page = await api.updateOwnedWikiPage(selectedId, wikiSlug, {
                              bodyMd: wikiDraft,
                            });
                            setWikiPage(page);
                            notify("Wiki 页已保存");
                            loadWiki(selectedId);
                          } catch (e) {
                            notify(e?.message || "保存失败");
                          } finally {
                            setBusy(false);
                          }
                        }}
                        type="button"
                      >
                        保存当前页
                      </button>
                    ) : null}
                  </div>
                  <div className="ko-wiki-layout">
                    <div className="ko-wiki-list">
                      {wikiPages.length ? (
                        wikiPages.map((p) => (
                          <button
                            className={`ko-base-item${p.slug === wikiSlug ? " active" : ""}`}
                            key={p.id}
                            onClick={() => openWikiPage(selectedId, p.slug)}
                            type="button"
                          >
                            <strong>{p.title}</strong>
                            <span>
                              {p.pageType} · {p.slug}
                            </span>
                          </button>
                        ))
                      ) : (
                        <div className="ko-empty">尚未生成 Wiki，点上方按钮从文档摘要构建</div>
                      )}
                    </div>
                    <div className="ko-wiki-editor">
                      {wikiPage ? (
                        <>
                          <h2>{wikiPage.title}</h2>
                          <div className="ko-meta">
                            {wikiPage.slug}
                            {wikiPage.outLinks?.length ? ` · 出链 ${wikiPage.outLinks.length}` : ""}
                            {wikiPage.inLinks?.length ? ` · 入链 ${wikiPage.inLinks.length}` : ""}
                          </div>
                          <textarea
                            onChange={(e) => setWikiDraft(e.target.value)}
                            rows={18}
                            style={{
                              width: "100%",
                              border: "1px solid var(--ko-line)",
                              borderRadius: 12,
                              padding: 12,
                              fontFamily: "ui-monospace, Consolas, monospace",
                              fontSize: 13,
                            }}
                            value={wikiDraft}
                          />
                        </>
                      ) : (
                        <div className="ko-empty">选择左侧页面查看 / 编辑</div>
                      )}
                    </div>
                  </div>
                </div>
              ) : KB_GRAPH_UI_ENABLED && tab === "graph" ? (
                <div className="ko-graph" data-testid="ko-wiki-graph">
                  <div className="ko-toolbar">
                    <div className="ko-seg">
                      <button
                        className={graphKind === "wiki" ? "active" : ""}
                        onClick={() => {
                          setGraphKind("wiki");
                          loadGraph(selectedId, "wiki");
                        }}
                        type="button"
                      >
                        Wiki 链接图
                      </button>
                      <button
                        className={graphKind === "documents" ? "active" : ""}
                        onClick={() => {
                          setGraphKind("documents");
                          loadGraph(selectedId, "documents");
                        }}
                        type="button"
                      >
                        文档链接
                      </button>
                      <button
                        className={graphKind === "entity" ? "active" : ""}
                        onClick={() => {
                          setGraphKind("entity");
                          loadGraph(selectedId, "entity");
                        }}
                        type="button"
                      >
                        实体图 G2
                      </button>
                    </div>
                    <button
                      className="ko-btn"
                      disabled={busy}
                      onClick={() => loadGraph(selectedId, graphKind)}
                      type="button"
                    >
                      刷新
                    </button>
                    {graphKind === "entity" ? (
                      <button
                        className="ko-btn primary"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api.rebuildOwnedKg(selectedId, true);
                            notify("已排队抽取实体关系…");
                            window.setTimeout(() => loadGraph(selectedId, "entity"), 2000);
                          } catch (e) {
                            notify(e?.message || "实体抽取失败");
                          } finally {
                            setBusy(false);
                          }
                        }}
                        type="button"
                      >
                        抽取实体
                      </button>
                    ) : null}
                    <span className="ko-meta">
                      {graphData.nodes?.length || 0} 节点 · {graphData.edges?.length || 0} 边
                    </span>
                  </div>
                  {graphData.nodes?.length && LazyKnowledgeForceGraph ? (
                    <div className="ko-graph-canvas">
                      <React.Suspense
                        fallback={
                          <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)" }}>
                            图谱加载中…
                          </div>
                        }
                      >
                      <LazyKnowledgeForceGraph
                        height={420}
                        mode="compact"
                        onNodeClick={(n) => {
                          if (graphKind === "wiki") {
                            const slug = n?.path || n?.id;
                            if (slug) {
                              setTab("wiki");
                              openWikiPage(selectedId, slug);
                            }
                          } else if (graphKind === "documents") {
                            const id = n?.id;
                            if (id) {
                              setTab("docs");
                              setSelectedDocId(id);
                              setRightMode("reader");
                            }
                          }
                        }}
                        prepared={preparedGraph}
                        rawEdges={graphData.edges}
                        rawNodes={graphData.nodes}
                        showDetailPanel={false}
                        showToolbar={false}
                        vaultId={selectedId}
                        width={720}
                      />
                      </React.Suspense>
                    </div>
                  ) : (
                    <div className="ko-empty">
                      {graphKind === "entity"
                        ? "暂无实体图。点「抽取实体」从文档块生成 G2 关系。"
                        : graphKind === "documents"
                          ? "暂无文档链接。在 Markdown 中使用 [[笔记名]]，索引完成后会出现。"
                          : "暂无链接图。先到 Wiki 页生成，再回来查看 G1 图谱。"}
                    </div>
                  )}
                </div>
              ) : null}
              </section>

              {tab === "docs" && selectedDocId ? (
                <aside className="ko-rail" data-testid="ko-overview-rail">
                  <KnowledgeRailCards
                    contentText={readerMarkdown}
                    doc={docContent || selectedDoc}
                    docLinks={docLinks}
                    jobStats={jobStats}
                    kbId={selectedId}
                    related={relatedDocs}
                    summaryBusy={summaryBusy}
                    summaryEnabled={Boolean(selected?.summaryEnabled)}
                    onGenerate={() => generateOverview(false)}
                    onForce={() => generateOverview(true)}
                    onOpenChunks={() => setChunksPanelOpen(true)}
                    onOpenRelated={openDocFromCitation}
                  />
                </aside>
              ) : null}
            </div>
          )}
          </div>
        </div>
      )}

      {toast ? <div className="ko-toast">{toast}</div> : null}

      <DocumentChunksPanel
        docId={selectedDocId}
        docLabel={docDisplayName(docContent || selectedDoc)}
        onClose={() => setChunksPanelOpen(false)}
        open={chunksPanelOpen && Boolean(selectedDocId)}
      />

      <SyncPreviewModal
        busy={busy}
        error={syncPreviewError}
        loading={syncPreviewLoading}
        mode={syncPreviewMode}
        onClose={() => {
          if (busy || syncPreviewLoading) return;
          // Ignore the same click that opened the dialog (backdrop click-through).
          if (Date.now() - syncPreviewGuardRef.current < 400) return;
          setSyncPreviewOpen(false);
          setSyncPreview(null);
          setSyncPreviewError("");
        }}
        onConfirm={() => void confirmSyncPreview()}
        onPruneChange={setSyncPruneMissing}
        onRetry={() =>
          void openSyncPreview({
            mode: syncPreviewMode,
            path: syncPreviewPath,
          })
        }
        open={syncPreviewOpen}
        path={syncPreviewPath}
        plan={syncPreview}
        pruneMissing={syncPruneMissing}
      />

      {createOpen ? (
        <div className="ko-modal-backdrop" onClick={() => !busy && setCreateOpen(false)} role="presentation">
          <div
            className="ko-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ko-create-title"
          >
            <h2 id="ko-create-title">新建知识库</h2>
            <label className="ko-modal__field">
              <span>名称</span>
              <input
                autoFocus
                onChange={(e) => setCreateName(e.target.value)}
                type="text"
                value={createName}
              />
            </label>
            <label className="ko-modal__field">
              <span>向量模型</span>
              {embOptions.length ? (
                <select
                  onChange={(e) => setCreateEmbRef(e.target.value)}
                  value={createEmbRef}
                >
                  {embOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                      {o.value === defaultEmbRef ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="ko-modal__hint">暂无向量模型，请先到设置中添加。</p>
              )}
            </label>
            <p className="ko-modal__hint">
              模型目录来自「设置 → 模型 → 向量模型」。
              <button
                className="ko-link-btn"
                onClick={openModelsEmbeddingSettings}
                type="button"
              >
                去管理
              </button>
            </p>
            <div className="ko-modal__actions">
              <button className="ko-btn" disabled={busy} onClick={() => setCreateOpen(false)} type="button">
                取消
              </button>
              <button
                className="ko-btn primary"
                disabled={busy || !embOptions.length}
                onClick={submitCreateBase}
                type="button"
              >
                {busy ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen && settingsBase ? (
        <div
          className="ko-sheet-backdrop"
          onClick={() => {
            if (busy) return;
            setSettingsOpen(false);
            setSettingsKbId("");
          }}
          role="presentation"
        >
          <div
            className="ko-sheet"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ko-settings-title"
          >
            <header className="ko-sheet__hero">
              <span className="ko-sheet__eyebrow">LIBRARY SETTINGS</span>
              <h2 id="ko-settings-title">库设置</h2>
              <p className="ko-sheet__lead">{settingsBase.name}</p>
              <button
                aria-label="关闭"
                className="ko-sheet__close"
                disabled={busy}
                onClick={() => {
                  setSettingsOpen(false);
                  setSettingsKbId("");
                }}
                type="button"
              >
                ×
              </button>
            </header>

            <div className="ko-sheet__body">
              <section className="ko-sheet__block">
                <div className="ko-sheet__block-head">
                  <h3>基本信息</h3>
                </div>
                <label className="ko-sheet__field">
                  <span>名称</span>
                  <input
                    disabled={busy || !!settingsBase.builtin}
                    onChange={(e) => setSettingsName(e.target.value)}
                    placeholder="知识库名称"
                    title={settingsBase.builtin ? "系统内置知识库不可重命名" : undefined}
                    type="text"
                    value={settingsName}
                  />
                </label>
                <label className="ko-sheet__field">
                  <span>介绍</span>
                  <textarea
                    disabled={busy}
                    onChange={(e) => setSettingsDesc(e.target.value)}
                    placeholder="用途说明，展示在知识库首页"
                    rows={3}
                    value={settingsDesc}
                  />
                </label>
              </section>

              <section className="ko-sheet__block">
                <div className="ko-sheet__block-head">
                  <h3>模型与解析</h3>
                </div>
                <label className="ko-sheet__field">
                  <span>解析摘要模型</span>
                  <select
                    disabled={busy}
                    onChange={(e) => setSettingsChatModel(e.target.value)}
                    value={settingsChatModel}
                  >
                    <option value="">
                      跟随全局默认
                      {kbGlobalSettings?.effectiveChatModel && !kbGlobalSettings?.chatModel
                        ? `（${kbGlobalSettings.effectiveChatModel}）`
                        : ""}
                    </option>
                    {chatModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>

                {settingsBase.builtin ? (
                  <label className="ko-sheet__check">
                    <input
                      checked={settingsRebind}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setSettingsRebind(on);
                        if (!on) setSettingsEmbRef(settingsCurrentRef);
                      }}
                      type="checkbox"
                    />
                    <span>更换向量模型</span>
                  </label>
                ) : null}

                {!settingsBase.builtin || settingsRebind ? (
                  settingsEmbOptions.length ? (
                    <label className="ko-sheet__field">
                      <span>向量模型</span>
                      <select
                        disabled={busy}
                        onChange={(e) => setSettingsEmbRef(e.target.value)}
                        value={settingsEmbRef}
                      >
                        {settingsEmbOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="ko-sheet__hint">
                      暂无向量模型
                      <button
                        className="ko-link-btn"
                        onClick={openModelsEmbeddingSettings}
                        type="button"
                      >
                        去管理
                      </button>
                    </p>
                  )
                ) : (
                  <label className="ko-sheet__field">
                    <span>向量模型</span>
                    <input disabled type="text" value={settingsBase.embeddingModel || "—"} />
                  </label>
                )}

                {settingsEmbChanged ? (
                  <p className="ko-sheet__hint is-warn">保存后将清空现有向量并整库重建。</p>
                ) : null}

                <label className={`ko-sheet__switch${settingsSummary ? " is-on" : ""}`}>
                  <span className="ko-sheet__switch-copy">
                    <strong>自动解析摘要</strong>
                    <small>默认关闭；开启后导入或更新文档会额外跑摘要任务</small>
                  </span>
                  <input
                    checked={settingsSummary}
                    disabled={busy}
                    onChange={(e) => setSettingsSummary(e.target.checked)}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="ko-sheet__switch-track" />
                </label>
              </section>
            </div>

            <footer className="ko-sheet__foot">
              <button
                className="ko-btn"
                disabled={busy || !settingsCurrentRef}
                onClick={rebuildVectors}
                title="按当前绑定的向量模型整库重建索引（不更换模型）"
                type="button"
              >
                {settingsBase.embeddingDim ? "重建索引" : "建立索引"}
              </button>
              <div className="ko-sheet__foot-end">
                <button
                  className="ko-btn"
                  disabled={busy}
                  onClick={() => {
                    setSettingsOpen(false);
                    setSettingsKbId("");
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="ko-btn primary"
                  disabled={busy || !settingsDirty || !String(settingsName || "").trim()}
                  onClick={submitBaseSettings}
                  type="button"
                >
                  {busy ? "保存中…" : settingsEmbChanged ? "保存并重建" : "保存"}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
