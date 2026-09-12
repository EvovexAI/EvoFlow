import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatCategoryLabel, truncateLabel } from "../../lib/knowledge-graph-layout.js";

/**
 * Left Knowledge Explorer — navigation, not decorative copy.
 */
export function KnowledgeNavExplorer({
  nodes = [],
  clusters = [],
  focusPath = null,
  favorites = [],
  history = [],
  pinnedIds = [],
  enabledClusters,
  onToggleCluster,
  degreeMin = 0,
  onDegreeMinChange,
  edgeMode = "balanced",
  onEdgeModeChange,
  nodeSizeScale = 1,
  onNodeSizeChange,
  labelDensity = 1,
  onLabelDensityChange,
  onSelectNode,
  onSearchLocate,
  searchQuery = "",
  onSearchQueryChange,
}) {
  const [expanded, setExpanded] = useState(() => new Set(clusters.map((c) => c.id)));
  const [filterText, setFilterText] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [quickTab, setQuickTab] = useState("fav");
  const listRef = useRef(null);
  const flatRef = useRef([]);

  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const c of clusters) next.add(c.id);
      return next;
    });
  }, [clusters]);

  const byCluster = useMemo(() => {
    const map = new Map();
    for (const n of nodes) {
      const cid = n.clusterId || n.category || "default";
      if (enabledClusters && enabledClusters.size && !enabledClusters.has(cid)) continue;
      if ((n.degree || 0) < degreeMin) continue;
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid).push(n);
    }
    for (const [, list] of map) {
      list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    }
    return map;
  }, [nodes, enabledClusters, degreeMin]);

  const q = (filterText || searchQuery || "").trim().toLowerCase();
  const filteredByCluster = useMemo(() => {
    if (!q) return byCluster;
    const map = new Map();
    for (const [cid, list] of byCluster) {
      const hit = list.filter((n) => {
        const hay = `${n.name || ""} ${n.path || ""}`.toLowerCase();
        return hay.includes(q);
      });
      if (hit.length) map.set(cid, hit);
    }
    return map;
  }, [byCluster, q]);

  const flatNodes = useMemo(() => {
    const out = [];
    for (const c of clusters) {
      if (!expanded.has(c.id)) continue;
      const list = filteredByCluster.get(c.id) || [];
      for (const n of list) out.push(n);
    }
    flatRef.current = out;
    return out;
  }, [clusters, expanded, filteredByCluster]);

  useEffect(() => {
    if (!focusPath || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-path="${CSS.escape(focusPath)}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      const node = nodes.find((n) => n.path === focusPath || n.id === focusPath);
      if (node) {
        const cid = node.clusterId || node.category;
        setExpanded((prev) => new Set(prev).add(cid));
      }
    }
  }, [focusPath, nodes]);

  const focusIndex = flatNodes.findIndex((n) => n.path === focusPath || n.id === focusPath);

  const onKeyDown = (e) => {
    if (!flatNodes.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const idx = focusIndex < 0 ? 0 : Math.max(0, Math.min(flatNodes.length - 1, focusIndex + dir));
      const n = flatNodes[idx];
      if (n) onSelectNode?.(n);
    } else if (e.key === "Enter" && focusIndex >= 0) {
      onSelectNode?.(flatNodes[focusIndex]);
    }
  };

  const pinnedNodes = useMemo(
    () => nodes.filter((n) => pinnedIds.includes(n.id) || n._userPinned),
    [nodes, pinnedIds]
  );

  const favNodes = useMemo(
    () =>
      favorites
        .map((p) => nodes.find((n) => n.path === p || n.id === p))
        .filter(Boolean),
    [favorites, nodes]
  );

  const recentNodes = useMemo(
    () =>
      history
        .map((h) => nodes.find((n) => n.path === h.path || n.id === h.path))
        .filter(Boolean)
        .slice(0, 12),
    [history, nodes]
  );

  const quickList =
    quickTab === "pin" ? pinnedNodes : quickTab === "recent" ? recentNodes : favNodes;
  const quickEmpty =
    quickTab === "pin" ? "暂无固定" : quickTab === "recent" ? "暂无记录" : "暂无收藏";

  const renderNodeBtn = (n, key) => {
    const active = focusPath === n.path || focusPath === n.id;
    return (
      <li key={key}>
        <button
          type="button"
          data-path={n.path || n.id}
          className={active ? "is-active" : ""}
          onClick={() => onSelectNode?.(n)}
          title={n.path}
        >
          {truncateLabel(n.name || n.path, 26)}
        </button>
      </li>
    );
  };

  return (
    <aside className="kv-nav-explorer" tabIndex={0} onKeyDown={onKeyDown} ref={listRef}>
      <header className="kv-nav-explorer__head">
        <h2>知识导航</h2>
        <input
          className="kv-nav-explorer__search"
          placeholder="搜索节点…"
          value={filterText}
          onChange={(e) => {
            setFilterText(e.target.value);
            onSearchQueryChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearchLocate?.(filterText);
          }}
          title="过滤列表；Enter 在图谱定位"
        />
      </header>

      <div className="kv-nav-explorer__scroll">
        <section className="kv-nav-explorer__section">
          <div className="kv-nav-explorer__section-head">
            <h3>分类</h3>
            <span className="kv-nav-explorer__count">{nodes.length}</span>
          </div>
          <div className="kv-nav-explorer__tree">
            {clusters.map((c) => {
              const list = filteredByCluster.get(c.id) || [];
              const open = expanded.has(c.id);
              const total = (byCluster.get(c.id) || []).length;
              return (
                <div key={c.id} className="kv-nav-explorer__cat">
                  <button
                    type="button"
                    className="kv-nav-explorer__cat-head"
                    onClick={() => {
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      });
                    }}
                  >
                    <span className="kv-nav-explorer__caret">{open ? "▾" : "▸"}</span>
                    <span className="kv-nav-explorer__dot" style={{ background: c.color }} />
                    <span className="kv-nav-explorer__cat-label">
                      {c.label || formatCategoryLabel(c.id)}
                    </span>
                    <em>{total}</em>
                  </button>
                  {open ? (
                    <ul className="kv-nav-explorer__nodes">
                      {list.map((n) => renderNodeBtn(n, n.id))}
                      {!list.length ? <li className="is-empty">无匹配</li> : null}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="kv-nav-explorer__section kv-nav-explorer__section--quick">
          <div className="kv-nav-explorer__section-head">
            <h3>快捷</h3>
          </div>
          <div className="kv-nav-explorer__tabs" role="tablist">
            {[
              ["fav", "收藏", favNodes.length],
              ["pin", "固定", pinnedNodes.length],
              ["recent", "最近", recentNodes.length],
            ].map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={quickTab === id ? "is-active" : ""}
                onClick={() => setQuickTab(id)}
              >
                {label}
                {count ? <em>{count}</em> : null}
              </button>
            ))}
          </div>
          <ul className="kv-nav-explorer__simple">
            {quickList.length
              ? quickList.map((n) => renderNodeBtn(n, `${quickTab}-${n.id}`))
              : <li className="is-empty">{quickEmpty}</li>}
          </ul>
        </section>
      </div>

      <section className={`kv-nav-explorer__section kv-nav-explorer__section--filters${filtersOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="kv-nav-explorer__filters-toggle"
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <span>筛选</span>
          <span className="kv-nav-explorer__caret">{filtersOpen ? "▾" : "▸"}</span>
        </button>
        {filtersOpen ? (
          <div className="kv-nav-explorer__filters-body">
            <div className="kv-nav-explorer__filters">
              {clusters.map((c) => {
                const on = !enabledClusters || enabledClusters.has(c.id);
                return (
                  <label key={`f-${c.id}`} className="kv-nav-explorer__check">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => onToggleCluster?.(c.id)}
                    />
                    <span className="kv-nav-explorer__dot" style={{ background: c.color }} />
                    <span className="kv-nav-explorer__check-label">
                      {c.label || formatCategoryLabel(c.id)}
                    </span>
                  </label>
                );
              })}
            </div>

            <label className="kv-nav-explorer__slider">
              <span>连接度 ≥ {degreeMin}</span>
              <input
                type="range"
                min="0"
                max="12"
                step="1"
                value={degreeMin}
                onChange={(e) => onDegreeMinChange?.(Number(e.target.value))}
              />
            </label>

            <label className="kv-nav-explorer__slider">
              <span>关系密度</span>
              <select value={edgeMode} onChange={(e) => onEdgeModeChange?.(e.target.value)}>
                <option value="sparse">精简</option>
                <option value="balanced">平衡</option>
                <option value="full">完整</option>
              </select>
            </label>

            <label className="kv-nav-explorer__slider">
              <span>节点大小</span>
              <input
                type="range"
                min="0.7"
                max="1.4"
                step="0.05"
                value={nodeSizeScale}
                onChange={(e) => onNodeSizeChange?.(Number(e.target.value))}
              />
            </label>

            <label className="kv-nav-explorer__slider">
              <span>标签密度</span>
              <input
                type="range"
                min="0.4"
                max="1.6"
                step="0.1"
                value={labelDensity}
                onChange={(e) => onLabelDensityChange?.(Number(e.target.value))}
              />
            </label>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
