import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/tauri-api.js";
import { collectEmbeddingModelOptions } from "../lib/model-classification.js";
import { setKnowledgeVaultDetailShellMode } from "../router.js";
import { MarkdownDocumentView } from "../react/components/MarkdownDocumentView.js";
import { KnowledgeHubLayout } from "./knowledge-owned-hub.jsx";
import {
  DocumentHero,
  DocumentToc,
  KnowledgeRailCards,
  parseMarkdownHeadings,
  scrollToHeading,
  useReaderMarkdownEnhance,
} from "./knowledge-owned-reader.jsx";
import "./knowledge-source-tabs.css";

// 知识图谱为重型图渲染（react-force-graph-2d / d3-force），仅在切到「图谱」tab 时
// 才动态加载，避免打进知识库页面首屏 chunk 导致打开慢。
// KnowledgeForceGraph 是命名导出，转成 default 供 React.lazy 使用。
const LazyKnowledgeForceGraph = React.lazy(() =>
  import("../react/components/KnowledgeForceGraph.jsx").then((m) => ({
    default: m.KnowledgeForceGraph,
  })),
);

function openModelsEmbeddingSettings() {
  window.location.hash = "#/settings?tab=models";
}

function statusBadge(status) {
  const s = String(status || "");
  if (s === "completed") return { cls: "ok", label: "已就绪" };
  if (s === "processing" || s === "pending") return { cls: "busy", label: s === "pending" ? "排队中" : "处理中" };
  if (s === "failed") return { cls: "err", label: "失败" };
  return { cls: "", label: s || "—" };
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

/** Build Lexiang-like folder tree from documents' folderPath + explicit folders. */
function buildDocTree(docs, folders) {
  const root = { type: "folder", name: "", path: "", children: [], docs: [] };
  const ensureFolder = (rawPath) => {
    const raw = String(rawPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    if (!raw) return root;
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
    node.docs.push(doc);
  }
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
        const title = doc.title || doc.fileName || doc.id;
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
              <span className="ko-tree-title">{title}</span>
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
  onHint,
  onCitation,
  selectedTitle,
  emptyHint,
}) {
  const canSend = !askBusy && Boolean(String(askInput || "").trim());
  return (
    <div className="ko-ask" data-testid="ko-ask-panel">
      <div className="ko-ask__context">
        <span className="ko-ask__context-label">
          {selectedTitle ? `基于「${selectedTitle}」` : emptyHint || "基于整个知识库"}
        </span>
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
  const [toast, setToast] = useState("");
  const [listFilter, setListFilter] = useState("");
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
  const [syncPopupDismissed, setSyncPopupDismissed] = useState(false);
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
  const [editDraft, setEditDraft] = useState("");
  const [editDirty, setEditDirty] = useState(false);
  const [bodyEditing, setBodyEditing] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const [dragDocId, setDragDocId] = useState("");
  const [dragFolderPath, setDragFolderPath] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [catalogSideTab, setCatalogSideTab] = useState("files"); // files | toc
  const [activeHeading, setActiveHeading] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("我的知识库");
  const [createEmbRef, setCreateEmbRef] = useState("");
  const [embOptions, setEmbOptions] = useState([]);
  const [defaultEmbRef, setDefaultEmbRef] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsKbId, setSettingsKbId] = useState("");
  const [settingsName, setSettingsName] = useState("");
  const [settingsDesc, setSettingsDesc] = useState("");
  const [settingsEmbRef, setSettingsEmbRef] = useState("");
  const fileRef = useRef(null);
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

  // 详情沉浸：隐藏全局左侧壳菜单（与 Obsidian Vault 详情一致）
  useEffect(() => {
    const inDetail = route.view === "detail";
    setKnowledgeVaultDetailShellMode(inDetail);
    return () => setKnowledgeVaultDetailShellMode(false);
  }, [route.view]);

  const loadBases = useCallback(async () => {
    setLoading(true);
    try {
      const { takeNavWarm } = await import("../lib/nav-panel-prefetch.js");
      let res = takeNavWarm("knowledge:bases");
      if (!res) {
        res = await api.listOwnedKnowledgeBases();
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
      return;
    }
    try {
      const [res, tagsRes, jobsRes] = await Promise.all([
        api.listOwnedKnowledgeDocuments(kbId),
        api.listOwnedKnowledgeTags(kbId).catch(() => ({ items: [] })),
        api.listOwnedKnowledgeJobs(kbId, { limit: 20 }).catch(() => ({ stats: null })),
      ]);
      setDocs(res.items || []);
      setFolders(res.folders || []);
      setKbTags(tagsRes.items || []);
      setJobStats(jobsRes.stats || null);
    } catch (e) {
      notify(e?.message || "加载文档失败");
    }
  }, [notify]);

  useEffect(() => {
    loadBases();
  }, [loadBases]);

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
    if (tab === "graph") loadGraph(selectedId);
    return undefined;
  }, [tab, selectedId, loadWiki, loadGraph]);

  const [preparedGraph, setPreparedGraph] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setPreparedGraph(null);
    if (tab !== "graph" || !(graphData.nodes?.length || graphData.edges?.length)) {
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

  // Re-show popup when indexing becomes active again
  useEffect(() => {
    if (jobStats && (jobStats.active > 0 || jobStats.pendingDocs > 0)) {
      setSyncPopupDismissed(false);
    }
  }, [jobStats?.active, jobStats?.pendingDocs]);

  // Poll while any doc is pending/processing
  useEffect(() => {
    const need =
      docs.some((d) => d.parseStatus === "pending" || d.parseStatus === "processing") ||
      (jobStats && (jobStats.active > 0 || jobStats.pendingDocs > 0));
    if (!need || !selectedId) return undefined;
    const id = window.setInterval(() => loadDocs(selectedId), 2000);
    return () => window.clearInterval(id);
  }, [docs, selectedId, loadDocs, jobStats]);

  async function resyncRemembered() {
    if (!selectedId) return;
    if (!selected?.syncSourceType) {
      notify("还没有记住的同步源，请先「导入路径」或「从 Obsidian 导入」");
      return;
    }
    const prune = window.confirm("再同步时是否清理源中已删除的文档？");
    setBusy(true);
    try {
      const res = await api.resyncOwnedKnowledgeBase(selectedId, { pruneMissing: prune });
      await loadDocs(selectedId);
      await loadBases();
      notify(
        `再同步：新增 ${res.created || 0} · 更新 ${res.updated || 0} · 未变 ${res.unchanged || 0}` +
          `${res.pruned ? ` · 清理 ${res.pruned}` : ""}`
      );
    } catch (e) {
      notify(e?.message || "再同步失败");
    } finally {
      setBusy(false);
    }
  }
  const selected = useMemo(
    () => bases.find((b) => b.id === selectedId) || null,
    [bases, selectedId]
  );
  const settingsBase = useMemo(
    () => bases.find((b) => b.id === settingsKbId) || selected,
    [bases, settingsKbId, selected]
  );

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

  const docTree = useMemo(() => buildDocTree(docs, folders), [docs, folders]);

  const selectedDoc = useMemo(
    () => docs.find((d) => d.id === selectedDocId) || null,
    [docs, selectedDocId]
  );

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
    let cancelled = false;
    setDocContentLoading(true);
    (async () => {
      try {
        const [payload, links] = await Promise.all([
          api.getOwnedKnowledgeDocumentContent(selectedDocId),
          api.getOwnedKnowledgeDocumentLinks(selectedDocId).catch(() => null),
        ]);
        if (!cancelled) {
          setDocContent(payload);
          setDocLinks(links);
          setEditDraft(payload?.content || "");
          setEditDirty(false);
        }
      } catch (e) {
        if (!cancelled) {
          setDocContent(null);
          setDocLinks(null);
          notify(e?.message || "加载文档内容失败");
        }
      } finally {
        if (!cancelled) setDocContentLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDocId, notify, docContentEpoch]);

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
    if (selectedDocId && docHeadings.length) setCatalogSideTab("toc");
    else setCatalogSideTab("files");
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
    const base = baseOrNull || selected;
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
    setSettingsOpen(true);
  }

  async function renameBase(kbId, currentName) {
    const target = bases.find((b) => b.id === kbId);
    if (target?.builtin) {
      notify("系统内置知识库不可重命名");
      return;
    }
    const next = window.prompt("重命名知识库", currentName || "");
    if (next == null) return;
    const name = String(next).trim();
    if (!name || name === currentName) return;
    setBusy(true);
    try {
      await api.updateOwnedKnowledgeBase(kbId, { name });
      await loadBases();
      notify(`已重命名为「${name}」`);
    } catch (e) {
      notify(e?.message || "重命名失败");
    } finally {
      setBusy(false);
    }
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
    const prev = base?.embeddingModelRef || base?.embeddingModel || "";
    const next = String(settingsEmbRef || "").trim();
    const dimReady = !!base?.embeddingDim;
    const nameChanged = name !== String(base?.name || "").trim();
    const descChanged = description !== String(base?.description || "").trim();
    const embChanged = !!(next && next !== prev);

    if (embChanged) {
      const ok = window.confirm(
        "更换向量模型将清空现有向量并整库重建索引，是否继续？",
      );
      if (!ok) return;
    } else if (!dimReady && next) {
      const ok = window.confirm(
        "当前知识库尚未完成向量化。保存后将按所选向量模型整库建立索引，是否继续？",
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      let res;
      const metaPatch = {};
      if (nameChanged) metaPatch.name = name;
      if (descChanged) metaPatch.description = description;

      if (embChanged) {
        res = await api.updateOwnedKnowledgeBase(kbId, {
          ...metaPatch,
          embeddingModelRef: next,
        });
      } else if (!dimReady && next) {
        if (Object.keys(metaPatch).length) {
          await api.updateOwnedKnowledgeBase(kbId, metaPatch);
        }
        res = await api.reindexOwnedKnowledgeBase(kbId, {
          embeddingModelRef: next || undefined,
          force: true,
        });
      } else {
        res = await api.updateOwnedKnowledgeBase(kbId, {
          ...metaPatch,
          ...(next ? { embeddingModelRef: next } : {}),
        });
      }
      setSettingsOpen(false);
      setSettingsKbId("");
      await loadBases();
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
    const next = String(settingsEmbRef || base?.embeddingModelRef || "").trim();
    if (!embOptions.length) {
      notify("请先在 设置 → 模型 → 向量模型 中添加或绑定套餐向量模型");
      return;
    }
    if (!next) {
      notify("请先选择向量模型");
      return;
    }
    const ok = window.confirm(
      base?.embeddingDim
        ? "将清空现有向量并按所选模型整库重建，是否继续？"
        : "将按所选向量模型为该库建立索引，是否继续？",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.reindexOwnedKnowledgeBase(kbId, {
        embeddingModelRef: next,
        force: true,
      });
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

  async function onUploadFiles(fileList) {
    if (!selectedId || !fileList?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(fileList)) {
        await api.uploadOwnedKnowledgeDocument(selectedId, file);
      }
      await loadDocs(selectedId);
      notify(`已上传 ${fileList.length} 个文件，正在索引…`);
    } catch (e) {
      notify(e?.message || "上传失败");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
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

  async function importFolderPath() {
    if (!selectedId) return;
    const path = window.prompt("导入本机文件夹路径（增量同步：同路径更新，未改跳过）", "");
    if (!path?.trim()) return;
    const prune = window.confirm(
      "是否删除知识库中已不在该文件夹的导入文档？\n\n确定=清理缺失文件\n取消=只增改、不删"
    );
    setBusy(true);
    try {
      const res = await api.importOwnedKnowledgeFolder(selectedId, path.trim(), {
        upsert: true,
        pruneMissing: prune,
      });
      await loadDocs(selectedId);
      await loadBases();
      notify(
        `同步完成：新增 ${res.created || 0} · 更新 ${res.updated || 0} · 未变 ${res.unchanged || 0}` +
          `${res.skipped ? ` · 跳过 ${res.skipped}` : ""}${res.pruned ? ` · 清理 ${res.pruned}` : ""}`
      );
    } catch (e) {
      notify(e?.message || "导入文件夹失败");
    } finally {
      setBusy(false);
    }
  }

  async function importFromVault() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const list = await api.listKnowledgeVaults();
      const vaults = list.items || list || [];
      if (!vaults.length) {
        notify("还没有已连接的 Obsidian Vault（遗留）。可到「Obsidian（遗留）」页添加后再导入，或直接「导入路径」");
        return;
      }
      const lines = vaults
        .map((v, i) => `${i + 1}. ${v.name || v.id}  (${v.vaultPath || ""})`)
        .join("\n");
      const pick = window.prompt(`选择要导入/再同步的 Vault 序号：\n${lines}`, "1");
      if (!pick) return;
      const idx = Math.max(0, parseInt(pick, 10) - 1);
      const vault = vaults[idx];
      if (!vault?.id) {
        notify("无效的 Vault 选择");
        return;
      }
      if (
        !window.confirm(
          `将「${vault.name || vault.id}」增量同步进当前知识库？\n同路径按内容哈希更新；原 Vault 不删除。`
        )
      ) {
        return;
      }
      const prune = window.confirm("是否清理 Vault 中已删除、但库里仍保留的导入文档？");
      const res = await api.importOwnedKnowledgeVault(selectedId, vault.id, {
        upsert: true,
        pruneMissing: prune,
      });
      await loadDocs(selectedId);
      await loadBases();
      notify(
        `Vault 同步：新增 ${res.created || 0} · 更新 ${res.updated || 0} · 未变 ${res.unchanged || 0}` +
          `${res.skipped ? ` · 跳过 ${res.skipped}` : ""}${res.pruned ? ` · 清理 ${res.pruned}` : ""}`
      );
    } catch (e) {
      notify(e?.message || "从 Vault 导入失败");
    } finally {
      setBusy(false);
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
          onRename={renameBase}
          onSettings={(base) => openBaseSettings(base)}
        />
      ) : (
        <div className="ko-shell ko-shell--full">
          <div className="ko-workspace">
          <div className="ko-topbar ko-topbar--immersive" data-testid="ko-detail-topbar">
            <div className="ko-topbar__left" data-tauri-no-drag="">
              <button
                className="ko-back-btn"
                data-testid="ko-back-list"
                onClick={goOwnedList}
                title="返回知识库列表"
                type="button"
              >
                <svg fill="none" height="16" viewBox="0 0 16 16" width="16" aria-hidden="true">
                  <path
                    d="M10 3.5 5.5 8 10 12.5"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.6"
                  />
                </svg>
                <span>返回</span>
              </button>
              <span className="ko-topbar__divider" aria-hidden="true" />
              <nav className="ko-crumb" aria-label="面包屑">
                <span className="ko-crumb__current" data-testid="ko-page-title">
                  {selected?.name || "…"}
                </span>
              </nav>
              <nav className="ko-top-nav" aria-label="知识库视图">
                <button
                  className={tab === "docs" && rightMode === "reader" ? "is-active" : ""}
                  onClick={() => {
                    setTab("docs");
                    setRightMode("reader");
                  }}
                  type="button"
                >
                  文档
                </button>
                <button
                  className={tab === "docs" && rightMode === "ask" ? "is-active" : ""}
                  onClick={() => {
                    setTab("docs");
                    setRightMode("ask");
                  }}
                  type="button"
                >
                  问 AI
                </button>
                <button
                  className={tab === "search" ? "is-active" : ""}
                  onClick={() => setTab("search")}
                  type="button"
                >
                  检索
                </button>
                <button
                  className={tab === "wiki" ? "is-active" : ""}
                  onClick={() => setTab("wiki")}
                  type="button"
                >
                  Wiki
                </button>
                <button
                  className={tab === "graph" ? "is-active" : ""}
                  onClick={() => setTab("graph")}
                  type="button"
                >
                  图谱
                </button>
              </nav>
            </div>
            <div className="ko-detail-drawers" data-tauri-no-drag="">
              <button
                className="ko-btn ghost"
                onClick={() => setCatalogOpen((v) => !v)}
                type="button"
              >
                目录
              </button>
              <button
                className="ko-btn ghost"
                onClick={() => setRailOpen((v) => !v)}
                type="button"
              >
                概览
              </button>
            </div>
            <div className="ko-actions" data-tauri-no-drag="">
              <button className="ko-btn" disabled={busy} onClick={openBaseSettings} type="button">
                库设置
              </button>
              <button className="ko-btn" disabled={busy} onClick={() => fileRef.current?.click()} type="button">
                上传文件
              </button>
              <button className="ko-btn" disabled={busy} onClick={() => folderRef.current?.click()} type="button">
                上传文件夹
              </button>
              <button className="ko-btn" disabled={busy} onClick={importFolderPath} type="button">
                导入路径
              </button>
              <button className="ko-btn" disabled={busy} onClick={importFromVault} type="button">
                从 Obsidian 导入
              </button>
              <button
                className="ko-btn primary"
                disabled={busy || !selected?.syncSourceType}
                onClick={resyncRemembered}
                title={
                  selected?.syncSourcePath
                    ? `再同步：${selected.syncSourcePath}`
                    : "先导入路径或 Vault 后可一键再同步"
                }
                type="button"
              >
                再同步
              </button>
              <button
                className="ko-btn"
                disabled={busy}
                onClick={() => {
                  setTab("docs");
                  setManualOpen(true);
                }}
                type="button"
              >
                手写笔记
              </button>
              <input
                accept=".md,.markdown,.mdx,.txt,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.json,.html,.htm,.yaml,.yml,.py"
                hidden
                multiple
                onChange={(e) => onUploadFiles(e.target.files)}
                ref={fileRef}
                type="file"
              />
              <input
                hidden
                multiple
                onChange={(e) => onUploadFiles(e.target.files)}
                ref={folderRef}
                type="file"
                webkitdirectory=""
              />
            </div>
          </div>

          {selected && !selected.embeddingDim ? (
            <div className="ko-sync-popup is-idle" data-testid="ko-embedding-pending">
              <div className="ko-sync-popup__body">
                <strong>尚未向量化</strong>
                <span>
                  库内文档还未按向量模型建索引。可在「库设置」选择 Agent Plan / 向量模型页中的模型，再点「立即向量化」。
                </span>
              </div>
              <button className="ko-btn primary" disabled={busy} onClick={openBaseSettings} type="button">
                打开库设置
              </button>
            </div>
          ) : null}

          {jobStats &&
          !syncPopupDismissed &&
          (jobStats.active > 0 || jobStats.pendingDocs > 0 || jobStats.error > 0) ? (
            <div
              className={`ko-sync-popup${jobStats.active > 0 || jobStats.pendingDocs > 0 ? " is-active" : " is-idle"}`}
              data-testid="ko-sync-banner"
            >
              <div className="ko-sync-popup__body">
                <strong>
                  {jobStats.active > 0 || jobStats.pendingDocs > 0 ? "索引中" : "索引状态"}
                </strong>
                <span>
                  {jobStats.active > 0 || jobStats.pendingDocs > 0
                    ? `排队 ${jobStats.queued || 0} · 进行 ${jobStats.running || 0} · 待解析 ${jobStats.pendingDocs || 0}`
                    : null}
                  {jobStats.error
                    ? `${jobStats.active > 0 || jobStats.pendingDocs > 0 ? " · " : ""}失败 ${jobStats.error}`
                    : null}
                </span>
              </div>
              <button
                aria-label="关闭"
                className="ko-sync-popup__close"
                onClick={() => setSyncPopupDismissed(true)}
                type="button"
              >
                ×
              </button>
            </div>
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
              <aside className="ko-catalog" data-testid="ko-tabs">
                <div className="ko-catalog__head">
                  <span className="ko-catalog__head-icon" aria-hidden="true">
                    <IconFolder />
                  </span>
                  <span className="ko-catalog__head-title">
                    {selectedDocId ? "浏览" : "目录"}
                  </span>
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
                    <button
                      className="ko-icon-btn"
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                      title="新建 / 上传"
                      type="button"
                    >
                      <svg fill="currentColor" height="18" viewBox="0 0 16 16" width="18" aria-hidden="true">
                        <path d="M8 1.4a.6.6 0 0 1 .6.6v5.4H14l.121.012a.6.6 0 0 1 0 1.176L14 8.6H8.6V14a.6.6 0 1 1-1.2 0V8.6H2a.6.6 0 1 1 0-1.2h5.4V2a.6.6 0 0 1 .6-.6" />
                      </svg>
                    </button>
                  </div>
                </div>
                {selectedDocId ? (
                  <div className="ko-catalog__tabs" role="tablist" aria-label="侧栏视图">
                    <button
                      className={catalogSideTab === "files" ? "is-active" : ""}
                      onClick={() => setCatalogSideTab("files")}
                      role="tab"
                      type="button"
                    >
                      文件
                    </button>
                    <button
                      className={catalogSideTab === "toc" ? "is-active" : ""}
                      onClick={() => setCatalogSideTab("toc")}
                      role="tab"
                      type="button"
                    >
                      目录
                    </button>
                  </div>
                ) : null}
                {selectedDocId && catalogSideTab === "toc" ? (
                  <div className="ko-catalog-toc">
                    <DocumentToc
                      activeText={activeHeading}
                      headings={docHeadings}
                      onJump={(text) => {
                        setActiveHeading(text);
                        scrollToHeading(readerBodyRef.current, text);
                      }}
                    />
                  </div>
                ) : (
                <div
                  className="ko-catalog-tree"
                  data-testid="ko-doc-list"
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(e) => {
                    // Drop on empty tree area → root
                    if (e.target === e.currentTarget) {
                      e.preventDefault();
                      const folderFrom =
                        e.dataTransfer.getData("text/ko-folder-path") || dragFolderPath;
                      if (folderFrom) {
                        handleDropFolder({ fromPath: folderFrom, parentPath: "" });
                        return;
                      }
                      const id = e.dataTransfer.getData("text/ko-doc-id") || dragDocId;
                      if (id) handleDropDoc({ docId: id, folderPath: "" });
                    }
                  }}
                >
                  {docs.length || folders.length ? (
                    <CatalogTreeNodes
                      dragDocId={dragDocId}
                      dragFolderPath={dragFolderPath}
                      expanded={expandedFolders}
                      level={0}
                      node={docTree}
                      onCreateSubfolder={createFolderAt}
                      onDeleteFolder={deleteFolderAt}
                      onDropDoc={handleDropDoc}
                      onDropFolder={handleDropFolder}
                      onMoveDoc={moveDocToFolder}
                      onRenameFolder={renameFolderAt}
                      onSelectDoc={(id) => {
                        setSelectedDocId(id);
                        setTab("docs");
                        setRightMode("reader");
                      }}
                      onToggle={toggleFolder}
                      selectedDocId={selectedDocId}
                      setDragDocId={setDragDocId}
                      setDragFolderPath={setDragFolderPath}
                    />
                  ) : (
                    <div className="ko-empty" style={{ padding: 16 }}>
                      暂无文档，点右上角上传，或先新建文件夹
                    </div>
                  )}
                  <div
                    className="ko-tree-root-drop"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      e.currentTarget.classList.add("is-drop");
                    }}
                    onDragLeave={(e) => e.currentTarget.classList.remove("is-drop")}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("is-drop");
                      const folderFrom =
                        e.dataTransfer.getData("text/ko-folder-path") || dragFolderPath;
                      if (folderFrom) {
                        handleDropFolder({ fromPath: folderFrom, parentPath: "" });
                        return;
                      }
                      const id = e.dataTransfer.getData("text/ko-doc-id") || dragDocId;
                      if (id) handleDropDoc({ docId: id, folderPath: "" });
                    }}
                  >
                    拖到此处移到根目录
                  </div>
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
                          <h2>
                            {(docContent || selectedDoc)?.title ||
                              (docContent || selectedDoc)?.fileName ||
                              "文档"}
                          </h2>
                          <div className="ko-meta">
                            {[
                              (docContent || selectedDoc)?.folderPath,
                              (docContent || selectedDoc)?.fileName,
                            ]
                              .filter(Boolean)
                              .join(" / ")}
                            {docContent?.source === "raw"
                              ? " · 原文"
                              : docContent?.source === "parsed"
                                ? " · 解析正文"
                                : docContent?.source === "summary"
                                  ? " · 摘要"
                                  : ""}
                            {docContent?.truncated ? " · 已截断" : ""}
                          </div>
                        </div>
                        <div className="ko-page-view__actions">
                          {selectedDoc ? (
                            <span className={`ko-badge ${statusBadge(selectedDoc.parseStatus).cls}`}>
                              {statusBadge(selectedDoc.parseStatus).label}
                            </span>
                          ) : null}
                          {canEditBody && rightMode === "reader" ? (
                            bodyEditing ? (
                              <>
                                <button
                                  className="ko-btn ghost"
                                  disabled={savingDoc}
                                  onClick={() => {
                                    setBodyEditing(false);
                                    setEditDirty(false);
                                    setEditDraft(docContent?.content || "");
                                  }}
                                  type="button"
                                >
                                  取消
                                </button>
                                <button
                                  className="ko-btn primary"
                                  disabled={savingDoc || !editDirty}
                                  onClick={saveDocContent}
                                  type="button"
                                >
                                  {savingDoc ? "保存中…" : "保存"}
                                </button>
                              </>
                            ) : (
                              <button
                                className="ko-btn ghost"
                                onClick={() => {
                                  setEditDraft(docContent?.content || "");
                                  setEditDirty(false);
                                  setBodyEditing(true);
                                }}
                                type="button"
                              >
                                编辑
                              </button>
                            )
                          ) : null}
                          <button
                            className="ko-btn ghost"
                            onClick={() => removeDoc(selectedDocId)}
                            type="button"
                          >
                            删除
                          </button>
                        </div>
                      </div>

                      <DocumentHero
                        content={readerMarkdown}
                        summary={(docContent || selectedDoc)?.summaryText}
                        title={
                          (docContent || selectedDoc)?.title ||
                          (docContent || selectedDoc)?.fileName ||
                          "文档"
                        }
                      />

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
                              className="ko-page-body"
                              data-testid="ko-md-reader"
                              ref={readerBodyRef}
                            >
                              {activeIsPdf && pdfLoadFailed ? (
                                <p className="ko-meta ko-pdf-fallback">PDF 预览失败，已显示解析正文。</p>
                              ) : null}
                              <MarkdownDocumentView
                                allowEdit={canEditBody && bodyEditing}
                                className="ko-md-doc ko-md-doc--reader"
                                onChange={(t) => {
                                  setEditDraft(t);
                                  setEditDirty(true);
                                }}
                                readOnly={savingDoc || !bodyEditing}
                                testIdPrefix="ko-md"
                                text={bodyEditing ? editDraft : docContent?.content || ""}
                              />
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
                          messages={askMessages}
                          onAsk={runAsk}
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
                          : "上传文档后即可阅读与提问"
                      }
                      messages={askMessages}
                      onAsk={runAsk}
                      onCitation={openDocFromCitation}
                      onHint={(h) => {
                        setAskInput(h);
                        runAsk(h);
                      }}
                      onInput={setAskInput}
                      selectedTitle=""
                    />
                  ) : (
                    <div className="ko-reader-empty" data-testid="ko-reader-empty">
                      <p className="ko-reader-empty__title">选择一篇文档</p>
                      <p className="ko-reader-empty__desc">
                        {docs.length
                          ? "从左侧目录打开正文或 PDF；也可切到「问 AI」直接提问。"
                          : "上传文档后即可在此阅读。"}
                      </p>
                      {docs.length ? (
                        <button
                          className="ko-btn"
                          onClick={() => setRightMode("ask")}
                          type="button"
                        >
                          去问 AI
                        </button>
                      ) : null}
                    </div>
                  )}

                  {manualOpen ? (
                    <div style={{ marginTop: 16, borderTop: "1px solid var(--ko-line)", paddingTop: 14 }}>
                      <h2>手写 Markdown</h2>
                      <div className="ko-toolbar">
                        <input
                          onChange={(e) => setManualTitle(e.target.value)}
                          placeholder="标题"
                          type="text"
                          value={manualTitle}
                        />
                      </div>
                      <textarea
                        onChange={(e) => setManualBody(e.target.value)}
                        placeholder="正文 Markdown…"
                        rows={10}
                        style={{
                          width: "100%",
                          border: "1px solid var(--ko-line)",
                          borderRadius: 12,
                          padding: 12,
                          fontFamily: "ui-monospace, Consolas, monospace",
                          fontSize: 13,
                        }}
                        value={manualBody}
                      />
                      <div className="ko-actions" style={{ marginTop: 8 }}>
                        <button className="ko-btn primary" disabled={busy} onClick={submitManual} type="button">
                          保存并索引
                        </button>
                        <button className="ko-btn" onClick={() => setManualOpen(false)} type="button">
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : tab === "search" ? (
                <SearchPanel
                  busy={busy}
                  hits={hits}
                  kbTags={kbTags}
                  onOpenDoc={(docId) => {
                    if (!docId) return;
                    setSelectedDocId(docId);
                    setTab("docs");
                    setRightMode("reader");
                  }}
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
              ) : (
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
                  {graphData.nodes?.length ? (
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
              )}
              </section>

              {tab === "docs" && selectedDocId ? (
                <aside className="ko-rail" data-testid="ko-overview-rail">
                  <KnowledgeRailCards
                    contentText={readerMarkdown}
                    doc={docContent || selectedDoc}
                    docLinks={docLinks}
                    kbId={selectedId}
                    related={relatedDocs}
                    summaryBusy={summaryBusy}
                    summaryEnabled={selected?.summaryEnabled !== false}
                    onGenerate={() => generateOverview(false)}
                    onForce={() => generateOverview(true)}
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
          className="ko-modal-backdrop"
          onClick={() => {
            if (busy) return;
            setSettingsOpen(false);
            setSettingsKbId("");
          }}
          role="presentation"
        >
          <div
            className="ko-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ko-settings-title"
          >
            <h2 id="ko-settings-title">库设置 · {settingsBase.name}</h2>
            <label className="ko-modal__field">
              <span>名称</span>
              <input
                disabled={!!settingsBase.builtin}
                onChange={(e) => setSettingsName(e.target.value)}
                placeholder="知识库名称"
                type="text"
                value={settingsName}
              />
            </label>
            <label className="ko-modal__field">
              <span>描述</span>
              <textarea
                onChange={(e) => setSettingsDesc(e.target.value)}
                placeholder="可选：用途说明"
                rows={3}
                value={settingsDesc}
              />
            </label>
            <p className="ko-modal__hint">
              当前：{settingsBase.embeddingMode === "local" ? "本地" : "云端"} ·{" "}
              {settingsBase.embeddingModel || "—"}
              {settingsBase.embeddingDim
                ? ` · ${settingsBase.embeddingDim} 维`
                : " · 维度未就绪（尚未向量化；模型未就绪时仍可关键词检索）"}
            </p>
            <label className="ko-modal__field">
              <span>向量模型</span>
              {embOptions.length ? (
                <select
                  onChange={(e) => setSettingsEmbRef(e.target.value)}
                  value={settingsEmbRef}
                >
                  {embOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="ko-modal__hint">
                  暂无可用向量模型。若已绑定 Agent Plan，请到「设置 → 模型 → 向量模型」确认套餐向量已出现；或点下方去管理。
                  未就绪时不会强制向量化，文档仍可分块与关键词检索。
                </p>
              )}
            </label>
            <p className="ko-modal__hint">
              列表来自「设置 → 模型 → 向量模型」（含 Agent Plan 绑定的套餐向量）。更换模型或维度未就绪时会整库重建索引。
              <button
                className="ko-link-btn"
                onClick={openModelsEmbeddingSettings}
                type="button"
              >
                管理向量模型
              </button>
            </p>
            <div className="ko-modal__actions">
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
                className="ko-btn"
                disabled={busy || !embOptions.length}
                onClick={rebuildVectors}
                type="button"
                title="按当前所选模型整库建立 / 重建向量"
              >
                {busy ? "处理中…" : settingsBase.embeddingDim ? "重建向量索引" : "立即向量化"}
              </button>
              <button
                className="ko-btn primary"
                disabled={busy || !String(settingsName || "").trim()}
                onClick={submitBaseSettings}
                type="button"
              >
                {busy
                  ? "保存中…"
                  : embOptions.length && !settingsBase.embeddingDim && settingsEmbRef
                    ? "保存并向量化"
                    : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
