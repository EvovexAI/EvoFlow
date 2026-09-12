import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { forceCollide, forceManyBody, forceX, forceY } from "d3-force";
import {
  EDGE_STRENGTH_PRESETS,
  formatCategoryLabel,
  getForcePreset,
  getNeighborRings,
  prefersReducedMotion,
  prepareForceGraphData,
  truncateLabel,
} from "../../lib/knowledge-graph-layout.js";
import {
  FRESHNESS_COLORS,
  copyText,
  convexHull,
  findAllPaths,
  findShortestPath,
  freshnessTone,
  joinPath,
  loadFavorites,
  loadHistory,
  padHull,
  previewMarkdown,
  pushHistory,
  toggleFavorite,
} from "../../lib/knowledge-graph-explore.js";
import { readKnowledgeNotes } from "../../services/knowledge-vault-api.js";
import { api } from "../../lib/tauri-api.js";

const EMPTY_HL = {
  active: false,
  nodes: new Set(),
  ring1: new Set(),
  ring2: new Set(),
  focusId: null,
  clusterId: null,
  pathIds: new Set(),
  pathEdges: new Set(),
};

function hexToRgba(hex, alpha) {
  const h = String(hex || "#94A3B8").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(148, 163, 184, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function edgePoint(from, to, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / dist) * radius, y: from.y + (dy / dist) * radius };
}

function labelAlphaForZoom(globalScale, tier, density = 1) {
  const boost = density >= 1.5 ? -0.25 : density <= 0.5 ? 0.35 : 0;
  if (tier === "hub") return 1;
  if (tier === "top") return Math.min(1, Math.max(0, (globalScale - 0.55 + boost) / 0.35 + 0.65));
  if (tier === "mid") return Math.min(1, Math.max(0, (globalScale - 1.15 + boost) / 0.25));
  return Math.min(1, Math.max(0, (globalScale - 1.5 + boost) / 0.3));
}

function ContextMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    const onDown = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div
      className="kv-graph-ctx"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) =>
        item.sep ? (
          <div key={item.id} className="kv-graph-ctx__sep" />
        ) : (
          <button
            key={item.id}
            type="button"
            className="kv-graph-ctx__item"
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon ? <span>{item.icon}</span> : null}
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

/**
 * Product-grade explorative knowledge graph.
 */
