import React, { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  UserRound,
  BrainCircuit,
  Sparkles,
  MessageCircleMore,
  FileOutput,
  Folder,
  FileText,
  Plus,
  RefreshCw,
  Save,
  MoreVertical,
  BarChart3,
  ChevronRight,
  ArrowUp,
  Copy,
  Maximize2,
  Archive,
  ArrowRightLeft,
  IdCard,
  Activity,
  Inbox,
  Clock,
  ScanSearch,
  Quote,
} from "lucide-react";
import { api } from "../lib/tauri-api.js";
import { toast } from "../components/toast.js";
import { getCurrentRoute } from "../router.js";

/* ── Types ───────────────────────────────────────────────────────── */

type AssetTab = "profile" | "memory" | "experience" | "journal" | "stats" | "export";

type TreeTab = "memory" | "experience" | "journal";

type MemoryKind = "standing" | "facts" | "episodic" | "graph";

type Entity = { entityType: string; entityId: string; label?: string; workspacePath?: string };

type TreeEntry = { name: string; path: string; kind: string };

type FileItem = { id: string; name: string; type: "folder" | "file"; path: string; count?: number };


const PROFILE_LABELS: Record<string, string> = {
  "basic-info.md": "基本信息",
  "preferences.md": "偏好与爱好",
  "persona.md": "画像与行为",
  "identity.md": "身份边界",
  "SOUL.md": "人格 SOUL",
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

const ASSET_TABS: { id: AssetTab; label: string; icon: React.ReactNode }[] = [
  { id: "profile", label: "画像", icon: <UserRound size={16} strokeWidth={1.6} /> },
  { id: "memory", label: "记忆", icon: <BrainCircuit size={16} strokeWidth={1.6} /> },
  { id: "experience", label: "经验", icon: <Sparkles size={16} strokeWidth={1.6} /> },
  { id: "journal", label: "反思", icon: <MessageCircleMore size={16} strokeWidth={1.6} /> },
  { id: "stats", label: "统计", icon: <BarChart3 size={16} strokeWidth={1.6} /> },
  { id: "export", label: "导出", icon: <FileOutput size={16} strokeWidth={1.6} /> },
];

const MEMORY_KINDS: { id: MemoryKind; label: string; hint: string }[] = [
  { id: "standing", label: "站立摘要", hint: "memory/standing.md" },
  { id: "facts", label: "事实", hint: "memory/facts/" },
  { id: "episodic", label: "过程记录", hint: "memory/episodic/" },
  { id: "graph", label: "图谱", hint: "实体关系图" },
];

const ENTITY_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: "user", label: "我", types: ["user"] },
  { key: "workspace", label: "工作区", types: ["workspace"] },
  { key: "employee", label: "员工", types: ["employee"] },
];

