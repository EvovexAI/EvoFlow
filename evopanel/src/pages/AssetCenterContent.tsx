import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  UserRound,
  BrainCircuit,
  Sparkles,
  MessageCircleMore,
  Plus,
  RefreshCw,
  Save,
  MoreVertical,
  BarChart3,
  ArrowUp,
  Copy,
  Maximize2,
  ArrowRightLeft,
  Activity,
  Inbox,
  Clock,
  ScanSearch,
  Quote,
  Folder,
  FileText,
  LayoutDashboard,
  Settings2,
  Download,
  Upload,
  PackageOpen,
  PenLine,
  CheckCircle2,
  X,
  FileArchive,
  DatabaseBackup,
  ChevronRight,
  CornerDownLeft,
} from "lucide-react";
import { api } from "../lib/tauri-api.js";
import { toast } from "../components/toast.js";
import { getCurrentRoute } from "../router.js";
import {
  clearAssetFileCache,
  peekAssetFileCache,
  putAssetFileCache,
  warmAssetFile,
  warmAssetFileBatch,
} from "../lib/assets-file-prefetch.js";

/* ── Types ───────────────────────────────────────────────────────── */

type AssetTab = "overview" | "profile" | "memory" | "experience" | "journal" | "manage";

type TreeTab = "memory" | "experience" | "journal";

type MemoryKind = "standing" | "facts" | "episodic";

type Entity = { entityType: string; entityId: string; label?: string; workspacePath?: string };

type TreeEntry = { name: string; path: string; kind: string };

type FileItem = { id: string; name: string; type: "folder" | "file"; path: string; count?: number };

type SearchHit = {
  path: string;
  matchLine: number;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  matchedQueries?: string[];
};

const PROFILE_LABELS: Record<string, string> = {
  "basic-info.md": "基本信息",
  "preferences.md": "偏好与爱好",
  "persona.md": "画像与行为",
  "identity.md": "身份边界",
  "SOUL.md": "人格 SOUL",
  "affect.md": "情感",
  "system.md": "系统提示词",
  "soul-summary.md": "人格摘要（自动生成）",
};

type UsageStatsRow = {
  path: string;
  title: string;
  summary: string;
  useCount: number;
  citeCount?: number;
  lastUsedAt: string;
  lastCitedAt?: string;
  stale: boolean;
  kind: string;
};

type UsageStatsPayload = {
  ok?: boolean;
  maxUnusedDays?: number;
  totals?: {
    files?: number;
    memoryFiles?: number;
    craftFiles?: number;
    touched?: number;
    totalUses?: number;
    totalCites?: number;
    stale?: number;
    inboxPending?: number;
  };
  hot?: UsageStatsRow[];
  stale?: UsageStatsRow[];
};

type MemoryRunRow = {
  id?: string;
  createdAt?: string;
  finishedAt?: string;
  phase?: string;
  trigger?: string;
  threadId?: string;
  agentName?: string;
  /** 操作人 = 运行时身份 principal_id */
  principalId?: string;
  operatorId?: string;
  entityType?: string;
  entityId?: string;
  status?: string;
  skipReason?: string;
  errorMessage?: string;
  paths?: string[];
};

const ASSET_TABS: { id: AssetTab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "总览", icon: <LayoutDashboard size={16} strokeWidth={1.6} /> },
  { id: "profile", label: "画像", icon: <UserRound size={16} strokeWidth={1.6} /> },
  { id: "memory", label: "记忆", icon: <BrainCircuit size={16} strokeWidth={1.6} /> },
  { id: "experience", label: "经验", icon: <Sparkles size={16} strokeWidth={1.6} /> },
  { id: "journal", label: "反思", icon: <MessageCircleMore size={16} strokeWidth={1.6} /> },
  { id: "manage", label: "管理", icon: <Settings2 size={16} strokeWidth={1.6} /> },
];

const MEMORY_KINDS: { id: MemoryKind; label: string; hint: string }[] = [
  { id: "facts", label: "事实", hint: "memory/facts/ · Agent 可检索的短事实" },
  { id: "episodic", label: "过程记录", hint: "memory/episodic/ · 对话过程回顾" },
  { id: "standing", label: "站立摘要", hint: "memory/standing.md · 自动生成的长期摘要" },
];

const ENTITY_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: "user", label: "我", types: ["user"] },
  { key: "employee", label: "员工", types: ["employee"] },
];

/** Agent entities hold profile/SOUL only — memory lives under user/. */
function assetTabsForEntity(entityType: string): typeof ASSET_TABS {
  const et = String(entityType || "").trim().toLowerCase();
  if (et === "agent") {
    return ASSET_TABS.filter((t) => t.id === "overview" || t.id === "profile" || t.id === "manage");
  }
  // Workspaces are memory vaults.
  if (et === "workspace") {
    return ASSET_TABS.filter((t) => t.id === "overview" || t.id === "memory" || t.id === "manage");
  }
  // Employees: include profile so SOUL + affect.md are editable in Asset Center.
  if (et === "employee") {
    return ASSET_TABS;
  }
  if (et !== "user") {
    return ASSET_TABS.filter((t) => t.id !== "profile");
  }
  return ASSET_TABS;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function parseHashQuery(): Record<string, string> {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return {};
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function entityLabel(ent: Entity | undefined): string {
  if (!ent) return "—";
  if (ent.entityType === "user") return "我";
  const name = String(ent.label || ent.entityId || "").trim() || "—";
  return name;
}

/** Merge Chinese display names from agents / proactive roles (same SoT as chat UI). */
function enrichEntityLabels(
  list: Entity[],
  agents: Array<{ agent_code?: string; agent_name?: string; name?: string }> | null | undefined,
  roles: Array<{ agent_code?: string; role_name?: string; agent_name?: string }> | null | undefined,
): Entity[] {
  const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s);
  const agentNames = new Map<string, string>();
  for (const a of agents || []) {
    const code = String(a?.agent_code || a?.name || "")
      .trim()
      .toLowerCase();
    const name = String(a?.agent_name || "").trim();
    if (code && name && name.toLowerCase() !== code) agentNames.set(code, name);
  }
  const roleNames = new Map<string, string>();
  for (const r of roles || []) {
    const code = String(r?.agent_code || "")
      .trim()
      .toLowerCase();
    const name = String(r?.role_name || r?.agent_name || "").trim();
    if (code && name && name.toLowerCase() !== code) roleNames.set(code, name);
  }
  const pickLabel = (code: string, prev: string, agentName: string, roleName: string) => {
    const human = [agentName, roleName, prev].filter(
      (n) => n && n.toLowerCase() !== code,
    );
    const cjk = human.find(hasCjk);
    if (cjk) return cjk;
    if (human[0]) return human[0];
    return prev || code;
  };
  return list.map((e) => {
    const code = String(e.entityId || "")
      .trim()
      .toLowerCase();
    if (!code || e.entityType === "user") return e;
    const prev = String(e.label || "").trim();
    let next = prev;
    if (e.entityType === "employee") {
      next = pickLabel(code, prev, agentNames.get(code) || "", roleNames.get(code) || "");
    } else if (e.entityType === "workspace") {
      const wp = String((e as Entity).workspacePath || "").trim();
      if (wp) {
        const leaf = wp.replace(/\\/g, "/").split("/").filter(Boolean).pop() || wp;
        next = leaf;
      }
    }
    return next && next !== prev ? { ...e, label: next } : e;
  });
}

/** Asset Center UI: user / employee / workspace only (no bare agent). */
function sanitizeEntitiesForUi(list: Entity[]): Entity[] {
  return (list || []).filter((e) => {
    const t = String(e?.entityType || "")
      .trim()
      .toLowerCase();
    return t === "user" || t === "employee" || t === "workspace";
  });
}

function treeRootForTab(tab: AssetTab): string | null {
  if (tab === "memory") return "memory";
  if (tab === "experience") return "craft";
  if (tab === "journal") return "memory/journal";
  return null;
}

function workspaceTitle(tab: AssetTab): string {
  if (tab === "profile") return "用户画像";
  if (tab === "memory") return "记忆目录";
  if (tab === "experience") return "经验目录";
  if (tab === "journal") return "反思日志";
  return "资产目录";
}

function workspacePath(tab: AssetTab, treePath?: string): string {
  if (tab === "profile") return "profile/";
  if (treePath) return `${treePath}/`;
  if (tab === "memory") return "memory/";
  if (tab === "experience") return "craft/";
  if (tab === "journal") return "memory/journal/";
  return "";
}

function todayJournalPath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `memory/journal/${y}-${m}-${day}.md`;
}