export function KnowledgeForceGraph({
  rawNodes = [],
  rawEdges = [],
  prepared: preparedProp = null,
  mode = "explorer",
  centerPath = null,
  vaultId = null,
  vaultPath = "",
  vaultName = "",
  width,
  height,
  onNodeClick,
  onOpenDocument,
  onEditDocument,
  showToolbar = true,
  showLegend = true,
  showDetailPanel = true,
  shellMode = false,
  focusPath = null,
  onFocusPathChange,
  enabledClusters = null,
  degreeMin = 0,
  edgeMode: edgeModeProp = null,
  onEdgeModeChange,
  nodeSizeScale: nodeSizeProp = null,
  onNodeSizeChange,
  labelDensity: labelDensityProp = null,
  onLabelDensityChange,
  onMetaChange,
  theme = "light",
  className = "",
}) {
  const graphRef = useRef(null);
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const miniRef = useRef(null);
  const labelBoxesRef = useRef([]);
  const pulseUntilRef = useRef(0);
  const fittedRef = useRef(false);
  const resizeFitTimer = useRef(null);
  const pathAnchorRef = useRef(null);
  const hoverNodeRef = useRef(null);
  const activeNodeRef = useRef(null);
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const [hoverNode, setHoverNode] = useState(null);
  const [zoomK, setZoomK] = useState(1);
  const [highlight, setHighlight] = useState(EMPTY_HL);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [focusNode, setFocusNode] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [boxSelectMode, setBoxSelectMode] = useState(false);
  const [boxRect, setBoxRect] = useState(null);
  const boxDragRef = useRef(null);
  const boxRectRef = useRef(null);
  const [dims, setDims] = useState({ w: width || 640, h: height || 520 });
  const [edgeModeLocal, setEdgeModeLocal] = useState("balanced");
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [viewMode, setViewMode] = useState("global");
  const [hoverCluster, setHoverCluster] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState(() => new Set());
  const [relayouting, setRelayouting] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const [layoutLocked, setLayoutLocked] = useState(false);
  const [altDragHeld, setAltDragHeld] = useState(false);
  const [nodeSizeLocal, setNodeSizeLocal] = useState(1);
  const [labelDensityLocal, setLabelDensityLocal] = useState(1);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [pathMode, setPathMode] = useState("shortest"); // shortest | all | direct
  const [pathResult, setPathResult] = useState(null);
  const [noteDetail, setNoteDetail] = useState(null);
  const [favorites, setFavorites] = useState(() => (vaultId ? loadFavorites(vaultId) : []));
  const [history, setHistory] = useState(() => (vaultId ? loadHistory(vaultId) : []));
  const [toast, setToast] = useState("");
  const [pinnedIds, setPinnedIds] = useState([]);

  const edgeMode = edgeModeProp ?? edgeModeLocal;
  const setEdgeMode = onEdgeModeChange || setEdgeModeLocal;
  const nodeSizeScale = nodeSizeProp ?? nodeSizeLocal;
  const setNodeSizeScale = onNodeSizeChange || setNodeSizeLocal;
  const labelDensity = labelDensityProp ?? labelDensityLocal;
  const setLabelDensity = onLabelDensityChange || setLabelDensityLocal;
  const compact = mode === "compact";
  const forceMode = viewMode === "category" ? "explorer" : mode === "large" ? "explorer" : mode;
  const preset = useMemo(() => getForcePreset(forceMode), [forceMode]);

  useEffect(() => {
    if (!vaultId) return;
    setFavorites(loadFavorites(vaultId));
    setHistory(loadHistory(vaultId));
  }, [vaultId]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  }, []);

  const basePrepared = useMemo(() => {
    if (
      preparedProp &&
      layoutTick === 0 &&
      edgeMode === (preparedProp.edgeMode || "balanced") &&
      !showAllEdges
    ) {
      return preparedProp;
    }
    const nodes = preparedProp?.nodes?.length
      ? preparedProp.nodes.map((n) => ({
          path: n.path || n.id,
          id: n.id,
          title: n.title || n.name,
          community: n.community,
          category: n.category,
          tags: n.tags,
          modifiedAt: n.modifiedAt || n.modified_at,
        }))
      : rawNodes;
    const edges = preparedProp?.allLinks?.length ? preparedProp.allLinks : rawEdges;
    return prepareForceGraphData(nodes.length ? nodes : rawNodes, edges.length ? edges : rawEdges, {
      edgeMode,
      compact,
      centerPath,
      hubCount: centerPath ? 1 : 5,
      layoutSeed: preparedProp?.layoutSeed != null ? preparedProp.layoutSeed + layoutTick * 9973 : null,
      showAllEdges,
    });
  }, [preparedProp, rawNodes, rawEdges, edgeMode, showAllEdges, compact, centerPath, layoutTick]);

  const graph = basePrepared;
  const graphData = useMemo(() => ({ nodes: graph.nodes, links: graph.links }), [graph]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const fitView = useCallback(
    (ms = 450) => {
      const fg = graphRef.current;
      if (!fg) return;
      fg.zoomToFit(reducedMotion ? 0 : ms, Math.max(preset.fitPadding || 56, 50));
    },
    [preset.fitPadding, reducedMotion]
  );

  useEffect(() => {
    if (width && height) {
      setDims({ w: width, h: height });
      return undefined;
    }
    const el = canvasRef.current || wrapRef.current;
    if (!el) return undefined;

    const applySize = (w, h) => {
      if (!(w > 8 && h > 8)) return;
      const nextW = Math.floor(w);
      const nextH = Math.floor(h);
      setDims((prev) => {
        if (prev.w === nextW && prev.h === nextH) return prev;
        // 仅在尺寸变化较大时自动适应，避免点选开详情时的微调触发 zoom 吞掉双击
        const dw = Math.abs(prev.w - nextW);
        const dh = Math.abs(prev.h - nextH);
        if (dw > 48 || dh > 48) {
          clearTimeout(resizeFitTimer.current);
          resizeFitTimer.current = setTimeout(() => fitView(280), 160);
        }
        return { w: nextW, h: nextH };
      });
    };

    const measure = () => {
      const rect = el.getBoundingClientRect();
      applySize(rect.width, rect.height);
    };

    measure();
    requestAnimationFrame(measure);

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const { width: w, height: h } = entry.contentRect;
            applySize(w, h);
          })
        : null;
    ro?.observe(el);

    // display:none → 可见时 contentRect 常为 0，用 IntersectionObserver 补测
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0)) measure();
            },
            { threshold: [0, 0.01, 0.1] }
          )
        : null;
    io?.observe(el);

    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      io?.disconnect();
      window.removeEventListener("resize", measure);
      clearTimeout(resizeFitTimer.current);
    };
  }, [width, height, fitView]);

  const configureForces = useCallback(() => {
    const fg = graphRef.current;
    if (!fg || layoutLocked) return;
    const linkForce = fg.d3Force("link");
    if (linkForce) {
      linkForce
        .distance((link) =>
          typeof preset.linkDistance === "function" ? preset.linkDistance(link) : preset.linkDistance
        )
        .strength((link) =>
          typeof preset.linkStrength === "function" ? preset.linkStrength(link) : preset.linkStrength
        );
    }
    const clusterBoost = viewMode === "category" ? 1.45 : 1;
    fg.d3Force(
      "charge",
      forceManyBody()
        .strength((node) => preset.chargeStrength * (1 + ((node.radius || 8) / 28) * 0.7))
        .distanceMax(1100)
    );
    fg.d3Force(
      "collide",
      forceCollide()
        .radius((node) => {
          const labelPad = node.degreeRank <= 0.25 || node.isHub ? 22 : 10;
          return ((node.radius || 8) * nodeSizeScale) + preset.collidePad + labelPad * 0.35;
        })
        .strength(0.95)
        .iterations(3)
    );
    fg.d3Force(
      "clusterX",
      forceX()
        .x((node) => node.clusterX ?? node.islandCx ?? 0)
        .strength((node) => (node._userPinned ? 0 : preset.clusterStrength * clusterBoost))
    );
    fg.d3Force(
      "clusterY",
      forceY()
        .y((node) => node.clusterY ?? node.islandCy ?? 0)
        .strength((node) => (node._userPinned ? 0 : preset.clusterStrength * clusterBoost))
    );
    fg.d3Force(
      "islandX",
      forceX()
        .x((node) => node.islandCx || 0)
        .strength((node) => (node._userPinned ? 0 : preset.islandRepel || 0.05))
    );
    fg.d3Force(
      "islandY",
      forceY()
        .y((node) => node.islandCy || 0)
        .strength((node) => (node._userPinned ? 0 : preset.islandRepel || 0.05))
    );
    fg.d3Force("center")?.strength?.(preset.centerStrength);
  }, [preset, viewMode, layoutLocked, nodeSizeScale]);

  useEffect(() => {
    fittedRef.current = false;
    const t = requestAnimationFrame(() => {
      configureForces();
      if (!layoutLocked) graphRef.current?.d3ReheatSimulation?.();
    });
    return () => cancelAnimationFrame(t);
  }, [graphData, configureForces, layoutTick, viewMode, layoutLocked]);

  const handleEngineStop = useCallback(() => {
    setRelayouting(false);
    if (fittedRef.current) return;
    fittedRef.current = true;
    fitView(reducedMotion ? 0 : 600);
  }, [fitView, reducedMotion]);

  const applyNodeHighlight = useCallback(
    (node) => {
      if (!node) {
        setHighlight((h) => (h.pathIds?.size ? { ...EMPTY_HL, pathIds: h.pathIds, pathEdges: h.pathEdges, active: true, nodes: h.pathIds } : EMPTY_HL));
        return;
      }
      const { rings, all } = getNeighborRings(node.id, graph.adjacency, 2);
      setHighlight({
        active: true,
        nodes: all,
        ring1: rings[1] || new Set(),
        ring2: rings[2] || new Set(),
        focusId: node.id,
        clusterId: null,
        pathIds: new Set(),
        pathEdges: new Set(),
      });
    },
    [graph.adjacency]
  );

  const applyClusterHighlight = useCallback(
    (clusterId) => {
      if (!clusterId) {
        setHighlight(EMPTY_HL);
        return;
      }
      const nodes = new Set(
        graph.nodes.filter((n) => (n.clusterId || n.category) === clusterId).map((n) => n.id)
      );
      setHighlight({
        active: true,
        nodes,
        ring1: nodes,
        ring2: new Set(),
        focusId: null,
        clusterId,
        pathIds: new Set(),
        pathEdges: new Set(),
      });
    },
    [graph.nodes]
  );

  const applyPathHighlight = useCallback((pathIds, pathEdges) => {
    setHighlight({
      active: true,
      nodes: pathIds,
      ring1: pathIds,
      ring2: new Set(),
      focusId: null,
      clusterId: null,
      pathIds,
      pathEdges,
    });
  }, []);

  const loadInspectorData = useCallback(
    async (node) => {
      if (!vaultId || !node?.path) {
        setNoteDetail(null);
        return;
      }
      try {
        const read = await readKnowledgeNotes(vaultId, { paths: [node.path] });
        const note = read?.items?.[0] || read?.notes?.[0] || null;
        setNoteDetail(note);
        if (note?.modifiedAt || note?.modified_at) {
          node.modifiedAt = note.modifiedAt || note.modified_at;
        }
        if (Array.isArray(note?.tags)) node.tags = note.tags;
      } catch {
        setNoteDetail(null);
      }
    },
    [vaultId]
  );

  const selectNode = useCallback(
    (node, { openInspector = true, locate = false } = {}) => {
      if (!node) return;
      setFocusNode(node);
      setSelectedIds(new Set([node.id]));
      applyNodeHighlight(node);
      if (openInspector) setInspectorOpen(true);
      if (vaultId) {
        const nextHist = pushHistory(vaultId, node);
        setHistory(nextHist);
      }
      loadInspectorData(node);
      onFocusPathChange?.(node.path || node.id);
      if (locate && graphRef.current && node.x != null) {
        graphRef.current.centerAt(node.x, node.y, reducedMotion ? 0 : 420);
        graphRef.current.zoom(Math.max(graphRef.current.zoom() || 1, 1.25), reducedMotion ? 0 : 420);
      }
      if (onNodeClick) onNodeClick(node, { open: false });
    },
    [applyNodeHighlight, vaultId, loadInspectorData, onNodeClick, onFocusPathChange, reducedMotion]
  );

  // External focus from Explorer
  useEffect(() => {
    if (!focusPath) return;
    if (focusNode && (focusNode.path === focusPath || focusNode.id === focusPath)) return;
    const n = graph.nodes.find((x) => x.path === focusPath || x.id === focusPath);
    if (n) selectNode(n, { locate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath]);

  useEffect(() => {
    onMetaChange?.({
      favorites,
      history,
      pinnedIds,
      focusPath: focusNode?.path || focusNode?.id || null,
      zoomK,
      stats: graph.stats,
      clusters: graph.clusters,
      nodes: graph.nodes,
    });
  }, [favorites, history, pinnedIds, focusNode, zoomK, graph.stats, graph.clusters, graph.nodes, onMetaChange]);

  const runPathBetween = useCallback(
    (a, b) => {
      if (!a || !b) return;
      const adj = graph.fullAdjacency || graph.adjacency;
      let paths = [];
      if (pathMode === "direct") {
        const direct = (adj.get(a.id) || new Set()).has(b.id);
        paths = direct ? [[a.id, b.id]] : [];
      } else if (pathMode === "all") {
        paths = findAllPaths(adj, a.id, b.id);
      } else {
        const one = findShortestPath(adj, a.id, b.id);
        paths = one.length ? [one] : [];
      }
      setPathResult({ from: a, to: b, paths });
      if (paths[0]?.length) {
        const ids = new Set(paths[0]);
        const edges = new Set();
        for (let i = 0; i < paths[0].length - 1; i++) {
          edges.add(
            paths[0][i] < paths[0][i + 1]
              ? `${paths[0][i]}::${paths[0][i + 1]}`
              : `${paths[0][i + 1]}::${paths[0][i]}`
          );
        }
        applyPathHighlight(ids, edges);
        setInspectorOpen(true);
      } else {
        showToast("未找到连接路径");
      }
    },
    [graph, pathMode, applyPathHighlight, showToast]
  );

  const handleNodeHover = useCallback(
    (node) => {
      hoverNodeRef.current = node || null;
      setHoverNode(node || null);
      if (hoverCluster || pathResult?.paths?.length) return;
      applyNodeHighlight(node);
    },
    [applyNodeHighlight, hoverCluster, pathResult]
  );

  const openDocument = useCallback(
    (node) => {
      if (!node) return;
      const path = node.path || node.id;
      if (!path) {
        showToast("该节点没有可打开的文档路径");
        return;
      }
      if (onOpenDocument) onOpenDocument({ ...node, path });
      else if (onNodeClick) onNodeClick({ ...node, path }, { open: true });
    },
    [onOpenDocument, onNodeClick, showToast]
  );

  const editDocument = useCallback(
    (node) => {
      if (!node) return;
      if (onEditDocument) onEditDocument(node);
      else openDocument(node);
    },
    [onEditDocument, openDocument]
  );

  const revealInExplorer = useCallback(
    async (node) => {
      if (!node?.path) return;
      const abs = joinPath(vaultPath, node.path);
      try {
        await api.revealPathInFileManager(abs);
      } catch (err) {
        showToast(String(err?.message || "无法在资源管理器中打开"));
      }
    },
    [vaultPath, showToast]
  );

  const pinNode = useCallback((node, pinned = true) => {
    if (!node) return;
    node._userPinned = pinned;
    if (pinned) {
      node.fx = node.x;
      node.fy = node.y;
    } else {
      node.fx = undefined;
      node.fy = undefined;
    }
    setPinnedIds(
      graph.nodes.filter((n) => n._userPinned).map((n) => n.id)
    );
  }, [graph.nodes]);

  const nodeVisible = useCallback(
    (n) => {
      const cid = n.clusterId || n.category;
      if (enabledClusters && enabledClusters.size > 0 && !enabledClusters.has(cid)) return false;
      if ((n.degree || 0) < degreeMin) return false;
      return true;
    },
    [enabledClusters, degreeMin]
  );

  const handleNodeClick = useCallback(
    (node, event) => {
      if (!node) return;
      activeNodeRef.current = node;

      if (event?.ctrlKey || event?.metaKey) {
        if (!pathAnchorRef.current) {
          pathAnchorRef.current = node;
          selectNode(node);
          showToast("已选择起点，再 Ctrl+点击另一节点查看路径");
          return;
        }
        const from = pathAnchorRef.current;
        pathAnchorRef.current = null;
        selectNode(node);
        runPathBetween(from, node);
        return;
      }

      if (event?.shiftKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
        setFocusNode(node);
        applyNodeHighlight(node);
        return;
      }

      pathAnchorRef.current = null;
      setPathResult(null);
      selectNode(node);
    },
    [selectNode, showToast, runPathBetween, applyNodeHighlight]
  );

  // 原生 dblclick：force-graph 拖拽/缩放常会吞掉第二次 click，不能靠 click 计时模拟双击
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onDblClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const node = activeNodeRef.current || hoverNodeRef.current;
      if (!node) {
        showToast("请先对准节点再双击打开");
        return;
      }
      if (node._userPinned) pinNode(node, false);
      openDocument(node);
    };
    el.addEventListener("dblclick", onDblClick, true);
    return () => el.removeEventListener("dblclick", onDblClick, true);
  }, [openDocument, pinNode, showToast]);

  // 默认关闭节点拖拽，避免 mousedown 拖拽吞掉双击；按住 Alt 可拖动固定
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Alt") setAltDragHeld(e.type === "keydown");
    };
    const onBlur = () => setAltDragHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const handleNodeRightClick = useCallback(
    (node, event) => {
      event?.preventDefault?.();
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = (event?.clientX || 0) - (rect?.left || 0);
      const y = (event?.clientY || 0) - (rect?.top || 0);
      setFocusNode(node);
      setCtxMenu({
        x: Math.min(x, (rect?.width || 400) - 200),
        y: Math.min(y, (rect?.height || 400) - 280),
        node,
      });
    },
    []
  );

  const handleNodeDrag = useCallback((node) => {
    pinNode(node, true);
  }, [pinNode]);

  const handleNodeDragEnd = useCallback(
    (node) => {
      pinNode(node, true);
      if (!layoutLocked) {
        configureForces();
        graphRef.current?.d3ReheatSimulation?.();
      }
    },
    [pinNode, layoutLocked, configureForces]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setFocusNode(null);
    setHighlight(EMPTY_HL);
    setPathResult(null);
    pathAnchorRef.current = null;
    setBoxRect(null);
    setHoverCluster(null);
    setNoteDetail(null);
  }, []);

  // Box select
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const syncBox = (next) => {
      boxRectRef.current = next;
      setBoxRect(next);
    };
    const onDown = (event) => {
      if (event.button !== 0) return;
      if (!(boxSelectMode || event.shiftKey) || event.ctrlKey || event.metaKey) return;
      if (event.target?.closest?.(".kv-force-graph__legend, .kv-force-graph__minimap, .kv-graph-ctx")) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      const x0 = event.clientX - rect.left;
      const y0 = event.clientY - rect.top;
      boxDragRef.current = { x0, y0, active: true };
      syncBox({ x: x0, y: y0, w: 0, h: 0 });
    };
    const onMove = (event) => {
      const drag = boxDragRef.current;
      if (!drag?.active) return;
      const rect = el.getBoundingClientRect();
      const x1 = event.clientX - rect.left;
      const y1 = event.clientY - rect.top;
      syncBox({
        x: Math.min(drag.x0, x1),
        y: Math.min(drag.y0, y1),
        w: Math.abs(x1 - drag.x0),
        h: Math.abs(y1 - drag.y0),
      });
    };
    const onUp = () => {
      const drag = boxDragRef.current;
      const rect = boxRectRef.current;
      boxDragRef.current = null;
      if (!drag?.active || !rect || rect.w < 4 || rect.h < 4) {
        syncBox(null);
        return;
      }
      const fg = graphRef.current;
      if (!fg) {
        syncBox(null);
        return;
      }
      const next = new Set();
      for (const node of graph.nodes) {
        if (node.x == null || node.y == null) continue;
        const screen = fg.graph2ScreenCoords(node.x, node.y);
        if (screen.x >= rect.x && screen.x <= rect.x + rect.w && screen.y >= rect.y && screen.y <= rect.y + rect.h) {
          next.add(node.id);
        }
      }
      setSelectedIds(next);
      if (next.size === 1) {
        const n = graph.nodes.find((x) => x.id === [...next][0]);
        if (n) selectNode(n);
      }
      syncBox(null);
    };
    el.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [boxSelectMode, graph.nodes, selectNode]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (searchQuery) {
          setSearchQuery("");
          setSearchHits(new Set());
          return;
        }
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchQuery, clearSelection]);

  const paintClusters = useCallback(
    (ctx, globalScale) => {
      for (const cluster of graph.clusters || []) {
        const members = graph.nodes.filter((n) => (n.clusterId || n.category) === cluster.id);
        if (members.length < 2) continue;
        const pts = members.map((n) => ({
          x: n.x,
          y: n.y,
          r: (n.radius || 8) * nodeSizeScale,
        }));
        const hull = padHull(
          convexHull(pts.map((p) => ({ x: p.x, y: p.y }))),
          20 + 8 / globalScale
        );
        if (hull.length < 3) continue;
        const dim =
          (highlight.clusterId && highlight.clusterId !== cluster.id) ||
          (hoverCluster && hoverCluster !== cluster.id);
        const hovered = hoverCluster === cluster.id || highlight.clusterId === cluster.id;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
        ctx.closePath();
        ctx.globalAlpha = dim ? 0.012 : hovered ? 0.07 : 0.035;
        ctx.fillStyle = cluster.color || "#94A3B8";
        ctx.fill();
        ctx.globalAlpha = dim ? 0.2 : hovered ? 0.85 : 0.75;
        const fontSize = 12.5 / globalScale;
        ctx.font = `600 ${fontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillStyle = cluster.color || "#64748b";
        let minY = Infinity;
        let minX = Infinity;
        let maxX = -Infinity;
        for (const p of hull) {
          minY = Math.min(minY, p.y);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
        }
        const title = `${cluster.label || formatCategoryLabel(cluster.id)}`;
        ctx.fillText(title, minX + 4 / globalScale, minY + 14 / globalScale);
        ctx.globalAlpha = dim ? 0.15 : 0.55;
        ctx.font = `500 ${(fontSize * 0.9).toFixed(2)}px "Segoe UI", sans-serif`;
        ctx.fillText(String(members.length), maxX - 18 / globalScale, minY + 14 / globalScale);
        ctx.restore();
      }
    },
    [graph.clusters, graph.nodes, highlight.clusterId, hoverCluster, nodeSizeScale]
  );

  const paintNodePointerArea = useCallback(
    (node, color, ctx) => {
      if (!nodeVisible(node)) return;
      const r = Math.max(6, (node.radius || 8) * nodeSizeScale + 4);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
    },
    [nodeVisible, nodeSizeScale]
  );

  const paintNode = useCallback(
    (node, ctx, globalScale) => {
      const baseR = (node.radius || 8) * nodeSizeScale;
      const isHover = hoverNode?.id === node.id;
      const isFocus = focusNode?.id === node.id || selectedIds.has(node.id);
      const inRing1 = highlight.active && highlight.ring1.has(node.id);
      const inRing2 = highlight.active && highlight.ring2.has(node.id);
      const inHL = highlight.active && highlight.nodes.has(node.id);
      const inPath = highlight.pathIds?.has(node.id);
      const isHit = searchHits.has(node.id);
      const dimmed = highlight.active && !inHL && !inPath;
      const r = baseR * (isHover && !dimmed ? 1.05 : 1);

      let fillAlpha = 0.92;
      if (dimmed) fillAlpha = 0.15;
      else if (highlight.active) {
        if (isFocus || inPath) fillAlpha = 1;
        else if (inRing1) fillAlpha = 0.95;
        else if (inRing2) fillAlpha = 0.55;
      }

      const baseColor = node.color || "#94A3B8";
      ctx.save();
      ctx.globalAlpha = fillAlpha;

      if ((node.isHub || isFocus || isHover || node._userPinned || isHit) && !dimmed) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + (isFocus || isHover ? 6 : 4), 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(baseColor, isFocus ? 0.2 : 0.12);
        ctx.fill();
      }

      if (isHit && !reducedMotion && performance.now() < pulseUntilRef.current) {
        const t = 1 - (pulseUntilRef.current - performance.now()) / 2000;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4 + t * 10, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(baseColor, 0.35 * (1 - t));
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = baseColor;
      ctx.fill();

      if (isFocus && !dimmed) {
        ctx.lineWidth = 2.4 / globalScale;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 2.4, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 / globalScale;
        ctx.strokeStyle = hexToRgba(baseColor, 0.55);
        ctx.stroke();
      } else {
        ctx.lineWidth = 1.25 / globalScale;
        ctx.strokeStyle = dimmed ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.72)";
        ctx.stroke();
      }

      // Freshness dot
      const tone = freshnessTone(node.modifiedAt || noteDetail?.modifiedAt);
      if (!dimmed && (isFocus || node.isHub || isHover)) {
        ctx.beginPath();
        ctx.arc(node.x + r * 0.65, node.y - r * 0.65, 3.2 / globalScale, 0, Math.PI * 2);
        ctx.fillStyle = FRESHNESS_COLORS[tone] || FRESHNESS_COLORS.stale;
        ctx.globalAlpha = fillAlpha;
        ctx.fill();
      }

      // Pin glyph
      if (node._userPinned && !dimmed) {
        ctx.font = `${11 / globalScale}px "Segoe UI Emoji", sans-serif`;
        ctx.globalAlpha = 1;
        ctx.fillText("📌", node.x - 5 / globalScale, node.y - r - 4 / globalScale);
      }

      const topQuartile = node.degreeRank <= 0.25;
      const forceShow =
        isFocus ||
        isHit ||
        isHover ||
        node.isCore ||
        topQuartile ||
        node.isHub ||
        node._userPinned ||
        inPath;
      let tier = "small";
      if (node.isHub || node.isCore || topQuartile) tier = "hub";
      else if (node.degreeRank <= 0.5) tier = "top";
      else if (node.radius >= 12) tier = "mid";

      let alpha = forceShow ? 1 : labelAlphaForZoom(globalScale, tier, labelDensity);
      if (!forceShow && labelDensity < 0.6) alpha = 0;
      if (dimmed) alpha *= 0.12;

      if (alpha > 0.05) {
        const full = node.name || node.id || "";
        const label = truncateLabel(full, 20);
        const fontPx = tier === "hub" ? 13 : tier === "top" || tier === "mid" ? 11 : 10;
        const fontSize = fontPx / globalScale;
        ctx.font = `500 ${fontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
        const gap = 7 / globalScale;
        const metrics = ctx.measureText(label);
        const padX = 5 / globalScale;
        const padY = 3 / globalScale;
        const lx = node.x + r + gap;
        const ly = node.y;
        const box = {
          x: lx - padX,
          y: ly - fontSize * 0.7 - padY,
          w: metrics.width + padX * 2,
          h: fontSize + padY * 2,
        };
        const collided = labelBoxesRef.current.some(
          (b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y
        );
        if (!collided || forceShow) {
          labelBoxesRef.current.push(box);
          ctx.globalAlpha = alpha;
          const textColor = theme === "dark" ? "#e8eef8" : "#1e293b";
          const strokeColor = theme === "dark" ? "rgba(12,16,24,0.55)" : "rgba(248,250,252,0.55)";
          ctx.lineWidth = 2.5 / globalScale;
          ctx.strokeStyle = strokeColor;
          ctx.lineJoin = "round";
          ctx.strokeText(label, lx, ly + fontSize * 0.32);
          ctx.fillStyle = textColor;
          ctx.fillText(label, lx, ly + fontSize * 0.32);
        }
      }
      ctx.restore();
    },
    [
      hoverNode,
      focusNode,
      selectedIds,
      highlight,
      searchHits,
      reducedMotion,
      noteDetail,
      nodeSizeScale,
      labelDensity,
      theme,
    ]
  );

  const paintLink = useCallback(
    (link, ctx, globalScale) => {
      const src = link.source;
      const tgt = link.target;
      if (!src || !tgt || src.x == null || tgt.x == null) return;
      const sid = src.id;
      const tid = tgt.id;
      const edgeKey = sid < tid ? `${sid}::${tid}` : `${tid}::${sid}`;
      const onPath = highlight.pathEdges?.has(edgeKey);
      const connected = !highlight.active || (highlight.nodes.has(sid) && highlight.nodes.has(tid));
      const direct =
        highlight.active &&
        highlight.focusId &&
        ((highlight.focusId === sid && highlight.ring1.has(tid)) ||
          (highlight.focusId === tid && highlight.ring1.has(sid)));

      let alpha = link.crossCluster ? 0.06 : 0.1;
      let width = 0.85;
      if (onPath) {
        alpha = 0.85;
        width = 2.2;
      } else if (highlight.active) {
        if (direct) {
          alpha = 0.7;
          width = 1.8;
        } else if (connected) {
          alpha = 0.22;
          width = 1;
        } else {
          alpha = 0.03;
          width = 0.55;
        }
      }

      const rs = (src.radius || 8) * nodeSizeScale;
      const rt = (tgt.radius || 8) * nodeSizeScale;
      const p0 = edgePoint(src, tgt, rs);
      const p1 = edgePoint(tgt, src, rt);
      const curvature = link.curvature ?? 0.12;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy) || 1;
      const cx = (p0.x + p1.x) / 2 + (-dy / dist) * curvature * dist;
      const cy = (p0.y + p1.y) / 2 + (dx / dist) * curvature * dist;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(cx, cy, p1.x, p1.y);
      if (link.crossCluster && !onPath) ctx.setLineDash([4 / globalScale, 4 / globalScale]);
      ctx.strokeStyle = onPath ? "rgba(124, 92, 252, 0.85)" : `rgba(148, 163, 184, ${alpha})`;
      ctx.lineWidth = Math.max(0.55, width / globalScale);
      ctx.stroke();
      ctx.setLineDash([]);

      // Direction hint on focus edges
      if ((direct || onPath) && alpha > 0.5) {
        const t = 0.72;
        const ax = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * cx + t * t * p1.x;
        const ay = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * cy + t * t * p1.y;
        const bx = 2 * (1 - t) * (cx - p0.x) + 2 * t * (p1.x - cx);
        const by = 2 * (1 - t) * (cy - p0.y) + 2 * t * (p1.y - cy);
        const ang = Math.atan2(by, bx);
        const size = 5 / globalScale;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - size * Math.cos(ang - 0.4), ay - size * Math.sin(ang - 0.4));
        ctx.lineTo(ax - size * Math.cos(ang + 0.4), ay - size * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fillStyle = onPath ? "rgba(124, 92, 252, 0.9)" : "rgba(100, 116, 139, 0.75)";
        ctx.fill();
      }
      ctx.restore();
    },
    [highlight, nodeSizeScale]
  );

  const focusCluster = useCallback(
    (clusterId) => {
      const members = graph.nodes.filter((n) => (n.clusterId || n.category) === clusterId);
      if (!members.length) return;
      applyClusterHighlight(clusterId);
      const fg = graphRef.current;
      if (!fg) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const n of members) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
      }
      fg.centerAt((minX + maxX) / 2, (minY + maxY) / 2, reducedMotion ? 0 : 500);
      const span = Math.max(maxX - minX, maxY - minY, 80);
      const k = Math.min(2.2, Math.max(0.7, (Math.min(dims.w, dims.h) * 0.7) / span));
      fg.zoom(k, reducedMotion ? 0 : 500);
    },
    [graph.nodes, applyClusterHighlight, dims, reducedMotion]
  );

  const runSearch = useCallback(
    (q, { commit = false } = {}) => {
      setSearchQuery(q);
      const query = q.trim().toLowerCase();
      if (!query) {
        setSearchHits(new Set());
        return;
      }
      const hits = new Set();
      let first = null;
      for (const n of graph.nodes) {
        const hay = `${n.name || ""} ${n.path || ""} ${(n.tags || []).join(" ")}`.toLowerCase();
        if (hay.includes(query)) {
          hits.add(n.id);
          if (!first) first = n;
        }
      }
      setSearchHits(hits);
      if (commit && first && graphRef.current) {
        pulseUntilRef.current = performance.now() + 2000;
        graphRef.current.centerAt(first.x, first.y, reducedMotion ? 0 : 500);
        graphRef.current.zoom(Math.max(zoomK, 1.4), reducedMotion ? 0 : 500);
        selectNode(first);
      }
    },
    [graph.nodes, reducedMotion, zoomK, selectNode]
  );

  const relayout = useCallback(() => {
    if (layoutLocked) {
      showToast("布局已锁定");
      return;
    }
    setRelayouting(true);
    setLayoutTick((t) => t + 1);
    fittedRef.current = false;
    for (const node of graph.nodes) {
      if (node._userPinned) {
        node.fx = node.x;
        node.fy = node.y;
      } else {
        node.fx = undefined;
        node.fy = undefined;
      }
    }
  }, [graph.nodes, layoutLocked, showToast]);

  // MiniMap draw
  useEffect(() => {
    const canvas = miniRef.current;
    const fg = graphRef.current;
    if (!canvas || !fg) return undefined;
    let raf = 0;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(248,250,252,0.92)";
      ctx.fillRect(0, 0, w, h);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of graph.nodes) {
        if (n.x == null) continue;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x);
        maxY = Math.max(maxY, n.y);
      }
      if (!Number.isFinite(minX)) return;
      const pad = 12;
      const sx = (w - pad * 2) / Math.max(maxX - minX, 1);
      const sy = (h - pad * 2) / Math.max(maxY - minY, 1);
      const s = Math.min(sx, sy);
      const mapX = (x) => pad + (x - minX) * s;
      const mapY = (y) => pad + (y - minY) * s;
      for (const n of graph.nodes) {
        ctx.beginPath();
        ctx.arc(mapX(n.x), mapY(n.y), 2.2, 0, Math.PI * 2);
        ctx.fillStyle = n.color || "#94A3B8";
        ctx.fill();
      }
      try {
        const center = fg.centerAt();
        const k = fg.zoom();
        const vw = dims.w / k;
        const vh = dims.h / k;
        const vx = center.x - vw / 2;
        const vy = center.y - vh / 2;
        ctx.strokeStyle = "rgba(124, 92, 252, 0.75)";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(mapX(vx), mapY(vy), vw * s, vh * s);
      } catch {
        /* ignore */
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [graph.nodes, dims, zoomK]);

  const stats = graph.stats || { nodeCount: 0, edgeCount: 0, pruned: 0 };
  const relatedNodes = useMemo(() => {
    if (!focusNode) return [];
    return [...(graph.adjacency.get(focusNode.id) || [])]
      .map((id) => nodeById.get(id))
      .filter(Boolean)
      .slice(0, 14);
  }, [focusNode, graph.adjacency, nodeById]);

  const preview = previewMarkdown(noteDetail?.content || "");
  const isFav = focusNode && favorites.includes(focusNode.path || focusNode.id);

  const ctxItems = ctxMenu?.node
    ? [
        { id: "open", label: "打开", onClick: () => openDocument(ctxMenu.node) },
        { id: "edit", label: "编辑", onClick: () => editDocument(ctxMenu.node) },
        { id: "sep1", sep: true },
        {
          id: "fav",
          label: favorites.includes(ctxMenu.node.path || ctxMenu.node.id) ? "取消收藏" : "收藏",
          onClick: () => {
            if (!vaultId) return;
            setFavorites(toggleFavorite(vaultId, ctxMenu.node.path || ctxMenu.node.id));
          },
        },
        {
          id: "pin",
          label: ctxMenu.node._userPinned ? "取消固定" : "固定",
          onClick: () => pinNode(ctxMenu.node, !ctxMenu.node._userPinned),
        },
        { id: "sep2", sep: true },
        {
          id: "copy-path",
          label: "复制路径",
          onClick: async () => {
            await copyText(ctxMenu.node.path);
            showToast("已复制路径");
          },
        },
        {
          id: "reveal",
          label: "定位文件",
          onClick: () => revealInExplorer(ctxMenu.node),
        },
      ]
    : [];

  const showInspector = showDetailPanel && inspectorOpen && (focusNode || pathResult);
  const pinnedCount = pinnedIds.length || graph.nodes.filter((n) => n._userPinned).length;

  return (
    <div
      className={`kv-force-graph${showInspector ? " has-detail" : ""}${shellMode ? " is-shell" : ""} ${className}`.trim()}
      ref={wrapRef}
    >
      {showToolbar ? (
        <div className="kv-force-graph__chrome">
          <div className="kv-force-graph__toolbar kv-force-graph__toolbar--grouped">
            <div className="kv-force-graph__group">
              <span className="kv-force-graph__group-label">视图</span>
              <div className="kv-force-graph__seg" role="tablist">
                {[
                  ["global", "全局"],
                  ["category", "分类"],
                  ["hierarchy", "层级"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={viewMode === id ? "is-active" : ""}
                    onClick={() => setViewMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="kv-force-graph__group">
              <span className="kv-force-graph__group-label">探索</span>
              <input
                className="kv-force-graph__search"
                placeholder="搜索节点"
                value={searchQuery}
                onChange={(e) => runSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch(searchQuery, { commit: true });
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchHits(new Set());
                  }
                }}
              />
              <select
                className="kv-force-graph__mini-select"
                value={pathMode}
                onChange={(e) => setPathMode(e.target.value)}
                title="路径探索（Ctrl+点击两节点）"
              >
                <option value="shortest">最短路径</option>
                <option value="all">全部路径</option>
                <option value="direct">直接关系</option>
              </select>
              <button
                className={`kv-force-graph__tool${showAllEdges ? " is-active" : ""}`}
                type="button"
                onClick={() => {
                  setShowAllEdges((v) => !v);
                  fittedRef.current = false;
                }}
              >
                全部关系
              </button>
            </div>

            <div className="kv-force-graph__group">
              <span className="kv-force-graph__group-label">布局</span>
              <button
                className={`kv-force-graph__tool${relayouting ? " is-loading" : ""}`}
                onClick={relayout}
                disabled={relayouting}
                type="button"
              >
                {relayouting ? "…" : "重布局"}
              </button>
              <button className="kv-force-graph__tool" type="button" onClick={() => fitView(400)}>
                适应
              </button>
              <button
                className={`kv-force-graph__tool${layoutLocked ? " is-active" : ""}`}
                type="button"
                onClick={() => setLayoutLocked((v) => !v)}
              >
                {layoutLocked ? "已锁定" : "锁定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="kv-force-graph__body">
        <div className="kv-force-graph__stage">
          <div className="kv-force-graph__canvas" ref={canvasRef}>
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData}
              width={dims.w}
              height={Math.max(dims.h, compact ? 280 : 400)}
              backgroundColor="transparent"
              nodeRelSize={1}
              nodeVal={(n) => {
                const r = (n.radius || 8) * nodeSizeScale;
                return r * r;
              }}
              nodeVisibility={nodeVisible}
              linkVisibility={(l) => {
                const s = typeof l.source === "object" ? l.source : nodeById.get(l.source);
                const t = typeof l.target === "object" ? l.target : nodeById.get(l.target);
                return Boolean(s && t && nodeVisible(s) && nodeVisible(t));
              }}
              nodeLabel={(n) => n.name || n.id}
              nodeCanvasObject={(node, ctx, globalScale) => paintNode(node, ctx, globalScale)}
              nodeCanvasObjectMode={() => "replace"}
              nodePointerAreaPaint={paintNodePointerArea}
              linkCanvasObject={paintLink}
              linkCanvasObjectMode={() => "replace"}
              onRenderFramePre={(ctx, globalScale) => {
                labelBoxesRef.current = [];
                paintClusters(ctx, globalScale);
              }}
              enableNodeDrag={!boxSelectMode && !layoutLocked && altDragHeld}
              enableZoomInteraction={!boxSelectMode}
              enablePanInteraction={!boxSelectMode}
              minZoom={0.12}
              maxZoom={6}
              d3AlphaDecay={preset.alphaDecay}
              d3VelocityDecay={preset.velocityDecay}
              warmupTicks={reducedMotion ? 20 : preset.warmupTicks}
              cooldownTicks={reducedMotion ? 60 : preset.cooldownTicks}
              onNodeHover={handleNodeHover}
              onNodeClick={handleNodeClick}
              onNodeRightClick={handleNodeRightClick}
              onNodeDrag={handleNodeDrag}
              onNodeDragEnd={handleNodeDragEnd}
              onZoom={(t) => setZoomK(t?.k || 1)}
              onBackgroundClick={clearSelection}
              onEngineStop={handleEngineStop}
            />

            {boxRect ? (
              <div
                className="kv-force-graph__box"
                style={{ left: boxRect.x, top: boxRect.y, width: boxRect.w, height: boxRect.h }}
              />
            ) : null}

            {showLegend ? (
              <div className="kv-force-graph__legend kv-force-graph__legend--badges">
                {(graph.legend || []).map((item) => (
                  <button
                    key={item.category}
                    type="button"
                    className={`kv-force-graph__badge${
                      highlight.clusterId === item.category ? " is-focus" : ""
                    }`}
                    style={{ "--legend-color": item.color }}
                    title={`${item.label || item.category} · ${item.count ?? ""}（点击 Fit）`}
                    onMouseEnter={() => {
                      setHoverCluster(item.category);
                      applyClusterHighlight(item.category);
                    }}
                    onMouseLeave={() => {
                      setHoverCluster(null);
                      if (pathResult?.paths?.length) return;
                      if (focusNode) applyNodeHighlight(focusNode);
                      else setHighlight(EMPTY_HL);
                    }}
                    onClick={() => focusCluster(item.category)}
                  >
                    <span className="kv-force-graph__legend-dot" />
                    <em>{item.count ?? 0}</em>
                  </button>
                ))}
              </div>
            ) : null}

            <canvas
              ref={miniRef}
              className="kv-force-graph__minimap"
              width={148}
              height={108}
              title="MiniMap"
              onClick={(e) => {
                const fg = graphRef.current;
                const canvas = miniRef.current;
                if (!fg || !canvas || !graph.nodes.length) return;
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const n of graph.nodes) {
                  if (!nodeVisible(n)) continue;
                  minX = Math.min(minX, n.x);
                  minY = Math.min(minY, n.y);
                  maxX = Math.max(maxX, n.x);
                  maxY = Math.max(maxY, n.y);
                }
                const pad = 12;
                const sx = (canvas.width - pad * 2) / Math.max(maxX - minX, 1);
                const sy = (canvas.height - pad * 2) / Math.max(maxY - minY, 1);
                const s = Math.min(sx, sy);
                const rect = canvas.getBoundingClientRect();
                const gx = minX + (e.clientX - rect.left - pad) / s;
                const gy = minY + (e.clientY - rect.top - pad) / s;
                fg.centerAt(gx, gy, reducedMotion ? 0 : 350);
              }}
            />

            {hoverNode ? (
              <div className="kv-force-graph__tooltip">
                <strong>{hoverNode.name}</strong>
                {hoverNode.path ? <code>{hoverNode.path}</code> : null}
                <span className="kv-force-graph__tooltip-meta">
                  单击详情 · 双击打开文档 · 右键更多
                </span>
              </div>
            ) : null}

            {ctxMenu ? (
              <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
            ) : null}

            {toast ? <div className="kv-force-graph__toast">{toast}</div> : null}
          </div>

          {showInspector ? (
            <aside className="kv-force-graph__detail">
              {pathResult?.paths?.[0] ? (
                <section className="kv-force-graph__path-box">
                  <h4>路径</h4>
                  <p className="kv-force-graph__path-chain">
                    {pathResult.paths[0].map((id, i) => {
                      const n = nodeById.get(id);
                      return (
                        <React.Fragment key={id}>
                          <button type="button" onClick={() => n && selectNode(n)}>
                            {n?.name || id}
                          </button>
                          {i < pathResult.paths[0].length - 1 ? <span>→</span> : null}
                        </React.Fragment>
                      );
                    })}
                  </p>
                </section>
              ) : null}

              {focusNode ? (
                <>
                  <header className="kv-force-graph__detail-head">
                    <span className="kv-force-graph__detail-dot" style={{ background: focusNode.color }} />
                    <div className="kv-force-graph__detail-identity">
                      <h3 title={focusNode.name}>{focusNode.name}</h3>
                      <p className="kv-force-graph__detail-meta-line">
                        <span>{formatCategoryLabel(focusNode.category)}</span>
                        <span>·</span>
                        <span>连接 {focusNode.degree || 0}</span>
                      </p>
                    </div>
                    <div className="kv-force-graph__detail-tools">
                      <button
                        type="button"
                        className={`kv-force-graph__icon-btn${isFav ? " is-on" : ""}`}
                        title={isFav ? "取消收藏" : "收藏"}
                        onClick={() => {
                          if (!vaultId) return;
                          setFavorites(toggleFavorite(vaultId, focusNode.path || focusNode.id));
                        }}
                      >
                        ★
                      </button>
                      <button
                        type="button"
                        className={`kv-force-graph__icon-btn${focusNode._userPinned ? " is-on" : ""}`}
                        title={focusNode._userPinned ? "取消固定" : "固定"}
                        onClick={() => pinNode(focusNode, !focusNode._userPinned)}
                      >
                        固
                      </button>
                      <button
                        type="button"
                        className="kv-force-graph__icon-btn"
                        title="关闭"
                        onClick={() => setInspectorOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                  </header>

                  {focusNode.path ? (
                    <code className="kv-force-graph__detail-path" title={focusNode.path}>
                      {focusNode.path}
                    </code>
                  ) : null}

                  {(focusNode.tags || noteDetail?.tags || []).length ? (
                    <div className="kv-force-graph__tags">
                      {(focusNode.tags || noteDetail?.tags || []).slice(0, 6).map((t) => (
                        <em key={t}>{t}</em>
                      ))}
                    </div>
                  ) : null}

                  {preview ? (
                    <p className="kv-force-graph__detail-summary">{preview}</p>
                  ) : null}

                  <button
                    type="button"
                    className="kv-force-graph__primary"
                    onClick={() => openDocument(focusNode)}
                  >
                    打开文档
                  </button>

                  <section className="kv-force-graph__detail-block">
                    <h4>关联 {relatedNodes.length ? relatedNodes.length : ""}</h4>
                    <ul className="kv-force-graph__detail-list">
                      {relatedNodes.length ? (
                        relatedNodes.map((n) => (
                          <li key={n.id}>
                            <button type="button" onClick={() => selectNode(n, { locate: true })}>
                              <span
                                className="kv-force-graph__detail-list-dot"
                                style={{ background: n.color }}
                              />
                              {n.name}
                            </button>
                          </li>
                        ))
                      ) : (
                        <li className="is-muted">暂无关联节点</li>
                      )}
                    </ul>
                  </section>
                </>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>

      {showToolbar ? (
        <footer className="kv-force-graph__statusbar">
          <span>节点 {stats.nodeCount}</span>
          <span>关系 {stats.edgeCount}</span>
          <span title="已自动隐藏低权重或弱相关关系">已隐藏 {stats.pruned}</span>
          <span>{Math.round(zoomK * 100)}%</span>
          {pinnedCount ? <span>固定 {pinnedCount}</span> : null}
          {focusNode ? <span className="is-sel">{focusNode.name}</span> : null}
          <span className="is-hint">单击详情 · 双击打开 · Alt+拖动固定</span>
        </footer>
      ) : null}
    </div>
  );
}

export function GraphLegend({ legend }) {
  if (!legend?.length) return null;
  return (
    <div className="kv-graph-explorer__legend">
      {legend.map((item) => (
        <span key={item.category} className="kv-graph-explorer__legend-item">
          <span className="kv-graph-explorer__legend-dot" style={{ background: item.color }} />
          {item.label || formatCategoryLabel(item.category)}
        </span>
      ))}
    </div>
  );
}

export { prepareForceGraphData };
