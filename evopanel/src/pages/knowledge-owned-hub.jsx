import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
        <h1 data-testid="ko-page-title">知识库</h1>
        <p className="ko-hero__sub">
          把会被反复使用的资料放进来，让员工回答时有据可查。上传后先验证检索结果，再绑定到员工或任务。
        </p>
      </div>
      <div className="ko-hero__right">
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
  const summary = useMemo(() => {
    return (bases || []).reduce(
      (acc, base) => {
        const health = base.documentHealth || {};
        acc.total += Number(docCounts?.[base.id] ?? base.documentCount ?? 0) || 0;
        acc.ready += Number(health.ready) || 0;
        acc.processing += (Number(health.pending) || 0) + (Number(health.processing) || 0);
        acc.failed += Number(health.failed) || 0;
        return acc;
      },
      { total: 0, ready: 0, processing: 0, failed: 0 },
    );
  }, [bases, docCounts]);
  const localCount = (bases || []).filter((b) => b.embeddingMode === "local").length;
  const health = summary.total ? Math.round((summary.ready / summary.total) * 100) : 0;
  const healthHint = summary.failed
    ? `${summary.failed} 个文档需要处理`
    : summary.processing
      ? `${summary.processing} 个文档正在索引`
      : summary.total
        ? "全部文档可检索"
        : "上传资料后开始计算";

  return (
    <div className="ko-stats" data-testid="ko-stats">
      <StatCard icon={Database} label="知识库" value={bases?.length ?? 0} hint="按用途组织资料" />
      <StatCard icon={FileText} label="文档总量" value={summary.total} hint={`${summary.ready} 个已可检索`} />
      <StatCard icon={HardDrive} label="处理中" value={summary.processing} hint={summary.failed ? `${summary.failed} 个失败` : "等待完成后可问答"} />
      <StatCard icon={Sparkles} label="可用度" value={`${health}%`} hint={healthHint} />
    </div>
  );
}

function KnowledgeListItemMenu({
  base,
  busy,
  onClose,
  onOpen,
  onDelete,
  onSettings,
  onRevealDir,
  onToggleHidden,
  className,
  style,
  menuRef,
}) {
  return (
    <div className={className} ref={menuRef} role="menu" style={style}>
      <button
        onClick={() => {
          onClose();
          onOpen(base.id);
        }}
        role="menuitem"
        type="button"
      >
        打开
      </button>
      <button
        disabled={busy}
        onClick={() => {
          onClose();
          onSettings?.(base);
        }}
        role="menuitem"
        type="button"
      >
        设置
      </button>
      {base.resolvedStorageDir ? (
        <button
          onClick={() => {
            onClose();
            onRevealDir?.(base);
          }}
          role="menuitem"
          type="button"
        >
          打开所在目录
        </button>
      ) : null}
      {base.builtin ? null : (
        <button
          disabled={busy}
          onClick={() => {
            onClose();
            onDelete(base.id, base.name);
          }}
          role="menuitem"
          type="button"
        >
          删除
        </button>
      )}
      {base.builtin ? (
        <button
          disabled={busy}
          onClick={() => {
            onClose();
            onToggleHidden?.(base, !base.hidden);
          }}
          role="menuitem"
          type="button"
        >
          {base.hidden ? "恢复显示" : "停用（隐藏）"}
        </button>
      ) : null}
    </div>
  );
}