function assetsHrefForPath(
  path: string,
  opts?: { entityType?: string; entityId?: string },
): string {
  const rel = String(path || "").replace(/\\/g, "/").replace(/^\//, "");
  const params = new URLSearchParams();
  params.set("tab", rel.startsWith("craft/") ? "experience" : "memory");
  if (rel.startsWith("memory/episodic/")) params.set("memoryKind", "episodic");
  else if (rel.startsWith("memory/facts/") || rel === "memory/MEMORY.md") params.set("memoryKind", "facts");
  else if (rel.includes("standing")) params.set("memoryKind", "standing");
  if (opts?.entityType) params.set("entityType", opts.entityType);
  if (opts?.entityId) params.set("entityId", opts.entityId);
  if (rel) params.set("path", rel);
  return `#/assets?${params.toString()}`;
}

function formatRelativeTime(iso: string): string {
  const raw = String(iso || "").trim();
  if (!raw) return "—";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw.slice(0, 16);
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} 天前`;
  return raw.slice(0, 10);
}

function treeToFileItems(entries: TreeEntry[]): FileItem[] {
  return entries.map((e) => ({
    id: e.path,
    name: e.name,
    path: e.path,
    type: e.kind === "dir" ? "folder" : "file",
  }));
}

function initialTab(): AssetTab {
  const routePath = String(getCurrentRoute() || "").split("?")[0];
  if (routePath === "/memory" || routePath === "/memory/atoms") return "memory";
  if (routePath === "/skills") return "experience";
  const q = parseHashQuery();
  const t = String(q.tab || "");
  // Legacy ids → new IA (统计/导出合并进「管理」)
  if (t === "stats" || t === "export") return "manage";
  if (t === "experience" || t === "exp") return "experience";
  if (t === "journal" || t === "reflect" || t === "reflection") return "journal";
  if (t === "skill" || t === "skills") return "experience";
  if (t === "profile") return "profile";
  if (t === "overview" || t === "home") return "overview";
  if (ASSET_TABS.some((x) => x.id === t)) return t as AssetTab;
  const path = String(q.path || "").replace(/\\/g, "/");
  if (path.startsWith("craft/")) return "experience";
  if (path.startsWith("memory/journal/")) return "journal";
  if (path.startsWith("profile/")) return "profile";
  if (path.startsWith("memory/")) return "memory";
  // 无深链参数时落在总览,给新用户一条清晰的动线
  return "overview";
}

function initialEntity(): { entityType: string; entityId: string } {
  const q = parseHashQuery();
  if (q.entity) {
    const [et, ...rest] = String(q.entity).split(":");
    if (et && rest.length) return { entityType: et, entityId: rest.join(":") };
  }
  if (q.entityType && q.entityId) return { entityType: q.entityType, entityId: q.entityId };
  return { entityType: "user", entityId: "user" };
}

function initialMemoryKind(): MemoryKind {
  const q = parseHashQuery();
  const k = String(q.memoryKind || q.kind || "").trim().toLowerCase();
  // legacy deep-link memoryKind=graph → facts (asset-hub memory graph UI removed)
  if (k === "graph") return "facts";
  if (k === "standing" || k === "facts" || k === "episodic") return k;
  const path = String(q.path || "").replace(/\\/g, "/");
  if (path.startsWith("memory/episodic/")) return "episodic";
  if (path.includes("standing")) return "standing";
  if (path.startsWith("memory/facts/") || path === "memory/MEMORY.md") return "facts";
  return "facts";
}

function initialOpenPath(): string {
  const q = parseHashQuery();
  return String(q.path || "").replace(/\\/g, "/").replace(/^\//, "").trim();
}

function isTauriDesktop(): boolean {
  const w = window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

function fileBaseName(p: string): string {
  const norm = String(p || "").replace(/\\/g, "/");
  return norm.split("/").filter(Boolean).pop() || norm;
}

/* ── Main ────────────────────────────────────────────────────────── */

export default function AssetCenterContent() {
  const initEnt = initialEntity();
  const [activeTab, setActiveTab] = useState<AssetTab>(initialTab);
  const [fileSearch, setFileSearch] = useState("");

  const [entities, setEntities] = useState<Entity[]>([]);
  const [entityType, setEntityType] = useState(initEnt.entityType);
  const [entityId, setEntityId] = useState(initEnt.entityId);
  const [vaultRoot, setVaultRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [profileFields, setProfileFields] = useState<Record<string, string | null>>({});
  const [profileField, setProfileField] = useState("basic-info.md");
  const [profileDirty, setProfileDirty] = useState(false);

  const [treeRoot, setTreeRoot] = useState("");
  const [treePath, setTreePath] = useState("");
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [fileDirty, setFileDirty] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const fileLoadSeq = useRef(0);

  const [applyTarget, setApplyTarget] = useState("");
  const [applyScopes, setApplyScopes] = useState({
    profile: true,
    experience: true,
    memory: false,
    journal: false,
  });
  const [exportHint, setExportHint] = useState("");
  const [memoryKind, setMemoryKind] = useState<MemoryKind>(initialMemoryKind);
  const [usageStats, setUsageStats] = useState<UsageStatsPayload | null>(null);
  const [memoryRuns, setMemoryRuns] = useState<MemoryRunRow[]>([]);
  const [statsBusy, setStatsBusy] = useState(false);
  const pendingOpenPath = useRef(initialOpenPath());

  const currentEntity = useMemo(() => ({ entityType, entityId }), [entityType, entityId]);
  const isUserEntity = entityType === "user";

  const [tabLoading, setTabLoading] = useState(false);
  const initRanRef = useRef(false);

  // 弹层:快速记事实 / 导入资产包
  const [factOpen, setFactOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // 全文搜索(⌘K)
  const [globalSearch, setGlobalSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchSeq = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadTree = useCallback(
    async (path = "") => {
      const root = treeRootForTab(activeTab) || "";
      let rel = String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (root) {
        if (!rel || rel === ".") rel = root;
        else if (rel !== root && !rel.startsWith(`${root}/`)) rel = root;
      }
      const data = await api.assetsListTree({ ...currentEntity, path: rel });
      const nextPath = String(data?.path || rel || "");
      let entries: TreeEntry[] = Array.isArray(data?.entries) ? data.entries : [];
      if (activeTab === "memory" && nextPath === "memory") {
        if (memoryKind === "standing") {
          entries = entries.filter((e) => e.name === "standing.md");
        } else {
          entries = entries.filter((e) => e.name !== "journal");
        }
      }
      setTreeRoot(root);
      setTreePath(nextPath);
      setTreeEntries(entries);
    },
    [activeTab, currentEntity, memoryKind],
  );

  const loadProfile = useCallback(async () => {
    const data = await api.assetsGetProfile(currentEntity);
    const fields = data?.fields || {};
    setProfileFields(fields);
    const keys = Object.keys(fields);
    setProfileField((prev) => (keys.includes(prev) ? prev : keys[0] || "basic-info.md"));
    setProfileDirty(false);
  }, [currentEntity]);

  const prefetchFile = useCallback(
    (relPath: string) => {
      const path = String(relPath || "").replace(/\\/g, "/");
      if (!path) return;
      void warmAssetFile(currentEntity, path);
    },
    [currentEntity],
  );

  const loadFile = useCallback(
    async (relPath: string) => {
      const path = String(relPath || "").replace(/\\/g, "/");
      if (!path) return;
      const seq = ++fileLoadSeq.current;
      setSelectedFile(path);
      setFileDirty(false);
      const cached = peekAssetFileCache(currentEntity, path);
      if (cached != null) {
        // Hover / enter warm already finished — paint immediately, refresh in background.
        setEditorContent(cached);
        setFileLoading(false);
        void warmAssetFile(currentEntity, path, { force: true }).then((fresh) => {
          if (seq !== fileLoadSeq.current || fresh == null) return;
          // Only refresh if editor still shows the cached snapshot (user hasn't typed).
          setEditorContent((cur) => (cur === cached ? fresh : cur));
        });
        return;
      }
      setEditorContent("");
      setFileLoading(true);
      try {
        const data = await api.assetsReadFile({ ...currentEntity, path });
        if (seq !== fileLoadSeq.current) return;
        const content = String(data?.content ?? "");
        putAssetFileCache(currentEntity, path, content);
        setEditorContent(content);
        setFileDirty(false);
      } catch (e: unknown) {
        if (seq !== fileLoadSeq.current) return;
        setEditorContent("");
        toast.error(String((e as { message?: string })?.message || e));
      } finally {
        if (seq === fileLoadSeq.current) setFileLoading(false);
      }
    },
    [currentEntity],
  );

  const applyMemoryKind = useCallback(
    async (kind: MemoryKind) => {
      fileLoadSeq.current += 1;
      setSelectedFile("");
      setEditorContent("");
      setFileDirty(false);
      setFileLoading(false);
      if (kind === "standing") {
        await loadTree("memory");
        try {
          await loadFile("memory/standing.md");
        } catch {
          /* standing may not exist yet */
        }
      } else if (kind === "facts") {
        await loadTree("memory/facts");
      } else {
        await loadTree("memory/episodic");
      }
    },
    [loadTree, loadFile],
  );

  const loadUsageStats = useCallback(async () => {
    setStatsBusy(true);
    try {
      const data = await api.assetsUsageStats({ ...currentEntity, topN: 12 });
      setUsageStats((data as UsageStatsPayload) || null);
      try {
        const runsOut = await api.assetsMemoryRuns({ ...currentEntity, limit: 20 });
        const rows = Array.isArray(runsOut?.runs) ? runsOut.runs : [];
        setMemoryRuns(rows as MemoryRunRow[]);
      } catch {
        setMemoryRuns([]);
      }
    } catch (e: unknown) {
      setUsageStats(null);
      setMemoryRuns([]);
      toast.error(String((e as { message?: string })?.message || e));
    } finally {
      setStatsBusy(false);
    }
  }, [currentEntity]);

  /** 只加载当前 tab 对应的数据，避免首屏全量请求 */
  const loadTabData = useCallback(
    async (tab: AssetTab) => {
      setError("");
      setFileSearch("");
      setTabLoading(true);
      try {
        if (tab === "profile") {
          await loadProfile();
          fileLoadSeq.current += 1;
          setSelectedFile("");
          setEditorContent("");
          setFileLoading(false);
        } else if (tab === "memory") {
          await applyMemoryKind(memoryKind);
        } else if (tab === "experience" || tab === "journal") {
          const root = treeRootForTab(tab);
          if (root) {
            const seqAtStart = fileLoadSeq.current;
            await loadTree(root);
            if (fileLoadSeq.current !== seqAtStart) return;
            fileLoadSeq.current += 1;
            setSelectedFile("");
            setEditorContent("");
            setFileDirty(false);
            setFileLoading(false);
          }
        }
        /* overview / 其余 tab 无数据预加载(overview 统计单独拉) */
      } catch (e: unknown) {
        const msg = String((e as { message?: string })?.message || e);
        setError(msg);
        toast.error(msg);
      } finally {
        setTabLoading(false);
      }
    },
    [loadProfile, loadTree, applyMemoryKind, memoryKind],
  );

  const refreshTab = useCallback(() => loadTabData(activeTab), [loadTabData, activeTab]);

  /* ── 初始化：骨架屏立刻渲染，init 和当前 tab 数据并行请求 ── */
  useEffect(() => {
    if (initRanRef.current) return;
    initRanRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const { takeNavWarm } = await import("../lib/nav-panel-prefetch.js");
        let data = takeNavWarm("assets:init") as Record<string, unknown> | null;
        if (!data) {
          data = (await api.assetsInit()) as Record<string, unknown>;
        }
        if (cancelled) return;

        const entField = data?.entities;
        const raw: Entity[] = Array.isArray(entField)
          ? (entField as Entity[])
          : Array.isArray((entField as { entities?: Entity[] } | null)?.entities)
            ? ((entField as { entities: Entity[] }).entities)
            : [];
        const list0 = sanitizeEntitiesForUi(enrichEntityLabels(raw, [], [])).filter(
          (e) => e.entityType !== "workspace"
        );
        setEntities(list0);

        const nestedRoot =
          entField && typeof entField === "object" && !Array.isArray(entField)
            ? String((entField as { root?: string }).root || "")
            : "";
        setVaultRoot(String(data?.root || nestedRoot || ""));

        const ok0 = list0.some((e) => e.entityType === entityType && e.entityId === entityId);
        const currentGroup = list0.filter((e) => {
          if (isUserEntity) return true;
          return e.entityType === entityType;
        });
        if ((!ok0 || String(entityType).toLowerCase() === "agent") && currentGroup[0]) {
          setEntityType(currentGroup[0].entityType);
          setEntityId(currentGroup[0].entityId);
        } else if (!ok0 && list0[0]) {
          setEntityType(list0[0].entityType);
          setEntityId(list0[0].entityId);
        }

        // init 完成后，骨架屏消失
        setLoading(false);

        // 后台补中文名字，不阻塞渲染
        void Promise.all([
          api.listAgents().catch(() => []),
          api.proactiveListRoles().catch(() => null),
        ]).then(([agentRows, roleRes]) => {
          if (cancelled) return;
          const agents = Array.isArray(agentRows) ? agentRows : [];
          const roleList = (roleRes as { roles?: unknown })?.roles;
          const roles = Array.isArray(roleList)
            ? (roleList as Array<{ agent_code?: string; role_name?: string; agent_name?: string }>)
            : [];
          setEntities(sanitizeEntitiesForUi(enrichEntityLabels(raw, agents, roles)));
        });
      } catch (e: unknown) {
        if (!cancelled) setError(String((e as { message?: string })?.message || e));
        if (!cancelled) setLoading(false);
      }
    })();

    // init 和当前 tab 数据并行请求（tab 数据不等 init 完）
    // 用一个微延迟让骨架屏先 paint 出来，避免主线程阻塞
    const tabTimer = setTimeout(() => {
      void loadTabData(initialTab());
    }, 30);

    return () => {
      cancelled = true;
      clearTimeout(tabTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const allowed = assetTabsForEntity(entityType).map((t) => t.id);
    if (!allowed.includes(activeTab)) {
      setActiveTab(allowed[0] || "overview");
    }
    const currentEntityRec = entities.find((e) => e.entityType === entityType && e.entityId === entityId);
    if (!currentEntityRec && entities.length > 0) {
      const targetGroup = entities.filter((e) =>
        isUserEntity ? true : e.entityType === entityType
      );
      if (targetGroup[0]) {
        setEntityType(targetGroup[0].entityType);
        setEntityId(targetGroup[0].entityId);
      }
    }
  }, [entityType, activeTab, entities, isUserEntity]);

  // 切换实体 / tab 时重新加载对应数据
  useEffect(() => {
    if (loading) return;
    void loadTabData(activeTab);
  }, [entityType, entityId, activeTab, loadTabData, loading]);

  // 总览页拉一次用量统计
  useEffect(() => {
    if (loading || (activeTab !== "overview" && activeTab !== "manage")) return;
    void loadUsageStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeTab, entityType, entityId]);

  // 目录树加载完成后，自动选中第一个文件；并预取首屏若干文档（悬停点击可秒开）
  useEffect(() => {
    if (tabLoading || activeTab === "profile" || activeTab === "overview" || activeTab === "manage") return;
    const pending = pendingOpenPath.current;
    if (pending) {
      pendingOpenPath.current = "";
      void loadFile(pending);
    } else if (!selectedFile) {
      const first = treeEntries.find((e) => e.kind !== "dir");
      if (first) void loadFile(first.path);
    }
    const filePaths = treeEntries
      .filter((e) => e.kind !== "dir")
      .map((e) => String(e.path || ""))
      .filter(Boolean);
    if (filePaths.length) {
      void warmAssetFileBatch(currentEntity, filePaths, { limit: 8, concurrency: 2 });
    }
  }, [treeEntries, selectedFile, activeTab, tabLoading, loadFile, memoryKind, currentEntity]);

  // 切换实体时清掉上一实体的文件缓存，避免串读
  useEffect(() => {
    return () => {
      clearAssetFileCache(currentEntity);
    };
  }, [currentEntity]);

  // ⌘K / Ctrl+K 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 全文搜索(防抖)
  useEffect(() => {
    const q = globalSearch.trim();
    if (q.length < 2) {
      searchSeq.current += 1;
      setSearchHits(null);
      setSearchBusy(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearchBusy(true);
    const timer = setTimeout(async () => {
      try {
        const data = (await api.assetsSearch({
          ...currentEntity,
          q,
          maxResults: 8,
          contextLines: 1,
        })) as { matches?: SearchHit[] };
        if (seq !== searchSeq.current) return;
        setSearchHits(Array.isArray(data?.matches) ? data.matches : []);
        setSearchOpen(true);
      } catch {
        if (seq !== searchSeq.current) return;
        setSearchHits([]);
      } finally {
        if (seq === searchSeq.current) setSearchBusy(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [globalSearch, currentEntity]);

  const profileFiles = useMemo<FileItem[]>(() => {
    const kw = fileSearch.trim().toLowerCase();
    return Object.keys(profileFields)
      .filter((k) => {
        const label = PROFILE_LABELS[k] || k;
        if (!kw) return true;
        return label.toLowerCase().includes(kw) || k.toLowerCase().includes(kw);
      })
      .map((k) => ({
        id: k,
        name: PROFILE_LABELS[k] || k,
        path: k,
        type: "file" as const,
      }));
  }, [profileFields, fileSearch]);

  const treeFiles = useMemo(() => {
    const items = treeToFileItems(treeEntries);
    const kw = fileSearch.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((f) => f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw));
  }, [treeEntries, fileSearch]);

  const groupedEntities = useMemo(
    () =>
      ENTITY_GROUPS.map((g) => ({
        ...g,
        items: entities.filter((e) => g.types.includes(e.entityType)),
      })).filter((g) => g.items.length > 0),
    [entities],
  );

  function changeTab(tab: AssetTab) {
    setActiveTab(tab);
    setFileSearch("");
    if (tab === "memory") setMemoryKind("facts");
  }

  const openPath = useCallback(
    (relPath: string) => {
      const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\//, "");
      if (!rel) return;
      let tab: AssetTab = "memory";
      if (rel.startsWith("craft/")) tab = "experience";
      else if (rel.startsWith("memory/journal/")) tab = "journal";
      else if (rel.startsWith("profile/")) tab = "profile";
      else if (rel.startsWith("memory/")) {
        tab = "memory";
        if (rel.startsWith("memory/episodic/")) setMemoryKind("episodic");
        else if (rel.includes("standing")) setMemoryKind("standing");
        else setMemoryKind("facts");
      } else return;
      if (tab === activeTab) {
        if (tab === "memory") void applyMemoryKind(memoryKind).then(() => loadFile(rel));
        else {
          pendingOpenPath.current = rel;
          void loadTabData(tab);
        }
      } else {
        pendingOpenPath.current = rel;
        changeTab(tab);
      }
    },
    [activeTab, memoryKind, applyMemoryKind, loadFile, loadTabData],
  );

  const createTodayJournal = useCallback(async () => {
    const path = todayJournalPath();
    const stamp = fileBaseName(path).replace(".md", "");
    const stub = `# 反思 ${stamp}\n\n## 今日做了什么\n\n\n## 学到什么\n\n\n## 下次注意\n\n`;
    try {
      await api.assetsPutFile({ ...currentEntity, path, content: stub });
      toast.success("已创建今日反思");
      if (activeTab === "journal") {
        await loadTree("memory/journal");
        await loadFile(path);
      } else {
        pendingOpenPath.current = path;
        changeTab("journal");
      }
    } catch (e: unknown) {
      toast.error(String((e as { message?: string })?.message || e));
    }
  }, [activeTab, currentEntity, loadTree, loadFile]);

  const afterFactSaved = useCallback(() => {
    if (activeTab === "memory" && memoryKind === "facts") {
      void loadTree("memory/facts");
    }
    if (activeTab === "overview" || activeTab === "manage") {
      void loadUsageStats();
    }
  }, [activeTab, memoryKind, loadTree, loadUsageStats]);

  const afterPackImported = useCallback(() => {
    if (activeTab === "memory" || activeTab === "experience" || activeTab === "journal") {
      void refreshTab();
    }
    void loadUsageStats();
  }, [activeTab, refreshTab, loadUsageStats]);

  if (loading) {
    return (
      <main className="assets-center-root relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="ac-page relative z-10">
          {/* Header 骨架 */}
          <header className="ac-header">
            <div className="ac-header-row">
              <div className="ac-header-left min-w-0">
                <div className="ac-skeleton ac-skeleton--title" style={{ width: 140, height: 24 }} />
                <div className="ac-skeleton mt-2" style={{ width: 200, height: 14, borderRadius: 6 }} />
              </div>
              <div className="ac-skeleton" style={{ width: 220, height: 32, borderRadius: 8 }} />
            </div>
            <div className="mt-3 flex gap-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="ac-skeleton" style={{ width: 56, height: 30, borderRadius: 8 }} />
              ))}
            </div>
          </header>

          {/* 内容骨架 */}
          <section className="ac-shell">
            <div className="ac-content">
              <div className="p-6">
                <div className="ac-skeleton" style={{ width: "100%", height: 132, borderRadius: 14 }} />
                <div className="mt-4 grid grid-cols-3 gap-3">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="ac-skeleton" style={{ width: "100%", height: 64, borderRadius: 12 }} />
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="ac-skeleton" style={{ width: "100%", height: 180, borderRadius: 12 }} />
                  <div className="ac-skeleton" style={{ width: "100%", height: 180, borderRadius: 12 }} />
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (error && !entities.length) {
    return (
      <main className="assets-center-root relative flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--ac-bg)] text-red-500">
        加载失败：{error}
      </main>
    );
  }

  const profileContent = String(profileFields[profileField] ?? "");
  const profileReadonly = profileField === "soul-summary.md";
  const lineCount = Math.max(
    (activeTab === "profile" ? profileContent : editorContent).split("\n").length,
    1,
  );
  const canJournal = entityType === "user" || entityType === "employee";

  return (
    <main className="assets-center-root relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BackgroundEffects />

      <div className="ac-page relative z-10">
        <AssetHeader
          entityType={entityType}
          entityId={entityId}
          groupedEntities={groupedEntities}
          onSelectEntity={(et, eid) => {
            setEntityType(et);
            setEntityId(eid);
          }}
          activeTab={activeTab}
          onTabChange={changeTab}
          search={globalSearch}
          setSearch={setGlobalSearch}
          searchOpen={searchOpen}
          setSearchOpen={setSearchOpen}
          searchHits={searchHits}
          searchBusy={searchBusy}
          searchInputRef={searchInputRef}
          onOpenHit={openPath}
        />

        <section className="ac-shell">
          <div className="ac-content">
            {tabLoading && activeTab !== "overview" ? (
              <div className="ac-tab-loading">
                <div className="ac-tab-loading-spinner" />
                <span>加载中…</span>
              </div>
            ) : activeTab === "overview" ? (
              <OverviewPanel
                entityType={entityType}
                entityId={entityId}
                stats={usageStats}
                busy={statsBusy}
                canJournal={canJournal}
                onQuickFact={() => setFactOpen(true)}
                onImport={() => setImportOpen(true)}
                onNewJournal={() => void createTodayJournal()}
                onOpenTab={changeTab}
                onOpenPath={openPath}
                onConsolidate={async () => {
                  try {
                    setStatsBusy(true);
                    const out = await api.assetsPhase2Consolidate(currentEntity);
                    const skipped = out?.skipped;
                    if (skipped) toast.info(`Phase2 跳过：${skipped}`);
                    else toast.success("Phase2 整合完成");
                    await loadUsageStats();
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  } finally {
                    setStatsBusy(false);
                  }
                }}
              />
            ) : activeTab === "manage" ? (
              <ManageWorkspace
                vaultRoot={vaultRoot}
                entityType={entityType}
                entityId={entityId}
                entities={entities}
                applyTarget={applyTarget}
                setApplyTarget={setApplyTarget}
                applyScopes={applyScopes}
                setApplyScopes={setApplyScopes}
                exportHint={exportHint}
                busy={statsBusy}
                stats={usageStats}
                memoryRuns={memoryRuns}
                onRefreshStats={() => void loadUsageStats()}
                onQuickFact={() => setFactOpen(true)}
                onImportPack={() => setImportOpen(true)}
                onPack={async () => {
                  try {
                    const res = await api.assetsPackExport(currentEntity);
                    setExportHint(`已导出：${res?.path || res?.filename || ""}`);
                    toast.success(`Pack 已导出（${res?.fileCount ?? 0} 个文件）`);
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  }
                }}
                onMigrate={async (scope: string) => {
                  try {
                    setStatsBusy(true);
                    const res = await api.assetsMigrate({ scope });
                    if (scope === "slim") toast.success(`索引瘦身完成：${res?.slimmed ?? 0} 条`);
                    else
                      toast.success(
                        `迁移完成：经验 ${res?.experiences?.migrated ?? 0}，记忆 ${res?.memory?.mirrored ?? 0}`,
                      );
                    await loadUsageStats();
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  } finally {
                    setStatsBusy(false);
                  }
                }}
                onScanAll={async () => {
                  try {
                    setStatsBusy(true);
                    const out = await api.assetsPhase2Scan({ maxEntities: 24 });
                    const skipped = out?.skipped;
                    if (skipped) {
                      toast.info(`全库扫描跳过：${skipped}`);
                      return;
                    }
                    const ran = Number(out?.ran ?? 0);
                    const scanned = Number(out?.scanned ?? 0);
                    toast.success(`全库扫描完成：${ran}/${scanned} 个实体已整合`);
                    await loadUsageStats();
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  } finally {
                    setStatsBusy(false);
                  }
                }}
                onConsolidate={async () => {
                  try {
                    setStatsBusy(true);
                    const out = await api.assetsPhase2Consolidate(currentEntity);
                    const skipped = out?.skipped;
                    if (skipped) toast.info(`Phase2 跳过：${skipped}`);
                    else toast.success("Phase2 整合完成");
                    await loadUsageStats();
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  } finally {
                    setStatsBusy(false);
                  }
                }}
                onApply={async () => {
                  const [targetType, targetId] = String(applyTarget || "").split(":");
                  if (!targetType || !targetId) {
                    toast.error("请先选择目标员工");
                    return;
                  }
                  const scopes = Object.entries(applyScopes)
                    .filter(([, on]) => on)
                    .map(([k]) => k);
                  if (!scopes.length) {
                    toast.error("请至少勾选一个应用范围");
                    return;
                  }
                  if (entityType === targetType && entityId === targetId) {
                    toast.error("目标不能与当前对象相同");
                    return;
                  }
                  const targetEnt = entities.find(
                    (e) => e.entityType === targetType && e.entityId === targetId,
                  );
                  const targetName = entityLabel(targetEnt) || targetId;
                  try {
                    const res = await api.assetsApply({
                      sourceType: entityType,
                      sourceId: entityId,
                      targetType,
                      targetId,
                      scopes,
                      conflict: "skip",
                    });
                    toast.success(
                      `已应用到 ${targetName}（复制 ${res?.copied ?? 0}，跳过 ${res?.skipped ?? 0}）`,
                    );
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  }
                }}
              />
            ) : activeTab === "profile" ? (
              <SplitShell
                left={
                  <FileSidebar
                    title={workspaceTitle("profile")}
                    pathHint="profile/"
                    files={profileFiles}
                    fileSearch={fileSearch}
                    setFileSearch={setFileSearch}
                    selectedId={profileField}
                    onSelectFile={(id) => setProfileField(id)}
                    onSelectFolder={() => {}}
                    onRefresh={() => void loadProfile()}
                    footer={<VaultInfo />}
                  />
                }
                right={
                  <EditorPanel
                    pathLabel={`${PROFILE_LABELS[profileField] || profileField} · profile/${profileField}`}
                    content={profileContent}
                    readonly={profileReadonly}
                    saved={!profileDirty}
                    lineCount={lineCount}
                    onChange={(v) => {
                      setProfileFields((prev) => ({ ...prev, [profileField]: v }));
                      setProfileDirty(true);
                    }}
                    onSave={async () => {
                      if (profileReadonly) return;
                      try {
                        await api.assetsPutProfile({
                          ...currentEntity,
                          field: profileField,
                          content: profileFields[profileField] || "",
                        });
                        toast.success("已保存");
                        setProfileDirty(false);
                      } catch (e: unknown) {
                        toast.error(String((e as { message?: string })?.message || e));
                      }
                    }}
                  />
                }
              />
            ) : (
              <TreeWorkspace
                tab={activeTab as TreeTab}
                title={
                  activeTab === "memory"
                    ? MEMORY_KINDS.find((k) => k.id === memoryKind)?.label || "记忆"
                    : workspaceTitle(activeTab)
                }
                pathHint={
                  activeTab === "memory"
                    ? MEMORY_KINDS.find((k) => k.id === memoryKind)?.hint || "memory/"
                    : workspacePath(activeTab, treePath)
                }
                files={treeFiles}
                fileSearch={fileSearch}
                setFileSearch={setFileSearch}
                selectedFile={selectedFile}
                editorContent={editorContent}
                fileDirty={fileDirty}
                fileLoading={fileLoading}
                lineCount={lineCount}
                canGoUp={!!treePath && treePath !== treeRoot}
                memoryKind={memoryKind}
                onMemoryKindChange={(k) => {
                  setMemoryKind(k);
                  void applyMemoryKind(k);
                }}
                onQuickFact={() => setFactOpen(true)}
                onNewJournal={() => void createTodayJournal()}
                onUp={async () => {
                  const root = treeRoot || "";
                  const parts = treePath.split("/").filter(Boolean);
                  parts.pop();
                  let next = parts.join("/");
                  if (root && (!next || (next !== root && !next.startsWith(`${root}/`)))) next = root;
                  await loadTree(next);
                }}
                onRefresh={() => void refreshTab()}
                onOpenDir={(p) => void loadTree(p)}
                onOpenFile={(p) => void loadFile(p)}
                onPrefetchFile={prefetchFile}
                onChangeContent={(v) => {
                  setEditorContent(v);
                  setFileDirty(true);
                }}
                onSave={async () => {
                  if (!selectedFile) return;
                  try {
                    await api.assetsPutFile({
                      ...currentEntity,
                      path: selectedFile,
                      content: editorContent,
                    });
                    putAssetFileCache(currentEntity, selectedFile, editorContent);
                    toast.success("已保存");
                    setFileDirty(false);
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  }
                }}
              />
            )}
          </div>
        </section>
      </div>

      {factOpen ? (
        <QuickFactModal
          entityType={entityType}
          entityId={entityId}
          entityName={entityLabel(entities.find((e) => e.entityType === entityType && e.entityId === entityId))}
          onClose={() => setFactOpen(false)}
          onSaved={afterFactSaved}
        />
      ) : null}
      {importOpen ? (
        <ImportPackModal
          entities={entities}
          defaultEntity={currentEntity}
          onClose={() => setImportOpen(false)}
          onImported={afterPackImported}
        />
      ) : null}
    </main>
  );
}

