import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  KnowledgeForceGraph,
  prepareForceGraphData,
} from "./KnowledgeForceGraph.jsx";
import { api } from "../../lib/tauri-api.js";
import { toast } from "../../components/toast.js";
import "../../pages/knowledge-vaults.css";

/**
 * Memory namespace entity graph — Asset Center 记忆 → 图谱.
 */
export default function MemoryGraphPanel({ agentId = null, namespace = null, entityType = "user", entityId = "user" }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [graph, setGraph] = useState({ nodes: [], edges: [], namespace: "", nodeCount: 0, edgeCount: 0 });
  const [focusNode, setFocusNode] = useState(null);
  const [atoms, setAtoms] = useState([]);
  const [atomsLoading, setAtomsLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // load defined first so onSyncAssets can reference it
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getMemoryGraph(agentId, {
        limit: 120,
        namespace: namespace || undefined,
      });
      setGraph({
        nodes: Array.isArray(data?.nodes) ? data.nodes : [],
        edges: Array.isArray(data?.edges) ? data.edges : [],
        namespace: data?.namespace || namespace || "",
        nodeCount: Number(data?.nodeCount || 0),
        edgeCount: Number(data?.edgeCount || 0),
      });
    } catch (e) {
      setError(e?.message || String(e));
      setGraph({ nodes: [], edges: [], namespace: "", nodeCount: 0, edgeCount: 0 });
    } finally {
      setLoading(false);
    }
  }, [agentId, namespace]);

  const onSyncAssets = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await api.syncAssetsToGraph(entityType, entityId, false);
      if (result?.ok) {
        toast.success(`同步完成：${result.synced} 条记录已写入图谱`);
        await load();
      } else {
        toast.error(result?.error || "同步失败");
      }
    } catch (e) {
      toast.error(e?.message || "同步失败");
    } finally {
      setSyncing(false);
    }
  }, [entityType, entityId, load]);

  useEffect(() => {
    void load();
  }, [load]);

  const prepared = useMemo(
    () => prepareForceGraphData(graph.nodes, graph.edges, { compact: true }),
    [graph.nodes, graph.edges],
  );

  const onNodeClick = useCallback(async (node) => {
    if (!node?.id) return;
    setFocusNode(node);
    setAtomsLoading(true);
    try {
      const res = await api.getMemoryGraphNodeAtoms(node.id, { limit: 40 });
      setAtoms(Array.isArray(res?.atoms) ? res.atoms : []);
    } catch {
      setAtoms([]);
    } finally {
      setAtomsLoading(false);
    }
  }, []);

  const onRebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await api.rebuildMemoryGraph(agentId, { clear: true, namespace: namespace || undefined });
      await load();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setRebuilding(false);
    }
  }, [agentId, namespace, load]);

  return (
    <div className="memory-graph-panel">
      <div className="memory-graph-toolbar">
        <div className="memory-graph-meta">
          <strong>{graph.namespace || "—"}</strong>
          <span>
            {graph.nodeCount} 实体 · {graph.edgeCount} 边
          </span>
        </div>
        <div className="memory-graph-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()} disabled={loading}>
            刷新
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => void onRebuild()}
            disabled={rebuilding || loading}
            title="清空后对全部原子重新 LLM 抽取"
          >
            {rebuilding ? "重建中…" : "重建图谱"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => void onSyncAssets()}
            disabled={syncing || loading}
            title="从 Asset Hub 同步记忆文件到图谱"
          >
            {syncing ? "同步中…" : "同步 Asset Hub"}
          </button>
        </div>
      </div>

      {error ? <p className="memory-muted">{error}</p> : null}
      {loading ? <p className="memory-muted">加载图谱…</p> : null}

      {!loading && graph.nodeCount === 0 ? (
        <div className="memory-inline-empty">
          <p className="memory-inline-empty-title">暂无记忆实体</p>
          <p className="memory-inline-empty-desc">
            写入情景/语义原子后会由 LLM 抽取建边。也可点「重建图谱」批量重抽。
          </p>
        </div>
      ) : null}

      <div className="memory-graph-body">
        <div className="memory-graph-canvas">
          {graph.nodeCount > 0 ? (
            <KnowledgeForceGraph
              prepared={prepared}
              rawNodes={graph.nodes}
              rawEdges={graph.edges}
              mode="compact"
              height={420}
              showToolbar={false}
              showDetailPanel={false}
              showLegend={false}
              onNodeClick={onNodeClick}
              className="memory-force-graph"
            />
          ) : null}
        </div>
        <aside className="memory-graph-side">
          <h4>{focusNode ? focusNode.label || focusNode.name || "实体" : "点选实体"}</h4>
          {!focusNode ? (
            <p className="memory-muted">点击左侧节点查看关联记忆原子。</p>
          ) : atomsLoading ? (
            <p className="memory-muted">加载原子…</p>
          ) : atoms.length === 0 ? (
            <p className="memory-muted">该节点暂无存活原子（可能已删除）。</p>
          ) : (
            <ul className="memory-fact-list">
              {atoms.map((atom) => (
                <li key={atom.id} className="memory-fact-card">
                  <div className="memory-fact-meta">
                    <span className="memory-fact-tag">{atom.layer || ""}</span>
                    <span className="memory-fact-meta-item">{atom.kind || ""}</span>
                  </div>
                  <p className="memory-fact-text">{atom.content || ""}</p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