function KnowledgeListItem({ base, docCount, busy, onOpen, onDelete, onSettings, onRevealDir, onToggleHidden }) {
  const [menuOpen, setMenuOpen] = useState(false);
  /** null = anchor to ⋯; {x,y} = viewport coords via portal (right-click) */
  const [menuPos, setMenuPos] = useState(null);
  const menuRef = useRef(null);
  const portalMenuRef = useRef(null);

  const closeMenu = () => {
    setMenuOpen(false);
    setMenuPos(null);
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      const t = e.target;
      if (menuRef.current?.contains(t) || portalMenuRef.current?.contains(t)) return;
      closeMenu();
    };
    const onKey = (e) => {
      if (e.key === "Escape") closeMenu();
    };
    // Capture phase so we close before other handlers; skip the opening right-click.
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", closeMenu, true);
    };
  }, [menuOpen]);

  const health = base.documentHealth || {};
  const total = Number(docCount ?? base.documentCount ?? 0) || 0;
  const failed = Number(health.failed) || 0;
  const processing = (Number(health.pending) || 0) + (Number(health.processing) || 0);
  const ready = Number(health.ready) || 0;
  const status = failed ? "attention" : processing ? "processing" : total && ready === total ? "ready" : "empty";
  const statusLabel = failed
    ? `${failed} 个文档失败`
    : processing
      ? `${processing} 个文档处理中`
      : total
        ? `${ready} 个文档可检索`
        : "等待上传资料";

  const openMenuAt = (clientX, clientY) => {
    const pad = 8;
    const w = 148;
    const h = 220;
    const x = Math.min(Math.max(pad, clientX), window.innerWidth - w - pad);
    const y = Math.min(Math.max(pad, clientY), window.innerHeight - h - pad);
    setMenuPos({ x, y });
    setMenuOpen(true);
  };

  const menuProps = {
    base,
    busy,
    onClose: closeMenu,
    onOpen,
    onDelete,
    onSettings,
    onRevealDir,
    onToggleHidden,
  };

  return (
    <li
      className="ko-data-list__item"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenuAt(e.clientX, e.clientY);
      }}
    >
      <button className="ko-data-list__main" onClick={() => onOpen(base.id)} type="button">
        <div className="ko-data-list__icon" aria-hidden="true">
          <BookOpen size={18} />
        </div>
        <div className="ko-data-list__copy">
          <div className="ko-data-list__title-row">
            <strong>{base.name}</strong>
            {base.builtin ? <span className="ko-badge is-builtin">内置</span> : null}
            {base.hidden ? <span className="ko-badge is-hidden">已停用</span> : null}
            <span className={`ko-status-dot is-${status}`} title={statusLabel} />
          </div>
          <span className="ko-data-list__desc">
            {base.description || "本地资料库 · 上传后可检索、问答和阅读"}
          </span>
          <span className={`ko-data-list__health is-${status}`}>
            {status === "attention" ? "需要处理失败文档" : status === "processing" ? "资料正在建立索引" : status === "empty" ? "下一步：上传第一份资料" : "可以开始搜索或问 AI"}
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
            if (menuOpen && !menuPos) {
              closeMenu();
              return;
            }
            setMenuPos(null);
            setMenuOpen(true);
          }}
          type="button"
        >
          <Ellipsis size={16} />
        </button>
        {menuOpen && !menuPos ? (
          <KnowledgeListItemMenu {...menuProps} className="ko-data-list__dropdown" />
        ) : null}
      </div>
      {menuOpen && menuPos
        ? createPortal(
            <KnowledgeListItemMenu
              {...menuProps}
              className="ko-data-list__dropdown is-context"
              menuRef={portalMenuRef}
              style={{
                position: "fixed",
                left: menuPos.x,
                top: menuPos.y,
                right: "auto",
                zIndex: 10000,
              }}
            />,
            document.body,
          )
        : null}
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