/* ── Background ─────────────────────────────────────────────────── */

function BackgroundEffects() {
  return <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden />;
}

/* ── Header / Tabs / Search ─────────────────────────────────────── */

function AssetHeader({
  entityType,
  entityId,
  groupedEntities,
  onSelectEntity,
  activeTab,
  onTabChange,
  search,
  setSearch,
  searchOpen,
  setSearchOpen,
  searchHits,
  searchBusy,
  searchInputRef,
  onOpenHit,
}: {
  entityType: string;
  entityId: string;
  groupedEntities: Array<{ key: string; label: string; items: Entity[] }>;
  onSelectEntity: (entityType: string, entityId: string) => void;
  activeTab: AssetTab;
  onTabChange: (tab: AssetTab) => void;
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  searchOpen: boolean;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  searchHits: SearchHit[] | null;
  searchBusy: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onOpenHit: (path: string) => void;
}) {
  const tabs = useMemo(() => assetTabsForEntity(entityType), [entityType]);
  const userItem = groupedEntities.find((g) => g.key === "user")?.items?.[0];
  const employees = groupedEntities.find((g) => g.key === "employee")?.items ?? [];
  const hasEntity = groupedEntities.some((g) =>
    g.items.some((e) => e.entityType === entityType && e.entityId === entityId),
  );
  const showHits = searchOpen && search.trim().length >= 2;

  return (
    <header className="ac-header">
      <div className="ac-header-row">
        <div className="ac-brand">
          <span className="ac-brand-icon" aria-hidden>
            <PackageOpen size={18} strokeWidth={1.7} />
          </span>
          <div className="ac-brand-text">
            <h1 className="ac-title">资产中心</h1>
            <p className="ac-brand-sub">AI 的笔记本 · 画像 / 记忆 / 经验 / 反思</p>
          </div>
        </div>

        <div className="ac-header-actions">
          {hasEntity || userItem ? (
            <label className="ac-entity-picker" title="选择资产归属对象">
              <UserRound size={13} strokeWidth={1.7} className="shrink-0 text-[var(--ac-primary)]" />
              <select
                className="ac-entity-select"
                value={`${entityType}:${entityId}`}
                onChange={(e) => {
                  const [et, ...rest] = e.target.value.split(":");
                  if (et && rest.length) onSelectEntity(et, rest.join(":"));
                }}
                aria-label="当前对象"
              >
                {userItem ? (
                  <optgroup label="我">
                    <option value={`${userItem.entityType}:${userItem.entityId}`}>
                      {entityLabel(userItem)}
                    </option>
                  </optgroup>
                ) : null}
                {employees.length ? (
                  <optgroup label="员工">
                    {employees.map((e) => (
                      <option key={`${e.entityType}:${e.entityId}`} value={`${e.entityType}:${e.entityId}`}>
                        {entityLabel(e)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
          ) : null}

          <div className="ac-search">
            <Search size={14} strokeWidth={1.6} className="shrink-0 text-[var(--ac-text-faint)]" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => {
                window.setTimeout(() => setSearchOpen(false), 150);
              }}
              placeholder="搜索记忆、经验、反思全文…"
              className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-[var(--ac-text)] outline-none placeholder:text-[var(--ac-text-faint)]"
            />
            {searchBusy ? <span className="ac-spinner ac-spinner--inline" aria-hidden /> : null}
            {search ? (
              <button
                type="button"
                className="ac-search-clear"
                aria-label="清空搜索"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSearch("");
                  setSearchOpen(false);
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            ) : (
              <kbd className="ac-kbd">⌘ K</kbd>
            )}
            {showHits ? (
              <div className="ac-search-pop" role="listbox" aria-label="全文搜索结果">
                {searchHits && searchHits.length === 0 && !searchBusy ? (
                  <p className="ac-search-empty">没有匹配「{search.trim()}」的内容</p>
                ) : null}
                {(searchHits || []).map((hit) => (
                  <button
                    key={`${hit.path}:${hit.matchLine}`}
                    type="button"
                    className="ac-search-hit"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSearchOpen(false);
                      onOpenHit(hit.path);
                    }}
                  >
                    <FileText size={13} strokeWidth={1.6} className="ac-search-hit__icon" />
                    <span className="ac-search-hit__body">
                      <span className="ac-search-hit__name">{fileBaseName(hit.path)}</span>
                      <span className="ac-search-hit__path">{hit.path}</span>
                      {hit.snippet ? <span className="ac-search-hit__snippet">{hit.snippet}</span> : null}
                    </span>
                    <CornerDownLeft size={12} strokeWidth={1.6} className="ac-search-hit__go" />
                  </button>
                ))}
                {searchHits && searchHits.length > 0 ? (
                  <p className="ac-search-foot">回车或点击结果打开对应文件</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <nav className="ac-tabs" role="tablist" aria-label="资产分区">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(tab.id)}
              className={["ac-tab-btn", active ? "is-active" : ""].join(" ")}
            >
              <span className="ac-tab-icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </header>
  );
}

/* ── Overview ───────────────────────────────────────────────────── */

function OverviewPanel({
  entityType,
  entityId,
  stats,
  busy,
  canJournal,
  onQuickFact,
  onImport,
  onNewJournal,
  onOpenTab,
  onOpenPath,
  onConsolidate,
}: {
  entityType: string;
  entityId: string;
  stats: UsageStatsPayload | null;
  busy: boolean;
  canJournal: boolean;
  onQuickFact: () => void;
  onImport: () => void;
  onNewJournal: () => void;
  onOpenTab: (tab: AssetTab) => void;
  onOpenPath: (path: string) => void;
  onConsolidate: () => void | Promise<void>;
}) {
  const totals = stats?.totals || {};
  const maxDays = stats?.maxUnusedDays ?? 90;
  const hot = Array.isArray(stats?.hot) ? stats!.hot! : [];
  const staleRows = Array.isArray(stats?.stale) ? stats!.stale! : [];
  const inbox = Number(totals.inboxPending || 0);
  const stale = Number(totals.stale || 0);

  const tiles: {
    key: string;
    label: string;
    value: number;
    icon: React.ReactNode;
    tab: AssetTab;
    accent: string;
  }[] = [
    { key: "memory", label: "记忆文件", value: Number(totals.memoryFiles ?? 0), icon: <BrainCircuit size={16} />, tab: "memory", accent: "violet" },
    { key: "craft", label: "经验 / 技能", value: Number(totals.craftFiles ?? 0), icon: <Sparkles size={16} />, tab: "experience", accent: "amber" },
    { key: "uses", label: "工具引用", value: Number(totals.totalUses ?? 0), icon: <Activity size={16} />, tab: "manage", accent: "sky" },
    { key: "cites", label: "回复引用", value: Number(totals.totalCites ?? 0), icon: <Quote size={16} />, tab: "manage", accent: "emerald" },
    { key: "inbox", label: "待整合", value: inbox, icon: <Inbox size={16} />, tab: "manage", accent: "orange" },
    { key: "stale", label: "冷资产", value: stale, icon: <Clock size={16} />, tab: "manage", accent: "slate" },
  ];

  const steps: { title: string; desc: string; action?: { label: string; run: () => void } }[] = [
    {
      title: "对话中自动沉淀",
      desc: "在聊天里说「记住…」「沉淀成经验」「记一下反思」，Agent 会自动写进资产库，无需手动整理。",
    },
    {
      title: "来这里翻看与修改",
      desc: "画像、记忆、经验分门别类；像编辑文档一样直接改正错漏，保存即生效。",
      action: { label: "打开记忆库", run: () => onOpenTab("memory") },
    },
    {
      title: "导入与分享",
      desc: "从 .evoflow-pack 资产包一键导入他人的画像与经验；也能把自己的资产导出备份或分享给同事。",
      action: { label: "导入资产包", run: onImport },
    },
  ];

  return (
    <section className="ac-overview" data-testid="asset-overview">
      {/* Hero */}
      <div className="ac-hero">
        <div className="ac-hero-glow" aria-hidden />
        <div className="ac-hero-body">
          <span className="ac-hero-kicker">资产中心</span>
          <h2 className="ac-hero-title">让 AI 越用越懂你</h2>
          <p className="ac-hero-desc">
            画像、记忆、经验与反思都保存在本机资产库，Agent 对话时自动取用。
            这里负责翻看、修改、导入与备份。
          </p>
          <div className="ac-hero-actions">
            <button type="button" className="ac-cta" onClick={onQuickFact}>
              <Plus size={15} strokeWidth={2} />
              记住一条事实
            </button>
            <button type="button" className="ac-hero-btn" onClick={onImport}>
              <Download size={15} strokeWidth={1.8} />
              导入资产包
            </button>
            {canJournal ? (
              <button type="button" className="ac-hero-btn" onClick={onNewJournal}>
                <PenLine size={15} strokeWidth={1.8} />
                写今日反思
              </button>
            ) : null}
          </div>
        </div>
        <div className="ac-hero-art" aria-hidden>
          <span className="ac-hero-orb ac-hero-orb--1" />
          <span className="ac-hero-orb ac-hero-orb--2" />
          <span className="ac-hero-orb ac-hero-orb--3" />
        </div>
      </div>

      {/* Stat tiles */}
      <div className="ac-stat-tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`ac-tile ac-tile--${t.accent}`}
            onClick={() => onOpenTab(t.tab)}
          >
            <span className="ac-tile__icon">{t.icon}</span>
            <span className="ac-tile__value">{busy ? "—" : t.value}</span>
            <span className="ac-tile__label">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Hot / attention */}
      <div className="ac-ov-columns">
        <div className="ac-panel">
          <div className="ac-panel-head">
            <h3>高频引用</h3>
            <span className="ac-panel-hint">Agent 最近最常使用的资产</span>
          </div>
          {hot.length ? (
            <ul className="ac-hot-list">
              {hot.slice(0, 6).map((row) => (
                <li key={row.path}>
                  <button
                    type="button"
                    className="ac-hot-row"
                    title={row.path}
                    onClick={() => onOpenPath(row.path)}
                  >
                    <FileText size={13} strokeWidth={1.6} className="ac-hot-row__icon" />
                    <span className="ac-hot-row__name">{row.title || fileBaseName(row.path)}</span>
                    <span className="ac-hot-row__meta">
                      {row.useCount ? `工具×${row.useCount}` : null}
                      {row.useCount && row.citeCount ? " · " : null}
                      {row.citeCount ? `引用×${row.citeCount}` : null}
                      {(row.useCount || row.citeCount) && (row.lastUsedAt || row.lastCitedAt) ? " · " : null}
                      {formatRelativeTime(row.lastUsedAt || row.lastCitedAt || "")}
                    </span>
                    <ChevronRight size={14} strokeWidth={1.6} className="ac-hot-row__go" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ac-panel-empty">
              <p>暂无引用记录。</p>
              <p className="ac-panel-empty__sub">
                Agent 通过 assets(search / read) 或回复引用资产后，这里会展示使用热度。
              </p>
            </div>
          )}
        </div>

        <div className="ac-panel">
          <div className="ac-panel-head">
            <h3>需要关注</h3>
            <span className="ac-panel-hint">遗忘窗口 {maxDays} 天</span>
          </div>
          {inbox > 0 ? (
            <div className="ac-attention">
              <div className="ac-attention__row">
                <Inbox size={15} strokeWidth={1.7} className="ac-attention__icon" />
                <div className="min-w-0 flex-1">
                  <b>{inbox} 条待整合</b>
                  <p>_inbox 草稿 / 笔记等待 Phase2 整合进正式记忆</p>
                </div>
                <button type="button" className="ac-btn-secondary" disabled={busy} onClick={() => void onConsolidate()}>
                  立即整合
                </button>
              </div>
            </div>
          ) : null}
          {staleRows.length ? (
            <ul className="ac-hot-list">
              {staleRows.slice(0, inbox > 0 ? 3 : 6).map((row) => (
                <li key={`stale-${row.path}`}>
                  <button
                    type="button"
                    className="ac-hot-row is-stale"
                    title={row.path}
                    onClick={() => onOpenPath(row.path)}
                  >
                    <Clock size={13} strokeWidth={1.6} className="ac-hot-row__icon" />
                    <span className="ac-hot-row__name">{row.title || fileBaseName(row.path)}</span>
                    <span className="ac-hot-row__meta">{formatRelativeTime(row.lastUsedAt)}</span>
                    <ChevronRight size={14} strokeWidth={1.6} className="ac-hot-row__go" />
                  </button>
                </li>
              ))}
            </ul>
          ) : inbox > 0 ? null : (
            <div className="ac-panel-empty">
              <CheckCircle2 size={18} strokeWidth={1.6} className="ac-panel-empty__ok" />
              <p>一切正常</p>
              <p className="ac-panel-empty__sub">没有待整合的草稿，也没有超过 {maxDays} 天未使用的冷资产。</p>
            </div>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className="ac-steps">
        <h3 className="ac-section-title">三步上手</h3>
        <div className="ac-steps-grid">
          {steps.map((s, i) => (
            <div className="ac-step" key={s.title}>
              <span className="ac-step__no">{i + 1}</span>
              <div className="ac-step__body">
                <b>{s.title}</b>
                <p>{s.desc}</p>
                {s.action ? (
                  <button type="button" className="ac-step__link" onClick={s.action.run}>
                    {s.action.label}
                    <ChevronRight size={13} strokeWidth={1.8} />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Manage（统计 + 导入 + 导出 + 应用）──────────────────────────── */

function ManageWorkspace({
  vaultRoot,
  entityType,
  entityId,
  entities,
  applyTarget,
  setApplyTarget,
  applyScopes,
  setApplyScopes,
  exportHint,
  busy,
  stats,
  memoryRuns,
  onRefreshStats,
  onQuickFact,
  onImportPack,
  onPack,
  onMigrate,
  onScanAll,
  onConsolidate,
  onApply,
}: {
  vaultRoot: string;
  entityType: string;
  entityId: string;
  entities: Entity[];
  applyTarget: string;
  setApplyTarget: (v: string) => void;
  applyScopes: { profile: boolean; experience: boolean; memory: boolean; journal: boolean };
  setApplyScopes: React.Dispatch<
    React.SetStateAction<{ profile: boolean; experience: boolean; memory: boolean; journal: boolean }>
  >;
  exportHint: string;
  busy: boolean;
  stats: UsageStatsPayload | null;
  memoryRuns: MemoryRunRow[];
  onRefreshStats: () => void;
  onQuickFact: () => void;
  onImportPack: () => void;
  onPack: () => void | Promise<void>;
  onMigrate: (scope: string) => void | Promise<void>;
  onScanAll: () => void | Promise<void>;
  onConsolidate: () => void | Promise<void>;
  onApply: () => void | Promise<void>;
}) {
  const root = vaultRoot || "~/.evoflow/assets/";
  const rel =
    entityType === "user"
      ? "user"
      : entityType === "workspace"
        ? `workspaces/${entityId}`
        : `${entityType === "employee" ? "employees" : "agents"}/${entityId}`;
  const employees = entities.filter((e) => e.entityType === "employee");
  const canApply = !!applyTarget && Object.values(applyScopes).some(Boolean);
  const [applying, setApplying] = useState(false);
  const [migrating, setMigrating] = useState(false);

  const copyPath = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success("已复制路径");
  };
  const entityPath = `${root}${root.endsWith("/") || root.endsWith("\\") ? "" : "/"}${rel}`;

  const handleApply = async () => {
    if (!canApply || applying) return;
    setApplying(true);
    try {
      await onApply();
    } finally {
      setApplying(false);
    }
  };

  const handleMigrate = async () => {
    if (migrating) return;
    setMigrating(true);
    try {
      await onMigrate("all");
    } finally {
      setMigrating(false);
    }
  };

  return (
    <section className="ac-manage" data-testid="asset-manage">
      {/* 用量统计 */}
      <div className="ac-manage-section">
        <ManageSectionHead
          icon={<BarChart3 size={15} strokeWidth={1.7} />}
          title="用量统计"
          desc="search / read 记入 use_count；回复引用记入 cite_count。"
        >
          <button type="button" className="ac-btn-secondary" disabled={busy} onClick={onRefreshStats}>
            <RefreshCw size={14} strokeWidth={1.6} />
            刷新
          </button>
          <button type="button" className="ac-btn-secondary" disabled={busy} onClick={() => void onScanAll()}>
            <ScanSearch size={14} strokeWidth={1.6} />
            全库扫描
          </button>
        </ManageSectionHead>
        <StatsBody
          stats={stats}
          memoryRuns={memoryRuns}
          busy={busy}
          entityType={entityType}
          entityId={entityId}
          onConsolidate={onConsolidate}
        />
      </div>

      {/* 导入 */}
      <div className="ac-manage-section">
        <ManageSectionHead
          icon={<Upload size={15} strokeWidth={1.7} />}
          title="导入"
          desc="把外部资产装进当前资产库。"
        />
        <div className="ac-io-grid">
          <div className="ac-io-card">
            <span className="ac-io-card__icon"><FileArchive size={17} strokeWidth={1.6} /></span>
            <div className="ac-io-card__body">
              <b>导入资产包</b>
              <p>选择 .evoflow-pack 文件（他人分享或旧设备备份），一键导入画像 / 记忆 / 经验。</p>
            </div>
            <button type="button" className="ac-cta" onClick={onImportPack}>
              选择文件
            </button>
          </div>
          <div className="ac-io-card">
            <span className="ac-io-card__icon"><DatabaseBackup size={17} strokeWidth={1.6} /></span>
            <div className="ac-io-card__body">
              <b>迁移旧数据库</b>
              <p>把旧版本数据库中的经验与记忆正文一次性迁移为本机 Markdown 资产。</p>
            </div>
            <button type="button" className="ac-btn-secondary" disabled={migrating || busy} onClick={() => void handleMigrate()}>
              {migrating ? <span className="ac-spinner" aria-hidden /> : null}
              {migrating ? "迁移中…" : "开始迁移"}
            </button>
          </div>
        </div>
      </div>

      {/* 导出 */}
      <div className="ac-manage-section">
        <ManageSectionHead
          icon={<Download size={15} strokeWidth={1.7} />}
          title="导出与备份"
          desc="本机 Vault 路径可直接在编辑器中打开；Pack 可在别处导入。"
        />
        <div className="ac-io-card ac-io-card--wide">
          <div className="ac-kv-list">
            <KvRow label="Vault 根目录" value={root} onCopy={() => copyPath(root)} />
            <KvRow label="当前对象" value={entityPath} onCopy={() => copyPath(entityPath)} />
            <KvRow
              label="运行技能"
              value="~/.evoflow/skills/custom/"
              onCopy={() => copyPath("~/.evoflow/skills/custom/")}
            />
          </div>
          <div className="ac-io-card__foot">
            <button type="button" className="ac-btn-secondary" onClick={() => void onPack()}>
              <PackageOpen size={14} strokeWidth={1.6} />
              导出当前对象 Pack
            </button>
            {exportHint ? <span className="ac-io-card__hint">{exportHint}</span> : null}
          </div>
        </div>
      </div>

      {/* 应用到员工 */}
      <div className="ac-manage-section">
        <ManageSectionHead
          icon={<ArrowRightLeft size={15} strokeWidth={1.7} />}
          title="应用到员工"
          desc="把当前对象的资产共享给其他员工，让新员工快速继承经验。"
        />
        <div className="ac-io-card ac-io-card--wide">
          <div className="ac-check-group">
            {(
              [
                ["profile", "用户画像"],
                ["experience", "经验"],
                ["journal", "反思"],
                ["memory", "记忆"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="ac-check-label">
                <input
                  type="checkbox"
                  className="ac-check"
                  checked={applyScopes[key]}
                  onChange={(e) => setApplyScopes((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="ac-io-card__foot">
            <select
              value={applyTarget}
              onChange={(e) => setApplyTarget(e.target.value)}
              className="ac-select"
            >
              <option value="">选择目标员工…</option>
              {employees.map((e) => (
                <option key={e.entityId} value={`employee:${e.entityId}`}>
                  {e.label || e.entityId}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={!canApply || applying}
              className="ac-cta"
            >
              {applying ? <span className="ac-spinner" aria-hidden /> : null}
              {applying ? "应用中…" : "应用到目标"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ManageSectionHead({
  icon,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="ac-manage-head">
      <span className="ac-manage-head__icon">{icon}</span>
      <div className="ac-manage-head__text">
        <h2>{title}</h2>
        <p>{desc}</p>
      </div>
      <div className="ac-manage-head__actions">{children}</div>
    </div>
  );
}

function memoryRunStatusLabel(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "ok") return "成功";
  if (s === "skipped") return "跳过";
  if (s === "error") return "失败";
  return s || "—";
}

function memoryRunTriggerLabel(trigger: string): string {
  const t = String(trigger || "").toLowerCase();
  if (t === "queue") return "对话队列";
  if (t === "startup_scan") return "启动扫描";
  if (t === "manual") return "手动整合";
  return t || "—";
}

function StatsBody({
  busy,
  stats,
  memoryRuns = [],
  entityType,
  entityId,
  onConsolidate,
}: {
  busy: boolean;
  stats: UsageStatsPayload | null;
  memoryRuns?: MemoryRunRow[];
  entityType: string;
  entityId: string;
  onConsolidate: () => void | Promise<void>;
}) {
  const totals = stats?.totals || {};
  const maxDays = stats?.maxUnusedDays ?? 90;
  const hot = Array.isArray(stats?.hot) ? stats!.hot! : [];
  const staleRows = Array.isArray(stats?.stale) ? stats!.stale! : [];
  const inbox = Number(totals.inboxPending || 0);
  const totalUses = Number(totals.totalUses ?? 0);
  const totalCites = Number(totals.totalCites ?? 0);
  const runs = Array.isArray(memoryRuns) ? memoryRuns : [];

  return (
    <div className="ac-stats-wrap">
      <div className="ac-stats-grid">
        <div className="ac-stat-card">
          <span className="ac-stat-card__icon"><FileText size={18} /></span>
          <div>
            <span className="ac-stat-card__label">记忆文件</span>
            <strong className="ac-stat-card__value">{totals.memoryFiles ?? 0}</strong>
            <span className="ac-stat-card__hint">facts / episodic / journal / MEMORY</span>
          </div>
        </div>
        <div className="ac-stat-card">
          <span className="ac-stat-card__icon"><Activity size={18} /></span>
          <div>
            <span className="ac-stat-card__label">工具引用</span>
            <strong className="ac-stat-card__value">{totalUses}</strong>
            <span className="ac-stat-card__hint">assets(search/read) · use_count</span>
          </div>
        </div>
        <div className="ac-stat-card">
          <span className="ac-stat-card__icon"><Quote size={18} /></span>
          <div>
            <span className="ac-stat-card__label">回复引用</span>
            <strong className="ac-stat-card__value">{totalCites}</strong>
            <span className="ac-stat-card__hint">evo-asset-citation · cite_count</span>
          </div>
        </div>
        <div className="ac-stat-card">
          <span className="ac-stat-card__icon"><Inbox size={18} /></span>
          <div>
            <span className="ac-stat-card__label">待整合</span>
            <strong className="ac-stat-card__value">{inbox}</strong>
            <span className="ac-stat-card__hint">_inbox 草稿 / notes</span>
          </div>
        </div>
        <div className="ac-stat-card">
          <span className="ac-stat-card__icon"><Clock size={18} /></span>
          <div>
            <span className="ac-stat-card__label">冷资产</span>
            <strong className="ac-stat-card__value">{totals.stale ?? 0}</strong>
            <span className="ac-stat-card__hint">超 {maxDays} 天未用</span>
          </div>
        </div>
      </div>

      <div className="ac-stats-columns">
        <div className="ac-stats-block">
          <h3 className="ac-stats-block__title">高频引用</h3>
          {hot.length ? (
            <ul className="ac-stats-list">
              {hot.map((row) => (
                <li key={row.path}>
                  <a
                    className="ac-stats-list__link"
                    href={assetsHrefForPath(row.path, { entityType, entityId })}
                    title={row.path}
                  >
                    <span className="ac-stats-list__name">{row.title || fileBaseName(row.path)}</span>
                    <span className="ac-stats-list__meta">
                      {row.useCount ? `工具×${row.useCount}` : null}
                      {row.useCount && row.citeCount ? " · " : null}
                      {row.citeCount ? `引用×${row.citeCount}` : null}
                      {(row.useCount || row.citeCount) && (row.lastUsedAt || row.lastCitedAt) ? " · " : null}
                      {formatRelativeTime(row.lastUsedAt || row.lastCitedAt || "")}
                    </span>
                  </a>
                  {row.summary ? <p className="ac-stats-list__summary">{row.summary}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ac-stats-empty">暂无引用记录；Agent 使用 assets(search/read) 或回复 citation 后会出现在此。</p>
          )}
        </div>
        <div className="ac-stats-block">
          <h3 className="ac-stats-block__title">冷资产候选</h3>
          {staleRows.length ? (
            <ul className="ac-stats-list">
              {staleRows.map((row) => (
                <li key={`stale-${row.path}`}>
                  <a
                    className="ac-stats-list__link is-stale"
                    href={assetsHrefForPath(row.path, { entityType, entityId })}
                    title={row.path}
                  >
                    <span className="ac-stats-list__name">{row.title || fileBaseName(row.path)}</span>
                    <span className="ac-stats-list__meta">{formatRelativeTime(row.lastUsedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ac-stats-empty">无超期冷资产。</p>
          )}
        </div>
      </div>

      {inbox > 0 ? (
        <div className="ac-consolidate-bar">
          <Inbox size={15} strokeWidth={1.7} />
          <span>
            有 <b>{inbox}</b> 条待整合的草稿 / 笔记
          </span>
          <button type="button" className="ac-btn-primary" disabled={busy} onClick={() => void onConsolidate()}>
            立即整合
          </button>
        </div>
      ) : null}

      <div className="ac-stats-block ac-memory-runs">
        <h3 className="ac-stats-block__title">最近处理记录</h3>
        <p className="ac-stats-empty ac-memory-runs__hint">
          Phase1 抽取 / Phase2 整合的落库记录（对话队列、启动扫描、手动）。用来确认员工记忆是否真正跑过。
        </p>
        {runs.length ? (
          <ul className="ac-memory-runs__list">
            {runs.map((row) => {
              const status = String(row.status || "");
              const detail =
                status === "skipped"
                  ? row.skipReason || ""
                  : status === "error"
                    ? row.errorMessage || ""
                    : Array.isArray(row.paths) && row.paths.length
                      ? row.paths.slice(0, 3).join(", ")
                      : "";
              return (
                <li key={row.id || `${row.createdAt}-${row.phase}-${row.status}`} className="ac-memory-runs__row">
                  <div className="ac-memory-runs__main">
                    <span className={`ac-memory-runs__status is-${status}`}>{memoryRunStatusLabel(status)}</span>
                    <span className="ac-memory-runs__phase">{row.phase === "phase1" ? "Phase1" : "Phase2"}</span>
                    <span className="ac-memory-runs__trigger">{memoryRunTriggerLabel(String(row.trigger || ""))}</span>
                    <span className="ac-memory-runs__time">{formatRelativeTime(row.createdAt || "")}</span>
                  </div>
                  <div className="ac-memory-runs__meta">
                    {(() => {
                      const op = String(row.operatorId || row.principalId || "").trim();
                      return op ? <span title={op}>操作人 · {op.length > 24 ? `${op.slice(0, 22)}…` : op}</span> : null;
                    })()}
                    {row.threadId ? <span title={row.threadId}>thread · {row.threadId.slice(0, 10)}…</span> : null}
                    {detail ? <span className="ac-memory-runs__detail" title={detail}>{detail}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="ac-stats-empty">暂无处理记录。与该实体对话并等待防抖后，或点「立即整合 / 全库扫描」会出现在此。</p>
        )}
      </div>
    </div>
  );
}

/* ── File workspace ──────────────────────────────────────────────── */

function TreeWorkspace({
  tab,
  title,
  pathHint,
  files,
  fileSearch,
  setFileSearch,
  selectedFile,
  editorContent,
  fileDirty,
  fileLoading,
  lineCount,
  canGoUp,
  memoryKind,
  onMemoryKindChange,
  onQuickFact,
  onNewJournal,
  onUp,
  onRefresh,
  onOpenDir,
  onOpenFile,
  onPrefetchFile,
  onChangeContent,
  onSave,
}: {
  tab: TreeTab;
  title: string;
  pathHint: string;
  files: FileItem[];
  fileSearch: string;
  setFileSearch: React.Dispatch<React.SetStateAction<string>>;
  selectedFile: string;
  editorContent: string;
  fileDirty: boolean;
  fileLoading?: boolean;
  lineCount: number;
  canGoUp: boolean;
  memoryKind: MemoryKind;
  onMemoryKindChange: (k: MemoryKind) => void;
  onQuickFact: () => void;
  onNewJournal: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPrefetchFile?: (path: string) => void;
  onChangeContent: (v: string) => void;
  onSave: () => void;
}) {
  const emptyCopy: Record<TreeTab, { title: string; desc: string }> = {
    memory: {
      title: "还没有记忆",
      desc: "在聊天里说「记住…」即可自动沉淀；也可以手动记一条事实，Agent 检索时会直接引用。",
    },
    experience: {
      title: "还没有经验",
      desc: "经验（craft）来自对话中的沉淀与 Skills 市场安装，安装后可在此查看与修改。",
    },
    journal: {
      title: "还没有反思",
      desc: "每天一篇反思日志，记录「做了什么 / 学到什么 / 下次注意」。",
    },
  };
  const isEmpty = files.length === 0 && !fileSearch.trim();

  const toolbarRight =
    tab === "memory" ? (
      <button type="button" className="ac-btn-ghost" onClick={onQuickFact}>
        <Plus size={13} strokeWidth={1.8} />
        记住事实
      </button>
    ) : tab === "journal" ? (
      <button type="button" className="ac-btn-ghost" onClick={onNewJournal}>
        <PenLine size={13} strokeWidth={1.8} />
        新建今日反思
      </button>
    ) : (
      <a className="ac-btn-ghost" href="#/skills/market">
        <Sparkles size={13} strokeWidth={1.8} />
        Skills 市场
      </a>
    );

  return (
    <>
      {tab === "memory" ? (
        <div className="ac-toolbar">
          <div className="ac-seg" role="tablist" aria-label="记忆类型" data-testid="memory-kind-tabs">
            {MEMORY_KINDS.map((k) => {
              const isActive = memoryKind === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  title={k.hint}
                  onClick={() => onMemoryKindChange(k.id)}
                  className={["ac-seg-btn", isActive ? "is-active" : ""].join(" ")}
                >
                  {k.label}
                </button>
              );
            })}
          </div>
          <div className="ac-toolbar-right">{toolbarRight}</div>
        </div>
      ) : null}

      <SplitShell
        left={
          <FileSidebar
            title={title}
            pathHint={pathHint}
            files={files}
            fileSearch={fileSearch}
            setFileSearch={setFileSearch}
            selectedId={selectedFile}
            onSelectFile={(id) => onOpenFile(id)}
            onSelectFolder={(id) => onOpenDir(id)}
            onPrefetchFile={onPrefetchFile}
            onRefresh={onRefresh}
            headerExtra={
              canGoUp ? (
                <IconButton title="上级" onClick={onUp}>
                  <ArrowUp size={13} strokeWidth={1.7} />
                </IconButton>
              ) : null
            }
            footer={<VaultInfo />}
          />
        }
        right={
          isEmpty ? (
            <EmptyState
              icon={<FolderOpenArt />}
              title={emptyCopy[tab].title}
              desc={emptyCopy[tab].desc}
              action={
                tab === "memory" ? (
                  <button type="button" className="ac-cta" onClick={onQuickFact}>
                    <Plus size={15} strokeWidth={2} />
                    记住一条事实
                  </button>
                ) : tab === "journal" ? (
                  <button type="button" className="ac-cta" onClick={onNewJournal}>
                    <PenLine size={15} strokeWidth={1.8} />
                    新建今日反思
                  </button>
                ) : (
                  <a className="ac-cta" href="#/skills/market">
                    <Sparkles size={15} strokeWidth={1.8} />
                    去 Skills 市场
                  </a>
                )
              }
            />
          ) : (
            <EditorPanel
              pathLabel={selectedFile || "选择文件编辑"}
              content={editorContent}
              readonly={!selectedFile}
              loading={!!fileLoading}
              saved={!fileDirty}
              lineCount={lineCount}
              onChange={onChangeContent}
              onSave={onSave}
            />
          )
        }
      />
    </>
  );
}

function FileSidebar({
  title,
  pathHint,
  files,
  fileSearch,
  setFileSearch,
  selectedId,
  onSelectFile,
  onSelectFolder,
  onPrefetchFile,
  onRefresh,
  onReveal,
  headerExtra,
  footer,
}: {
  title: string;
  pathHint: string;
  files: FileItem[];
  fileSearch: string;
  setFileSearch: React.Dispatch<React.SetStateAction<string>>;
  selectedId: string;
  onSelectFile: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onPrefetchFile?: (id: string) => void;
  onRefresh: () => void;
  onReveal?: (id: string) => void;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <aside className="ac-explorer ac-rail">
      <div className="ac-rail-header flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-[18px] text-[var(--ac-text)]">{title}</h3>
          <p className="ac-mono mt-0.5 truncate text-[11px] leading-4 text-[var(--ac-text-faint)]">
            {pathHint}
          </p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          {headerExtra}
          <IconButton title="刷新" onClick={onRefresh}>
            <RefreshCw size={14} strokeWidth={1.6} />
          </IconButton>
        </div>
      </div>
      <div className="ac-rail-search">
        <div className="ac-input gap-2 px-2.5">
          <Search size={13} strokeWidth={1.6} className="text-[var(--ac-text-faint)]" />
          <input
            value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)}
            placeholder="搜索文件…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ac-text)] outline-none placeholder:text-[var(--ac-text-faint)]"
          />
        </div>
      </div>
      <div className="ac-rail-list">
        {!files.length ? (
          <p className="px-2 py-6 text-center text-[13px] text-[var(--ac-text-faint)]">暂无文件</p>
        ) : (
          files.map((file) => {
            const active = selectedId === file.id;
            return (
              <div
                key={file.id}
                className={["ac-tree-row", active ? "is-active" : ""].join(" ")}
                onMouseEnter={() => {
                  if (file.type === "file") onPrefetchFile?.(file.id);
                }}
                onFocusCapture={() => {
                  if (file.type === "file") onPrefetchFile?.(file.id);
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (file.type === "file") onSelectFile(file.id);
                    else onSelectFolder(file.path);
                  }}
                  className="flex w-full min-w-0 flex-1 items-center text-left"
                >
                  {file.type === "folder" ? (
                    <Folder size={14} strokeWidth={1.6} className="ac-tree-icon shrink-0 text-[var(--ac-folder)]" />
                  ) : (
                    <FileText
                      size={14}
                      strokeWidth={1.6}
                      className={[
                        "ac-tree-icon shrink-0",
                        active ? "text-[var(--ac-primary)]" : "text-[var(--ac-text-faint)]",
                      ].join(" ")}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  {file.count !== undefined && (
                    <span className="text-[11px] text-[var(--ac-text-faint)]">{file.count}</span>
                  )}
                </button>
                {onReveal && file.type === "file" && (
                  <IconButton
                    title="打开位置"
                    onClick={(e) => {
                      e?.stopPropagation();
                      onReveal(file.id);
                    }}
                  >
                    <Maximize2 size={13} strokeWidth={1.6} />
                  </IconButton>
                )}
              </div>
            );
          })
        )}
      </div>
      {footer ? <div className="ac-rail-footer">{footer}</div> : null}
    </aside>
  );
}

const EDITOR_LINE_PX = 23.8;
const EDITOR_PAD_PX = 12;

function EditorPanel({
  pathLabel,
  content,
  readonly,
  loading,
  saved,
  lineCount,
  onChange,
  onSave,
  extraActions,
}: {
  pathLabel: string;
  content: string;
  readonly?: boolean;
  loading?: boolean;
  saved: boolean;
  lineCount: number;
  onChange: (v: string) => void;
  onSave: () => void;
  extraActions?: React.ReactNode;
}) {
  const disabled = (readonly && !content) || !!loading;
  const parts = String(pathLabel || "").split("/");
  const fileName = parts[parts.length - 1] || pathLabel || "未选择";
  const dirPath = parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "";
  const scrollerRef = useRef<HTMLTextAreaElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);

  useEffect(() => {
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [pathLabel]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 480);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pathLabel]);

  const start = Math.max(0, Math.floor(Math.max(0, scrollTop - EDITOR_PAD_PX) / EDITOR_LINE_PX) - 4);
  const visible = Math.ceil(viewportH / EDITOR_LINE_PX) + 10;
  const end = Math.min(Math.max(lineCount, 1), start + visible);
  const gutterOffset = EDITOR_PAD_PX + start * EDITOR_LINE_PX - scrollTop;

  return (
    <section className="ac-main">
      <div className="ac-editor-toolbar">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-[18px] text-[var(--ac-text)]">
            {fileName}
          </div>
          {dirPath ? (
            <div className="ac-mono mt-px truncate text-[11px] leading-4 text-[var(--ac-text-faint)]">
              {dirPath}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {extraActions}
          <div className="flex items-center gap-1.5">
            <span
              className={[
                "h-1.5 w-1.5 rounded-full",
                saved ? "bg-[var(--ac-success)]" : "bg-[var(--ac-warning)]",
              ].join(" ")}
            />
            <span className="text-[12px] text-[var(--ac-text-muted)]">
              {loading ? "读取中…" : saved ? "已保存" : "未保存"}
            </span>
          </div>
          {!saved && (
            <button
              type="button"
              disabled={!!readonly}
              onClick={onSave}
              className="ac-btn-ghost gap-1"
            >
              <Save size={13} strokeWidth={1.6} />
              保存
            </button>
          )}
          <IconButton title="更多">
            <MoreVertical size={14} strokeWidth={1.6} />
          </IconButton>
        </div>
      </div>
      <div className="ac-editor-body">
        <div className="absolute inset-0 flex overflow-hidden">
          <div className="ac-gutter">
            <div style={{ marginTop: gutterOffset }}>
              {Array.from({ length: Math.max(0, end - start) }, (_, i) => (
                <div key={start + i} className="pr-2.5">
                  {start + i + 1}
                </div>
              ))}
            </div>
          </div>
          <textarea
            ref={scrollerRef}
            value={content}
            spellCheck={false}
            disabled={disabled}
            placeholder={loading ? "读取中…" : undefined}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onChange={(e) => onChange(e.target.value)}
            className="ac-editor-textarea disabled:opacity-50"
          />
        </div>
      </div>
      <div className="ac-editor-footer">
        <div className="flex items-center gap-3 text-[11px] leading-3">
          <span>Ln {lineCount}</span>
          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span>Markdown</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="复制全文"
            onClick={() => {
              void navigator.clipboard.writeText(content);
              toast.success("已复制");
            }}
            className="ac-status-btn"
          >
            <Copy size={12} strokeWidth={1.6} />
          </button>
          <button type="button" title="全屏" className="ac-status-btn">
            <Maximize2 size={12} strokeWidth={1.6} />
          </button>
        </div>
      </div>
    </section>
  );
}

function SplitShell({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="ac-split">
      {left}
      <div className="ac-split-line" aria-hidden />
      {right}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="ac-empty" data-testid="asset-empty-state">
      <div className="ac-empty__art">{icon}</div>
      <h3>{title}</h3>
      <p>{desc}</p>
      {action ? <div className="ac-empty__action">{action}</div> : null}
    </section>
  );
}

function FolderOpenArt() {
  return (
    <svg width="88" height="72" viewBox="0 0 88 72" fill="none" aria-hidden>
      <path
        d="M8 20c0-3.3 2.7-6 6-6h18l6 7h30c3.3 0 6 2.7 6 6v3H14l-6 26V20Z"
        fill="var(--ac-primary-soft)"
      />
      <path
        d="M14 30h60.5c3.9 0 6.7 3.7 5.7 7.4l-5.6 21A6 6 0 0 1 68.8 63H12.5a6 6 0 0 1-5.9-7.1l5.7-21A6 6 0 0 1 14 30Z"
        fill="var(--ac-primary)"
        fillOpacity="0.16"
        stroke="var(--ac-primary)"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <circle cx="70" cy="16" r="3" fill="var(--ac-primary)" fillOpacity="0.35" />
      <circle cx="20" cy="9" r="2" fill="var(--ac-primary)" fillOpacity="0.22" />
    </svg>
  );
}

function VaultInfo() {
  return (
    <div className="ac-vault" title="Markdown 资产可参与 Agent 长期上下文">
      <div className="ac-vault-title">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ac-primary)]" />
        本机资产库
      </div>
      <p className="ac-vault-desc">Markdown · Agent 上下文</p>
    </div>
  );
}

/* ── Modals ──────────────────────────────────────────────────────── */

function ModalShell({
  title,
  desc,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  desc: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ac-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ac-modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ac-modal-head">
          <div>
            <h3>{title}</h3>
            <p>{desc}</p>
          </div>
          <button type="button" className="ac-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className="ac-modal-body">{children}</div>
        {footer ? <div className="ac-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

function QuickFactModal({
  entityType,
  entityId,
  entityName,
  onClose,
  onSaved,
}: {
  entityType: string;
  entityId: string;
  entityName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const submit = async () => {
    const text = content.trim();
    if (!text) {
      toast.error("请输入要记住的内容");
      return;
    }
    setSaving(true);
    try {
      await api.assetsRecord({
        entityType,
        entityId,
        content: text,
        title: title.trim(),
        summary: "",
      });
      toast.success("已记入事实记忆");
      onSaved();
      onClose();
    } catch (e: unknown) {
      toast.error(String((e as { message?: string })?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title="记住一条事实"
      desc={`将写入 ${entityName} 的事实记忆（memory/facts/），Agent 检索时会直接引用。`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ac-btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ac-cta" disabled={saving || !content.trim()} onClick={() => void submit()}>
            {saving ? <span className="ac-spinner" aria-hidden /> : null}
            {saving ? "保存中…" : "记住"}
          </button>
        </>
      }
    >
      <label className="ac-field">
        <span className="ac-field__label">内容 *</span>
        <textarea
          ref={areaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="例如：我习惯用 Python 写脚本，包管理用 uv。"
          className="ac-field__input"
        />
      </label>
      <label className="ac-field">
        <span className="ac-field__label">标题（可选）</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：开发环境偏好"
          className="ac-field__input"
        />
      </label>
    </ModalShell>
  );
}

function ImportPackModal({
  entities,
  defaultEntity,
  onClose,
  onImported,
}: {
  entities: Entity[];
  defaultEntity: { entityType: string; entityId: string };
  onClose: () => void;
  onImported: () => void;
}) {
  const [packPath, setPackPath] = useState("");
  const employees = entities.filter((e) => e.entityType === "employee");
  const defKey = `${defaultEntity.entityType}:${defaultEntity.entityId}`;
  const [target, setTarget] = useState(
    defKey === "user:user" || defKey.startsWith("employee:") ? defKey : "user:user",
  );
  const [conflict, setConflict] = useState<"skip" | "overwrite">("skip");
  const [importing, setImporting] = useState(false);

  const pickFile = async () => {
    if (isTauriDesktop()) {
      try {
        const dlg = await import("@tauri-apps/plugin-dialog");
        const picked = await dlg.open({
          multiple: false,
          title: "选择 .evoflow-pack 资产包",
          filters: [
            { name: "Evoflow Pack", extensions: ["evoflow-pack", "zip"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
        const p = Array.isArray(picked) ? picked[0] : picked;
        if (p) setPackPath(String(p));
        return;
      } catch {
        /* fall through to prompt */
      }
    }
    const next = window.prompt("资产包绝对路径（.evoflow-pack）", packPath);
    if (next != null) setPackPath(String(next).trim());
  };

  const submit = async () => {
    const pack = packPath.trim();
    if (!pack) {
      toast.error("请先选择或填写资产包路径");
      return;
    }
    const [targetType, targetId] = target.split(":");
    if (!targetType || !targetId) {
      toast.error("请选择导入目标");
      return;
    }
    setImporting(true);
    try {
      const res = await api.assetsPackImport({
        entityType: targetType,
        entityId: targetId,
        packPath: pack,
        conflict,
      });
      toast.success(
        `导入完成：复制 ${res?.copied ?? 0}，跳过 ${res?.skipped ?? 0}`,
      );
      onImported();
      onClose();
    } catch (e: unknown) {
      toast.error(String((e as { message?: string })?.message || e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ModalShell
      title="导入资产包"
      desc="从 .evoflow-pack 文件导入画像 / 记忆 / 经验到指定对象。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ac-btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ac-cta" disabled={importing || !packPath.trim()} onClick={() => void submit()}>
            {importing ? <span className="ac-spinner" aria-hidden /> : null}
            {importing ? "导入中…" : "开始导入"}
          </button>
        </>
      }
    >
      <label className="ac-field">
        <span className="ac-field__label">资产包文件 *</span>
        <div className="ac-field-row">
          <input
            type="text"
            value={packPath}
            onChange={(e) => setPackPath(e.target.value)}
            placeholder="…/my-pack.evoflow-pack"
            className="ac-field__input ac-mono"
          />
          <button type="button" className="ac-btn-secondary" onClick={() => void pickFile()}>
            浏览…
          </button>
        </div>
      </label>
      <label className="ac-field">
        <span className="ac-field__label">导入到</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="ac-field__input">
          <option value="user:user">我（user）</option>
          {employees.map((e) => (
            <option key={e.entityId} value={`employee:${e.entityId}`}>
              {e.label || e.entityId}
            </option>
          ))}
        </select>
      </label>
      <label className="ac-field">
        <span className="ac-field__label">同名文件处理</span>
        <select
          value={conflict}
          onChange={(e) => setConflict(e.target.value === "overwrite" ? "overwrite" : "skip")}
          className="ac-field__input"
        >
          <option value="skip">跳过已存在的文件（推荐）</option>
          <option value="overwrite">覆盖已存在的文件</option>
        </select>
      </label>
      <p className="ac-field-hint">
        还没有资产包？在「管理 → 导出与备份」先把当前对象导出为 Pack 试试。
      </p>
    </ModalShell>
  );
}

/* ── Common ──────────────────────────────────────────────────────── */

function KvRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="ac-kv-row group">
      <span className="ac-kv-key">{label}</span>
      <span className="ac-kv-val" title={value}>
        {value}
      </span>
      <button
        type="button"
        title="复制"
        onClick={onCopy}
        className="ac-status-btn opacity-0 group-hover:opacity-100"
      >
        <Copy size={11} strokeWidth={1.6} />
      </button>
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title?: string;
  onClick?: (e?: React.MouseEvent) => void;
}) {
  return (
    <button type="button" title={title} onClick={(e) => onClick?.(e)} className="ac-icon-btn">
      {children}
    </button>
  );
}
