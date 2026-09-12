import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Database,
  Ellipsis,
  FileText,
  HardDrive,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../lib/tauri-api.js";
import { KnowledgeSourceTabs } from "./knowledge-source-tabs.jsx";
import { kbActivityLabel, kbActivityRelativeTime } from "./knowledge-owned-activity.js";
import { KB_UI_PLACEHOLDERS, kbSearchShortcutLabel } from "./knowledge-owned-placeholders.js";
import {
  LIST_PAGE_SIZE_OPTIONS,
  paginateItems,
  readStoredPageSize,
  writeStoredPageSize,
} from "../components/list-pager.js";

const OWNED_KB_PAGE_SIZE_KEY = "evopanel_owned_knowledge_page_size";

export function KnowledgeHero({ busy, onCreate }) {
  return (
    <header className="ko-hero">
      <div className="ko-hero__copy">
        <p className="ko-hub-brand">EvoFlow · Knowledge</p>
        <h1 data-testid="ko-page-title">知识库</h1>
        <p className="ko-hero__sub">
          本地优先的文档资产：上传即索引，阅读 / 概览 / 问 AI 一体完成。
        </p>
      </div>
      <div className="ko-hero__right">
        <KnowledgeSourceTabs active="owned" />
        <div className="ko-actions">
          <button className="ko-btn primary" disabled={busy} onClick={onCreate} type="button">
            新建知识库
          </button>
        </div>
      </div>
    </header>
  );
}

export function KnowledgeSearch({ value, onChange, onFocusAsk }) {
  const inputRef = useRef(null);
  const shortcut = useMemo(() => kbSearchShortcutLabel(), []);

  useEffect(() => {
    const onKey = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod || String(e.key).toLowerCase() !== "k") return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="ko-search-hero">
      <Search aria-hidden="true" className="ko-search-hero__icon" size={18} />
      <input
        aria-label="搜索知识库"
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocusAsk}
        placeholder="搜索知识库名称、描述…"
        ref={inputRef}
        type="search"
        value={value}
      />
      <kbd className="ko-search-hero__kbd">{shortcut}</kbd>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, hint }) {
  return (
    <div className="ko-stat-card">
      <div className="ko-stat-card__icon" aria-hidden="true">
        <Icon size={18} />
      </div>
      <div className="ko-stat-card__body">
        <span className="ko-stat-card__label">{label}</span>
        <strong className="ko-stat-card__value">{value}</strong>
        {hint ? <span className="ko-stat-card__hint">{hint}</span> : null}
      </div>
    </div>
  );
}

export function KnowledgeStats({ bases, docCounts }) {
  const totalDocs = useMemo(
    () => Object.values(docCounts || {}).reduce((sum, n) => sum + (Number(n) || 0), 0),
    [docCounts]
  );
  const localCount = (bases || []).filter((b) => b.embeddingMode === "local").length;
  const health = KB_UI_PLACEHOLDERS.healthScore;

  return (
    <div className="ko-stats" data-testid="ko-stats">
      <StatCard icon={Database} label="知识库" value={bases?.length ?? 0} hint="本地资产" />
      <StatCard icon={FileText} label="文档总量" value={totalDocs} hint="已索引文件" />
      <StatCard icon={HardDrive} label="本地嵌入" value={localCount} hint="embeddingMode=local" />
      <StatCard icon={Sparkles} label="健康度" value={`${health}%`} hint={KB_UI_PLACEHOLDERS.healthLabel} />
    </div>
  );
}