export function KnowledgeList({ bases, docCounts, busy, onOpen, onDelete, onSettings, onRevealDir, onToggleHidden }) {
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
            onSettings={onSettings}
            onRevealDir={onRevealDir}
            onToggleHidden={onToggleHidden}
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

function InsightHealth({ score, label, hints, tone }) {
  return (
    <section className={`ko-insight-card ko-insight-card--health is-${tone || "ok"}`}>
      <header className="ko-insight-card__head">
        <Sparkles size={16} aria-hidden="true" />
        <h3>健康度</h3>
      </header>
      <div className="ko-insight-health">
        <strong>{score}%</strong>
        <span>{label}</span>
      </div>
      <ul className="ko-insight-hints">
        {(hints || []).map((h, i) => (
          <li key={`${h}-${i}`} className={`ko-insight-hint is-${h.kind || "ok"}`}>
            {h.text}
          </li>
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

export function KnowledgeInsights({ onAssistantPrompt, onOpen, activities, bases }) {
  // Aggregate real health across all bases instead of using the hard-coded
  // `KB_UI_PLACEHOLDERS.healthScore` (which used to show 86 / 92 even when
  // the banner said "失败 432").
  const agg = useMemo(() => aggregateBasesHealth(bases || []), [bases]);
  const trend = (KB_UI_PLACEHOLDERS && KB_UI_PLACEHOLDERS.visitTrend) || [];
  const prompts = (KB_UI_PLACEHOLDERS && KB_UI_PLACEHOLDERS.assistantPrompts) || [];
  return (
    <aside className="ko-insights" data-testid="ko-insights">
      <InsightHealth
        score={agg.score}
        label={agg.label}
        hints={agg.hints}
        tone={agg.tone}
      />
      <InsightTrend data={trend} />
      <InsightActivity items={activities} onOpen={onOpen} />
      <InsightAssistant prompts={prompts} onPrompt={onAssistantPrompt} />
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
  onSettings,
  onRevealDir,
  onAssistantPrompt,
  onToggleHidden,
  showHidden,
  onToggleShowHidden,
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
          className="ko-btn ghost"
          onClick={onToggleShowHidden}
          title="显示已停用（隐藏）的知识库"
          type="button"
        >
          {showHidden ? "隐藏已停用" : "显示已停用"}
        </button>
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
                onSettings={onSettings}
                onRevealDir={onRevealDir}
                onToggleHidden={onToggleHidden}
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
              bases={bases}
              onAssistantPrompt={onAssistantPrompt}
              onOpen={onOpen}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Aggregate real KB health from the list payload.
 *
 * Each base carries `documentHealth = {ready, pending, processing, failed}`
 * (filled by `owned_service._document_health_by_kb`). Combined with the
 * visible failed documents, this gives a defensible number to render in
 * the hub side panel.
 *
 * Returns: { score (0-100 int), label (cn), tone: ok|warn|err, hints: [{kind,text}] }
 */
function aggregateBasesHealth(bases) {
  let ready = 0;
  let pending = 0;
  let processing = 0;
  let failed = 0;
  let hidden = 0;
  for (const b of bases || []) {
    if (b && b.hidden) hidden += 1;
    const h = b && b.documentHealth;
    if (!h) continue;
    ready += Number(h.ready || 0);
    pending += Number(h.pending || 0);
    processing += Number(h.processing || 0);
    failed += Number(h.failed || 0);
  }
  const total = ready + pending + processing + failed;
  if (total === 0) {
    return {
      score: 100,
      label: "尚未上传",
      tone: "ok",
      hints: [{ kind: "ok", text: "还没有文档，上传后会显示真实健康度" }],
    };
  }
  const readyRatio = ready / total;
  let score = Math.round(readyRatio * 100);
  let label = "健康";
  if (failed > 0) {
    score = Math.max(0, score - Math.min(40, failed * 4));
    label = failed > total / 2 ? "大量失败" : "部分失败";
  }
  if (pending + processing > 0) {
    score = Math.max(0, score - Math.min(20, (pending + processing) * 2));
    if (label === "健康") label = "索引中";
  }
  const hints = [];
  if (failed > 0) {
    hints.push({
      kind: "err",
      text: `${failed} 篇文档解析失败，查看对应知识库的「索引状态」可重试`,
    });
  } else {
    hints.push({ kind: "ok", text: `没有失败文档（${ready}/${total} 已就绪）` });
  }
  if (pending + processing > 0) {
    hints.push({
      kind: "warn",
      text: `${pending + processing} 篇正在处理，等索引完成会回到 100`,
    });
  } else {
    hints.push({ kind: "ok", text: "所有文档已完成解析" });
  }
  if (hidden > 0) {
    hints.push({ kind: "warn", text: `另有 ${hidden} 个已停用知识库未计入` });
  }
  const tone = score >= 85 ? "ok" : score >= 60 ? "warn" : "err";
  return { score, label, tone, hints: hints.slice(0, 3) };
}