/** Agent entities hold profile/SOUL only — memory lives under user/. */
function assetTabsForEntity(entityType: string): typeof ASSET_TABS {
  const et = String(entityType || "").trim().toLowerCase();
  if (et === "agent") {
    return ASSET_TABS.filter((t) => t.id === "profile" || t.id === "export" || t.id === "stats");
  }
  // Workspaces are memory vaults — memory only.
  if (et === "workspace") {
    return ASSET_TABS.filter((t) => t.id === "memory");
  }
  // Profile (画像) is user-only; employees don't need it.
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
  if (t === "experience" || t === "exp") return "experience";
  if (t === "journal" || t === "reflect" || t === "reflection") return "journal";
  if (t === "skill" || t === "skills") return "experience";
  if (t === "image" || t === "profile") return "profile";
  if (ASSET_TABS.some((x) => x.id === t)) return t as AssetTab;
  const path = String(q.path || "").replace(/\\/g, "/");
  if (path.startsWith("craft/")) return "experience";
  if (path.startsWith("memory/journal/")) return "journal";
  if (path.startsWith("profile/")) return "profile";
  if (path.startsWith("memory/")) return "memory";
  return "memory";
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
  if (k === "standing" || k === "facts" || k === "episodic" || k === "graph") return k;
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

/** Map Asset Center entity → memory graph namespace / agent key. */
// 记忆图谱为重型图渲染（react-force-graph-2d / d3-force），仅在切到「记忆 → 图谱」时
// 才动态加载，避免打进资产中心首屏 chunk 导致打开慢。
const LazyMemoryGraphPanel = React.lazy(() =>
  import("../react/components/MemoryGraphPanel.jsx").then((m) => ({ default: m.default })),
);

function graphScopeForEntity(entityType: string, entityId: string): {
  agentId: string | null;
  namespace: string | null;
} {
  const et = String(entityType || "").trim().toLowerCase();
  const eid = String(entityId || "").trim();
  if (et === "workspace") {
    const key = eid.startsWith("workspace:") ? eid : `workspace:${eid}`;
    return { agentId: null, namespace: key };
  }
  if (et === "employee") {
    return { agentId: null, namespace: `person:${eid.toLowerCase()}` };
  }
  if (et === "agent") {
    return { agentId: null, namespace: `agent:${eid.toLowerCase()}` };
  }
  // user → default user namespace
  return { agentId: null, namespace: "user:default" };
}

/* ── Main ────────────────────────────────────────────────────────── */

export default function AssetCenterContent() {
  const initEnt = initialEntity();
  const [activeTab, setActiveTab] = useState<AssetTab>(initialTab);
  const [globalSearch, setGlobalSearch] = useState("");
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
  const [statsBusy, setStatsBusy] = useState(false);
  const pendingOpenPath = useRef(initialOpenPath());

  const currentEntity = useMemo(() => ({ entityType, entityId }), [entityType, entityId]);
  const isUserEntity = entityType === "user";

  const [tabLoading, setTabLoading] = useState(false);
  const initRanRef = useRef(false);


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

  const loadFile = useCallback(
    async (relPath: string) => {
      const data = await api.assetsReadFile({ ...currentEntity, path: relPath });
      setSelectedFile(relPath);
      setEditorContent(String(data?.content ?? ""));
      setFileDirty(false);
    },
    [currentEntity],
  );

  const applyMemoryKind = useCallback(
    async (kind: MemoryKind) => {
      setSelectedFile("");
      setEditorContent("");
      setFileDirty(false);
      if (kind === "graph") {
        setTreeEntries([]);
        setTreePath("memory");
        setTreeRoot("memory");
        return;
      }
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
    } catch (e: unknown) {
      setUsageStats(null);
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
          setSelectedFile("");
          setEditorContent("");
        } else if (tab === "stats") {
          await loadUsageStats();
        } else if (tab === "memory") {
          await applyMemoryKind(memoryKind);
        } else if (tab === "experience") {
          const root = treeRootForTab(tab);
          if (root) {
            await loadTree(root);
            setSelectedFile("");
            setEditorContent("");
            setFileDirty(false);
          }
        } else if (tab === "journal") {
          const root = treeRootForTab(tab);
          if (root) {
            await loadTree(root);
            setSelectedFile("");
            setEditorContent("");
            setFileDirty(false);
          }
        }
        /* export tab 无数据预加载 */
      } catch (e: unknown) {
        const msg = String((e as { message?: string })?.message || e);
        setError(msg);
        toast.error(msg);
      } finally {
        setTabLoading(false);
      }
    },
    [loadProfile, loadUsageStats, loadTree, applyMemoryKind, memoryKind],
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
      setActiveTab(allowed[0] || "profile");
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

  // 目录树加载完成后，自动选中第一个文件
  useEffect(() => {
    if (tabLoading || activeTab === "profile" || activeTab === "export" || activeTab === "stats") return;
    if (activeTab === "memory" && memoryKind === "graph") return;
    const pending = pendingOpenPath.current;
    if (pending) {
      pendingOpenPath.current = "";
      void loadFile(pending);
      return;
    }
    if (selectedFile) return;
    const first = treeEntries.find((e) => e.kind !== "dir");
    if (first) void loadFile(first.path);
  }, [treeEntries, selectedFile, activeTab, tabLoading, loadFile, memoryKind]);

  const graphScope = useMemo(
    () => graphScopeForEntity(entityType, entityId),
    [entityType, entityId],
  );


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
    const kw = (globalSearch || fileSearch).trim().toLowerCase();
    if (!kw) return items;
    return items.filter((f) => f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw));
  }, [treeEntries, fileSearch, globalSearch]);

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

  if (loading) {
    return (
      <main className="assets-center-root relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="ac-page relative z-10">
          {/* Header 骨架 */}
          <header className="ac-header">
            <div className="ac-header-row">
              <div className="ac-header-left min-w-0">
                <div className="ac-skeleton ac-skeleton--title" style={{ width: 80, height: 22 }} />
                <div className="mt-2 flex items-center gap-3">
                  <div className="ac-skeleton" style={{ width: 60, height: 20, borderRadius: 6 }} />
                  <div className="ac-skeleton" style={{ width: 60, height: 20, borderRadius: 6 }} />
                  <div className="ac-skeleton" style={{ width: 60, height: 20, borderRadius: 6 }} />
                </div>
                <div className="ac-skeleton mt-2" style={{ width: 140, height: 28, borderRadius: 6 }} />
              </div>
              <div className="ac-skeleton" style={{ width: 220, height: 32, borderRadius: 8 }} />
            </div>
          </header>

          {/* 内容骨架 */}
          <section className="ac-shell">
            <div className="flex gap-1 mb-2 px-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="ac-skeleton" style={{ width: 56, height: 32, borderRadius: 6 }} />
              ))}
            </div>
            <div className="ac-content">
              <div className="ac-split">
                {/* 左侧栏骨架 */}
                <aside className="ac-explorer ac-rail">
                  <div className="ac-rail-header">
                    <div className="ac-skeleton" style={{ width: 80, height: 16 }} />
                    <div className="ac-skeleton mt-1" style={{ width: 100, height: 12 }} />
                  </div>
                  <div className="ac-rail-search">
                    <div className="ac-skeleton" style={{ width: "100%", height: 30, borderRadius: 6 }} />
                  </div>
                  <div className="ac-rail-list space-y-1.5 px-2 pt-2">
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                      <div
                        key={i}
                        className="ac-skeleton"
                        style={{ width: "100%", height: 30, borderRadius: 4 }}
                      />
                    ))}
                  </div>
                </aside>
                <div className="ac-split-line" aria-hidden />
                {/* 右侧编辑区骨架 */}
                <section className="ac-main">
                  <div className="ac-editor-toolbar">
                    <div>
                      <div className="ac-skeleton" style={{ width: 120, height: 16 }} />
                      <div className="ac-skeleton mt-1" style={{ width: 160, height: 12 }} />
                    </div>
                  </div>
                  <div className="ac-editor-body p-4">
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                      <div
                        key={i}
                        className="ac-skeleton mb-2"
                        style={{
                          width: `${60 + Math.random() * 35}%`,
                          height: 12,
                          borderRadius: 3,
                        }}
                      />
                    ))}
                  </div>
                </section>
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
          search={globalSearch}
          setSearch={setGlobalSearch}
        />

        <section className="ac-shell">
          <AssetTabs activeTab={activeTab} onChange={changeTab} entityType={entityType} />
          {activeTab === "memory" ? (
            <MemoryKindTabs
              active={memoryKind}
              onChange={(k) => {
                setMemoryKind(k);
                void applyMemoryKind(k);
              }}
            />
          ) : null}

          <div className="ac-content">
            {tabLoading && activeTab !== "export" ? (
              <div className="ac-tab-loading">
                <div className="ac-tab-loading-spinner" />
                <span>加载中…</span>
              </div>

            ) : activeTab === "stats" ? (
              <AssetStatsPanel
                busy={statsBusy}
                stats={usageStats}
                entityType={entityType}
                entityId={entityId}
                onRefresh={() => void loadUsageStats()}
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
              />
            ) : activeTab === "export" ? (
              <ExportWorkspace
                vaultRoot={vaultRoot}
                entityType={entityType}
                entityId={entityId}
                entities={entities}
                applyTarget={applyTarget}
                setApplyTarget={setApplyTarget}
                applyScopes={applyScopes}
                setApplyScopes={setApplyScopes}
                exportHint={exportHint}
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
                    const res = await api.assetsMigrate({ scope });
                    if (scope === "slim") toast.success(`索引瘦身完成：${res?.slimmed ?? 0} 条`);
                    else
                      toast.success(
                        `迁移完成：经验 ${res?.experiences?.migrated ?? 0}，记忆 ${res?.memory?.mirrored ?? 0}`,
                      );
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  }
                }}
                onApply={async () => {
                  const [targetType, targetId] = String(applyTarget || "").split(":");
                  if (!targetType || !targetId) {
                    toast.error("请先选择目标员工或 Agent");
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
                    toast.error("目标不能与当前实体相同");
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
            ) : activeTab === "memory" && memoryKind === "graph" ? (
              <div className="ac-graph-pane">
                <React.Suspense
                  fallback={
                    <div className="ac-graph-loading" style={{ padding: 24, color: "var(--ac-text-faint)" }}>
                      记忆图谱加载中…
                    </div>
                  }
                >
                  {createElement(
                    LazyMemoryGraphPanel as React.ComponentType<{
                      agentId?: string | null;
                      namespace?: string | null;
                      entityType?: string;
                      entityId?: string;
                    }>,
                    {
                      agentId: graphScope.agentId,
                      namespace: graphScope.namespace,
                      entityType: entityType,
                      entityId: entityId,
                    },
                  )}
                </React.Suspense>
              </div>
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
                lineCount={lineCount}
                canGoUp={!!treePath && treePath !== treeRoot}
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
                    toast.success("已保存");
                    setFileDirty(false);
                  } catch (e: unknown) {
                    toast.error(String((e as { message?: string })?.message || e));
                  }
                }}
                onNewJournal={
                  activeTab === "journal"
                    ? async () => {
                        const path = todayJournalPath();
                        const stub = `# 反思 ${path.split("/").pop()?.replace(".md", "") || ""}\n\n## 今日做了什么\n\n\n## 学到什么\n\n\n## 下次注意\n\n`;
                        try {
                          await api.assetsPutFile({ ...currentEntity, path, content: stub });
                          await loadTree("memory/journal");
                          await loadFile(path);
                          toast.success("已创建今日反思");
                        } catch (e: unknown) {
                          toast.error(String((e as { message?: string })?.message || e));
                        }
                      }
                    : undefined
                }
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/* ── Background ─────────────────────────────────────────────────── */