function KnowledgeListItem({ base, docCount, busy, onOpen, onDelete, onRename, onSettings }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const status = base.syncSourceType ? "synced" : "ready";

  return (
    <li className="ko-data-list__item">
      <button className="ko-data-list__main" onClick={() => onOpen(base.id)} type="button">
        <div className="ko-data-list__icon" aria-hidden="true">
          <BookOpen size={18} />
        </div>
        <div className="ko-data-list__copy">
          <div className="ko-data-list__title-row">
            <strong>{base.name}</strong>
            {base.builtin ? <span className="ko-badge is-builtin">内置</span> : null}
            <span className={`ko-status-dot is-${status}`} title={status === "synced" ? "已绑定同步源" : "已就绪"} />
          </div>
          <span className="ko-data-list__desc">
            {base.description || "本地知识库 · 可检索 / Wiki / 图谱"}
          </span>
        </div>
        <div className="ko-data-list__meta">
          <span>{docCount != null ? `${docCount} 文档` : "—"}</span>
          <span>
            {base.embeddingModelRef || base.embeddingModel
              ? String(base.embeddingModelRef || base.embeddingModel).replace(/^BAAI\//, "")
              : base.embeddingMode === "local"
                ? "本地嵌入"
                : "云端嵌入"}
          </span>
          <span>{base.updatedAt ? formatShortDate(base.updatedAt) : "—"}</span>
        </div>
      </button>
      <div className="ko-data-list__menu" ref={menuRef}>
        <button
          aria-label="更多操作"
          className="ko-icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          type="button"
        >
          <Ellipsis size={16} />
        </button>
        {menuOpen ? (
          <div className="ko-data-list__dropdown" role="menu">
            <button
              onClick={() => {
                setMenuOpen(false);
                onOpen(base.id);
              }}
              role="menuitem"
              type="button"
            >
              打开
            </button>
            {base.builtin ? null : (
              <button
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onRename?.(base.id, base.name);
                }}
                role="menuitem"
                type="button"
              >
                重命名
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                onSettings?.(base);
              }}
              role="menuitem"
              type="button"
            >
              设置
            </button>
            {base.builtin ? null : (
              <button
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(base.id, base.name);
                }}
                role="menuitem"
                type="button"
              >
                删除
              </button>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function formatShortDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return "—";
  }
}

export function KnowledgeList({ bases, docCounts, busy, onOpen, onDelete, onRename, onSettings }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => readStoredPageSize(OWNED_KB_PAGE_SIZE_KEY));
  const baseKey = (bases || []).map((b) => b.id).join("|");

  useEffect(() => {
    setPage(1);
  }, [baseKey]);

  if (!bases?.length) {
    return <div className="ko-empty">没有匹配的知识库</div>;
  }

  const paged = paginateItems(bases, page, pageSize);
  const pageNo = paged.page;
  const pageCount = paged.pageCount;

  return (
    <>
      <ul className="ko-data-list" data-testid="ko-base-grid">
        {paged.items.map((b) => (
          <KnowledgeListItem
            base={b}
            busy={busy}
            docCount={docCounts?.[b.id]}
            key={b.id}
            onDelete={onDelete}
            onOpen={onOpen}
            onRename={onRename}
            onSettings={onSettings}
          />
        ))}
      </ul>
      {paged.total > 0 ? (
        <div className="kb-list-pager-wrap">
          <div className="ef-list-pager" data-ef-list-pager role="navigation" aria-label="列表分页">
            <span className="ef-list-pager-meta">
              共 {paged.total} 个 · 第 {paged.from}–{paged.to} 个
            </span>
            <label className="ef-list-pager-size">
              每页
              <select
                aria-label="每页条数"
                value={pageSize}
                onChange={(e) => {
                  const next = Number(e.target.value) || 20;
                  setPageSize(next);
                  setPage(1);
                  writeStoredPageSize(OWNED_KB_PAGE_SIZE_KEY, next);
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
                disabled={pageNo <= 1}
                onClick={() => setPage(pageNo - 1)}
              >
                上一页
              </button>
              <span className="ef-list-pager-cur">
                {pageNo} / {pageCount}
              </span>
              <button
                type="button"
                className="ef-list-pager-btn"
                disabled={pageNo >= pageCount}
                onClick={() => setPage(pageNo + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function InsightHealth({ score, label, hints }) {
  return (
    <section className="ko-insight-card">
      <header className="ko-insight-card__head">
        <Sparkles size={16} aria-hidden="true" />
        <h3>健康度</h3>
      </header>
      <div className="ko-insight-health">
        <strong>{score}%</strong>
        <span>{label}</span>
      </div>
      <ul className="ko-insight-hints">
        {(hints || []).map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </section>
  );
}

function InsightTrend({ data }) {
  return (
    <section className="ko-insight-card">
      <header className="ko-insight-card__head">
        <TrendingUp size={16} aria-hidden="true" />
        <h3>访问趋势</h3>
      </header>
      <div className="ko-insight-chart">
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={data || []}>
            <defs>
              <linearGradient id="koTrendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--kb-blue)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="var(--kb-blue)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" hide />
            <YAxis hide domain={[0, "dataMax + 4"]} />
            <Tooltip
              contentStyle={{
                background: "var(--kb-card-bg)",
                border: "1px solid var(--kb-border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--kb-text-primary)",
              }}
              labelStyle={{ color: "var(--kb-text-secondary)" }}
            />
            <Area
              type="monotone"
              dataKey="visits"
              stroke="var(--kb-blue)"
              fill="url(#koTrendFill)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function InsightAssistant({ prompts, onPrompt }) {
  return (
    <section className="ko-insight-card">
      <header className="ko-insight-card__head">
        <Sparkles size={16} aria-hidden="true" />
        <h3>智能助手</h3>
      </header>
      <p className="ko-insight-assistant__hint">快捷提问将跳转到库内「问 AI」</p>
      <div className="ko-insight-assistant__actions">
        {(prompts || []).map((p) => (
          <button className="ko-btn ghost" key={p} onClick={() => onPrompt(p)} type="button">
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}

function InsightActivity({ items, onOpen }) {
  return (
    <section className="ko-insight-card" data-testid="ko-hub-activity">
      <header className="ko-insight-card__head">
        <TrendingUp size={16} aria-hidden="true" />
        <h3>最近活动</h3>
      </header>
      {items?.length ? (
        <ul className="ko-activity-list">
          {items.map((a) => (
            <li key={a.id}>
              <button
                className="ko-activity-list__btn"
                onClick={() => a.kbId && onOpen?.(a.kbId)}
                type="button"
              >
                <span className="ko-activity-list__action">{kbActivityLabel(a.action)}</span>
                <span className="ko-activity-list__title">{a.title || "—"}</span>
                <span className="ko-activity-list__time">{kbActivityRelativeTime(a.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ko-meta">暂无操作记录</p>
      )}
    </section>
  );
}

export function KnowledgeInsights({ onAssistantPrompt, onOpen, activities }) {
  const ph = KB_UI_PLACEHOLDERS;
  return (
    <aside className="ko-insights" data-testid="ko-insights">
      <InsightHealth score={ph.healthScore} label={ph.healthLabel} hints={ph.healthHints} />
      <InsightTrend data={ph.visitTrend} />
      <InsightActivity items={activities} onOpen={onOpen} />
      <InsightAssistant prompts={ph.assistantPrompts} onPrompt={onAssistantPrompt} />
    </aside>
  );
}

export function KnowledgeHubLayout({
  busy,
  loading,
  bases,
  filteredBases,
  docCounts,
  listFilter,
  onFilterChange,
  onCreate,
  onOpen,
  onDelete,
  onRename,
  onSettings,
  onAssistantPrompt,
}) {
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [activities, setActivities] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listOwnedKnowledgeActivities({ limit: 8 });
        if (!cancelled) setActivities(res.items || []);
      } catch {
        if (!cancelled) setActivities([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bases?.length]);

  return (
    <div className={`ko-hub${insightsOpen ? " is-insights-open" : ""}`}>
      <KnowledgeHero busy={busy} onCreate={onCreate} />
      <div className="ko-hub__toolbar">
        <button
          className="ko-btn ghost ko-hub__insights-toggle"
          onClick={() => setInsightsOpen((v) => !v)}
          type="button"
        >
          {insightsOpen ? "收起洞察" : "知识洞察"}
        </button>
      </div>
      <div className="ko-hub__grid">
        <div className="ko-hub__main">
          {loading ? (
            <div className="ko-empty">加载中…</div>
          ) : bases.length ? (
            <>
              <KnowledgeSearch value={listFilter} onChange={onFilterChange} />
              <KnowledgeStats bases={bases} docCounts={docCounts} />
              <KnowledgeList
                bases={filteredBases}
                busy={busy}
                docCounts={docCounts}
                onDelete={onDelete}
                onOpen={onOpen}
                onRename={onRename}
                onSettings={onSettings}
              />
            </>
          ) : (
            <div className="ko-empty-hero">
              <p className="ko-hub-brand">Initialize</p>
              <h2>还没有知识库</h2>
              <p>新建一个库后即可上传 Markdown / PDF / Office，立刻进入阅读与问答。</p>
              <button className="ko-btn primary" disabled={busy} onClick={onCreate} type="button">
                新建知识库
              </button>
            </div>
          )}
        </div>
        {bases.length ? (
          <>
            <button
              aria-label="关闭洞察"
              className="ko-insights-backdrop"
              onClick={() => setInsightsOpen(false)}
              type="button"
            />
            <KnowledgeInsights
              activities={activities}
              onAssistantPrompt={onAssistantPrompt}
              onOpen={onOpen}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