function BackgroundEffects() {
  return <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden />;
}

/* ── Header / Tabs ───────────────────────────────────────────────── */

function AssetHeader({
  entityType,
  entityId,
  groupedEntities,
  onSelectEntity,
  search,
  setSearch,
}: {
  entityType: string;
  entityId: string;
  groupedEntities: Array<{ key: string; label: string; items: Entity[] }>;
  onSelectEntity: (entityType: string, entityId: string) => void;
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
}) {
  // 实体类型 Tab 始终展示（我/工作区/员工），仅隐藏无实体的类型；
  // 内容隔离由下拉框过滤 + 图谱 scope + 实体作用域数据加载负责，Tab 只负责导航。
  const isUserEntity = entityType === "user";
  const typeTabs = useMemo(() => {
    return ENTITY_GROUPS
      .filter((g) => g.key !== "workspace") // 资产中心不需要工作区 Tab
      .map((g) => ({
        key: g.key,
        label: g.label,
        count: groupedEntities.find((x) => x.key === g.key)?.items.length ?? 0,
      }))
      .filter((t) => t.count > 0);
  }, [groupedEntities]);

  const typeItems = useMemo(() => {
    return groupedEntities.find((g) => g.key === entityType)?.items ?? [];
  }, [groupedEntities, entityType]);

  // 实体隔离：员工/工作区页面只显示对应类型的实体
  const filteredTypeItems = useMemo(() => {
    if (isUserEntity) return typeItems;
    // 员工/工作区只显示同类型的实体
    return typeItems.filter((e) => e.entityType === entityType);
  }, [typeItems, entityType, isUserEntity]);

  const q = search.trim().toLowerCase();

  const selectOptions = useMemo(() => {
    if (!q) return filteredTypeItems;
    const matched = filteredTypeItems.filter((e) => {
      const label = entityLabel(e).toLowerCase();
      const id = String(e.entityId || "").toLowerCase();
      return label.includes(q) || id.includes(q);
    });
    // Keep current selection visible so the controlled <select> stays valid.
    const cur = filteredTypeItems.find((e) => e.entityType === entityType && e.entityId === entityId);
    if (cur && !matched.some((e) => e.entityId === cur.entityId)) {
      return [cur, ...matched];
    }
    return matched;
  }, [filteredTypeItems, q, entityType, entityId]);

  function pickType(key: string) {
    const items = groupedEntities.find((g) => g.key === key)?.items ?? [];
    if (!items.length) return;
    // 实体隔离：员工/工作区页面只能选择同类型实体
    const filtered = isUserEntity ? items : items.filter((e) => e.entityType === key);
    const keep = filtered.find((e) => e.entityType === entityType && e.entityId === entityId);
    const next = keep || filtered[0];
    if (next) onSelectEntity(next.entityType, next.entityId);
  }

  return (
    <header className="ac-header">
      <div className="ac-header-row">
        <div className="ac-header-left min-w-0">
          <h1 className="ac-title">资产中心</h1>
          <div className="ac-entity-type-tabs" role="tablist" aria-label="实体类型">
            {typeTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={entityType === t.key}
                className={["ac-entity-type-tab", entityType === t.key ? "is-active" : ""].join(" ")}
                onClick={() => pickType(t.key)}
              >
                {t.label}
                <span className="ac-entity-type-count">{t.count}</span>
              </button>
            ))}
          </div>
          <label className="ac-entity-select-wrap">
            <select
              className="ac-entity-select"
              value={`${entityType}:${entityId}`}
              onChange={(e) => {
                const [et, ...rest] = e.target.value.split(":");
                if (et && rest.length) onSelectEntity(et, rest.join(":"));
              }}
              aria-label="当前实体"
            >
              {selectOptions.map((e) => (
                <option
                  key={`${e.entityType}:${e.entityId}`}
                  value={`${e.entityType}:${e.entityId}`}
                  title={
                    e.entityType === "workspace" && e.workspacePath
                      ? e.workspacePath
                      : e.entityType !== "user"
                        ? e.entityId
                        : undefined
                  }
                >
                  {entityLabel(e)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="ac-search shrink-0">
          <Search size={14} strokeWidth={1.6} className="shrink-0 text-[var(--ac-text-faint)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索实体、资产、技能…"
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-[var(--ac-text)] outline-none placeholder:text-[var(--ac-text-faint)]"
          />
          <kbd className="ac-kbd">⌘ K</kbd>
        </div>
      </div>
      <p className="ac-header-desc">画像、记忆、经验、反思与技能 — 统一在此浏览与编辑</p>
    </header>
  );
}

function AssetStatsPanel({
  busy,
  stats,
  entityType,
  entityId,
  onRefresh,
  onConsolidate,
  onScanAll,
}: {
  busy: boolean;
  stats: UsageStatsPayload | null;
  entityType: string;
  entityId: string;
  onRefresh: () => void;
  onConsolidate: () => void | Promise<void>;
  onScanAll: () => void | Promise<void>;
}) {
  const totals = stats?.totals || {};
  const maxDays = stats?.maxUnusedDays ?? 90;
  const hot = Array.isArray(stats?.hot) ? stats!.hot! : [];
  const staleRows = Array.isArray(stats?.stale) ? stats!.stale! : [];
  const inbox = Number(totals.inboxPending || 0);
  const totalUses = Number(totals.totalUses ?? 0);
  const totalCites = Number(totals.totalCites ?? 0);

  return (
    <section className="ac-stats-panel" data-testid="asset-stats-panel">
      <div className="ac-stats-head">
        <div>
          <h2 className="ac-stats-title">资产用量统计</h2>
          <p className="ac-stats-desc">
            search/read → <code>use_count</code>；回复引用 → <code>cite_count</code>；遗忘窗口 {maxDays} 天
          </p>
        </div>
        <div className="ac-stats-actions">
          <button type="button" className="ac-btn-secondary" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={14} strokeWidth={1.6} />
            刷新
          </button>
          <button type="button" className="ac-btn-secondary" disabled={busy} onClick={() => void onScanAll()}>
            <ScanSearch size={14} strokeWidth={1.6} />
            全库扫描
          </button>
          {inbox > 0 ? (
            <button type="button" className="ac-btn-primary" disabled={busy} onClick={() => void onConsolidate()}>
              <Inbox size={14} strokeWidth={1.6} />
              整合 inbox（{inbox}）
            </button>
          ) : null}
        </div>
      </div>

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
                    <span className="ac-stats-list__name">{row.title || row.path.split("/").pop()}</span>
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
                    <span className="ac-stats-list__name">{row.title || row.path.split("/").pop()}</span>
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
    </section>
  );
}

function AssetTabs({
  activeTab,
  onChange,
  entityType,
}: {
  activeTab: AssetTab;
  onChange: (tab: AssetTab) => void;
  entityType: string;
}) {
  const tabs = assetTabsForEntity(entityType);
  return (
    <div className="ac-tabs" role="tablist">
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={["ac-tab-btn", active ? "is-active" : ""].join(" ")}
          >
            <span className="ac-tab-icon">{tab.icon}</span>
            <span>{tab.label}</span>
            {active && <span className="ac-tab-underline" />}
          </button>
        );
      })}
    </div>
  );
}

function MemoryKindTabs({
  active,
  onChange,
}: {
  active: MemoryKind;
  onChange: (kind: MemoryKind) => void;
}) {
  return (
    <div className="ac-subtabs" role="tablist" aria-label="记忆类型" data-testid="memory-kind-tabs">
      <span className="ac-subtabs-label">类型</span>
      {MEMORY_KINDS.map((k) => {
        const isActive = active === k.id;
        return (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={k.hint}
            onClick={() => onChange(k.id)}
            className={["ac-subtab-btn", isActive ? "is-active" : ""].join(" ")}
          >
            {k.label}
            {isActive ? <span className="ac-subtab-underline" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
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

/* ── File workspace ──────────────────────────────────────────────── */

function TreeWorkspace({

  title,
  pathHint,
  files,
  fileSearch,
  setFileSearch,
  selectedFile,
  editorContent,
  fileDirty,
  lineCount,
  canGoUp,
  onUp,
  onRefresh,
  onOpenDir,
  onOpenFile,
  onChangeContent,
  onSave,
  onNewJournal,
  onReveal,
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
  lineCount: number;
  canGoUp: boolean;
  onUp: () => void;
  onRefresh: () => void;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onChangeContent: (v: string) => void;
  onSave: () => void;
  onNewJournal?: () => void;
  onReveal?: (id: string) => void;
}) {
  return (
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
          onRefresh={onRefresh}
          onReveal={onReveal}
          headerExtra={
            canGoUp ? (
              <IconButton title="上级" onClick={onUp}>
                <ArrowUp size={13} strokeWidth={1.7} />
              </IconButton>
            ) : null
          }
          footer={
            <>

              {onNewJournal && (
                <div className="px-2 pt-2">
                  <button
                    type="button"
                    onClick={onNewJournal}
                    className="flex h-[34px] w-full items-center justify-center gap-1.5 rounded-[6px] text-[12px] text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
                  >
                    <Plus size={13} strokeWidth={1.7} />
                    新建今日反思
                  </button>
                </div>
              )}
              <VaultInfo />
            </>
          }
        />
      }
      right={
        <EditorPanel
          pathLabel={selectedFile || "选择文件编辑"}
          content={editorContent}
          readonly={!selectedFile}
          saved={!fileDirty}
          lineCount={lineCount}
          onChange={onChangeContent}
          onSave={onSave}

        />
      }
    />
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

function EditorPanel({
  pathLabel,
  content,
  readonly,
  saved,
  lineCount,
  onChange,
  onSave,
  extraActions,
}: {
  pathLabel: string;
  content: string;
  readonly?: boolean;
  saved: boolean;
  lineCount: number;
  onChange: (v: string) => void;
  onSave: () => void;
  extraActions?: React.ReactNode;
}) {
  const disabled = readonly && !content;
  const parts = String(pathLabel || "").split("/");
  const fileName = parts[parts.length - 1] || pathLabel || "未选择";
  const dirPath = parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "";

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
              {saved ? "已保存" : "未保存"}
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
            {Array.from({ length: lineCount }).map((_, i) => (
              <div key={i} className="pr-2.5">
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            value={content}
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="ac-editor-textarea disabled:opacity-50"
          />
        </div>
      </div>
      <div className="ac-editor-footer">
        <div className="flex items-center gap-3 text-[11px] leading-3">
          <span>Ln {lineCount}</span>
          <span>Col 1</span>
          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span>LF</span>
          <span>Markdown</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="复制"
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

function VaultInfo() {
  return (
    <div className="ac-vault" title="Markdown 资产可参与 Agent 长期上下文">
      <div className="ac-vault-title">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ac-primary)]" />
        资产库
      </div>
      <p className="ac-vault-desc">Markdown · Agent 上下文</p>
    </div>
  );
}


/* ── Export ──────────────────────────────────────────────────────── */

type ExportNavId = "entity" | "apply" | "tools";

function ExportWorkspace({
  vaultRoot,
  entityType,
  entityId,
  entities,
  applyTarget,
  setApplyTarget,
  applyScopes,
  setApplyScopes,
  exportHint,
  onPack,
  onMigrate,
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
  onPack: () => void | Promise<void>;
  onMigrate: (scope: string) => void | Promise<void>;
  onApply: () => void | Promise<void>;
}) {
  const [nav, setNav] = useState<ExportNavId>("entity");
  const [applying, setApplying] = useState(false);
  const root = vaultRoot || "~/.evoflow/assets/";
  const rel =
    entityType === "user"
      ? "user"
      : entityType === "workspace"
        ? `workspaces/${entityId}`
        : `${entityType === "employee" ? "employees" : "agents"}/${entityId}`;
  const employees = entities.filter((e) => e.entityType === "employee");
  const canApply = !!applyTarget && Object.values(applyScopes).some(Boolean);

  const scrollTo = (id: ExportNavId) => {
    setNav(id);
    document.getElementById(`ac-export-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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

  return (
    <SplitShell
      left={
        <aside className="ac-explorer ac-rail">
          <div className="ac-rail-header">
            <h3 className="text-[13px] font-semibold leading-[18px] text-[var(--ac-text)]">导出</h3>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--ac-text-faint)]">迁移与应用</p>
          </div>
          <div className="ac-rail-list space-y-0.5">
            {(
              [
                ["entity", "当前实体", <IdCard size={14} strokeWidth={1.6} key="e" />],
                ["apply", "应用到员工", <ArrowRightLeft size={14} strokeWidth={1.6} key="a" />],
                ["tools", "数据工具", <Archive size={14} strokeWidth={1.6} key="t" />],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => scrollTo(id)}
                className={["ac-nav-item", nav === id ? "is-active" : ""].join(" ")}
              >
                <span className={nav === id ? "text-[var(--ac-primary)]" : "text-[var(--ac-text-faint)]"}>
                  {icon}
                </span>
                {label}
              </button>
            ))}
            <a href="#/skills/market" className="ac-nav-item">
              <span className="text-[var(--ac-text-faint)]">
                <Sparkles size={14} strokeWidth={1.6} />
              </span>
              Skills 市场
            </a>
          </div>
          <div className="ac-rail-footer">
            <VaultInfo />
          </div>
        </aside>
      }
      right={
        <section className="ac-main">
          <div className="ac-export-main min-h-0 flex-1">
            <div className="mb-8">
              <h2 className="text-[16px] font-semibold leading-6 text-[var(--ac-text)]">导出与迁移</h2>
              <p className="mt-1 text-[13px] leading-5 text-[var(--ac-text-faint)]">
                将当前资产导出、迁移或应用到其他 Agent。
              </p>
            </div>

            <div id="ac-export-entity" className="ac-export-section">
              <h3 className="text-[13px] font-semibold leading-[18px] text-[var(--ac-text)]">存储位置</h3>
              <p className="mt-1 text-[12px] text-[var(--ac-text-faint)]">
                本机 Vault 路径，可直接在编辑器中打开
              </p>
              <div className="mt-3 space-y-0.5">
                <KvRow label="Vault 根目录" value={root} onCopy={() => copyPath(root)} />
                <KvRow label="当前实体" value={entityPath} onCopy={() => copyPath(entityPath)} />
                <KvRow
                  label="运行技能"
                  value="~/.evoflow/skills/custom/"
                  onCopy={() => copyPath("~/.evoflow/skills/custom/")}
                />
              </div>
              <div className="mt-4">
                <button type="button" onClick={() => void onPack()} className="ac-btn-secondary">
                  <Archive size={14} strokeWidth={1.6} />
                  导出当前实体 Pack
                </button>
                {exportHint ? (
                  <p className="mt-2 text-[12px] text-[var(--ac-text-muted)]">{exportHint}</p>
                ) : null}
              </div>
            </div>

            <div id="ac-export-apply" className="ac-export-section">
              <h3 className="text-[13px] font-semibold leading-[18px] text-[var(--ac-text)]">
                应用到员工
              </h3>
              <p className="mt-1 text-[12px] text-[var(--ac-text-faint)]">选择需要共享的资产范围</p>
              <div className="ac-check-group mt-4">
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
                      onChange={(e) =>
                        setApplyScopes((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2">
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

            <div id="ac-export-tools" className="ac-export-section">
              <h3 className="text-[13px] font-semibold leading-[18px] text-[var(--ac-text)]">数据工具</h3>
              <p className="mt-1 text-[12px] text-[var(--ac-text-faint)]">一次性从旧数据库导入到 assets 文件</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void onMigrate("all")}
                  className="ac-action-row"
                >
                  <span className="ac-action-icon">
                    <ArrowRightLeft size={15} strokeWidth={1.6} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-[var(--ac-text)]">导入旧库到 assets</div>
                    <div className="text-[12px] text-[var(--ac-text-faint)]">经验 + 记忆正文迁移为 Markdown</div>
                  </div>
                  <ChevronRight size={16} strokeWidth={1.5} className="shrink-0 text-[var(--ac-text-disabled)]" />
                </button>
                <a href="#/skills/market" className="ac-action-row">
                  <span className="ac-action-icon">
                    <Sparkles size={15} strokeWidth={1.6} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-[var(--ac-text)]">Skills 市场</div>
                    <div className="text-[12px] text-[var(--ac-text-faint)]">浏览与安装技能</div>
                  </div>
                  <ChevronRight size={16} strokeWidth={1.5} className="shrink-0 text-[var(--ac-text-disabled)]" />
                </a>
              </div>
            </div>
          </div>
        </section>
      }
    />
  );
}

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

/* ── Common ──────────────────────────────────────────────────────── */


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
