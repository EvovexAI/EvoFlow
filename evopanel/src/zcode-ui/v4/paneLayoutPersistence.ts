// 分屏 Layout 层持久化（localStorage）：try/catch 静默降级；
// 损坏数据整体丢弃回初始布局（不部分救回）。
// 兼容读取旧版 v1（单值 splitPane），仅当 v1 workspaceKey 是可信本地路径时迁移。
import {
  clampSplitRatio,
  leafPaneIds,
  MAX_WORKBENCH_PANES,
  PRIMARY_LEAF,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneLayoutNode,
  type PaneLayoutSnapshot,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const PANE_LAYOUT_STORAGE_KEY = "zcode-v4-pane-layout:v2";
/** 旧版单值分屏的 key（只读迁移，不再写入）。 */
const PANE_LAYOUT_STORAGE_KEY_V1 = "zcode-v4-pane-layout:v1";

/** v1 迁移用的保留 pane id（旧版 split pane 固定 id，e2e/testid 契约沿用）。 */
const V4_LEGACY_SPLIT_PANE_ID = "split";

interface PersistedScopeV2 {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface PersistedBindingV2 {
  workspaceScope: PersistedScopeV2;
  sessionId: string | null;
}

type PersistedNodeV2 =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PersistedNodeV2;
      second: PersistedNodeV2;
    };

interface PersistedPaneLayoutV2 {
  root: PersistedNodeV2;
  panes: Record<string, PersistedBindingV2>;
  focusedPaneId: string;
}

function sanitizeNode(raw: unknown): PaneLayoutNode | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedNodeV2> & Record<string, unknown>;
  if (record.type === "leaf") {
    return typeof record.paneId === "string" && record.paneId.length > 0
      ? { type: "leaf", paneId: record.paneId }
      : null;
  }
  if (record.type === "split") {
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      (record.direction !== "row" && record.direction !== "column")
    ) {
      return null;
    }
    const first = sanitizeNode(record.first);
    const second = sanitizeNode(record.second);
    if (!first || !second) {
      return null;
    }
    return {
      type: "split",
      id: record.id,
      direction: record.direction,
      ratio: clampSplitRatio(typeof record.ratio === "number" ? record.ratio : Number.NaN),
      first,
      second,
    };
  }
  return null;
}

function sanitizeScope(raw: unknown): PaneWorkspaceScope | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedScopeV2>;
  if (typeof record.workspacePath !== "string" || record.workspacePath.length === 0) {
    return null;
  }
  return {
    workspacePath: record.workspacePath,
    ...(typeof record.workspaceIdentity === "string" && record.workspaceIdentity.trim().length > 0
      ? { workspaceIdentity: record.workspaceIdentity }
      : {}),
    ...(typeof record.remoteSessionId === "string" && record.remoteSessionId.length > 0
      ? { remoteSessionId: record.remoteSessionId }
      : {}),
  };
}

/**
 * 把任意（可能损坏的）v2 持久化值归一为合法布局快照；不可救回 null（调用方回初始布局）。
 * 完整性要求（任一不满足即整体丢弃）：树结构合法、叶子 id 唯一、恰含一个 primary、
 * 叶子数 ≤ 上限、每个非 primary 叶子有合法绑定。恢复出的 session 绑定补
 * restoredUnvalidated（等 sessions-index 验证）；focusedPaneId 不在树中回 primary。
 */
function sanitizePersistedPaneLayout(raw: unknown): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedPaneLayoutV2>;
  const root = sanitizeNode(record.root);
  if (!root) {
    return null;
  }
  const paneIds = leafPaneIds(root);
  if (
    paneIds.length > MAX_WORKBENCH_PANES ||
    new Set(paneIds).size !== paneIds.length ||
    paneIds.filter((paneId) => paneId === V4_PRIMARY_PANE_ID).length !== 1
  ) {
    return null;
  }
  const rawPanes =
    typeof record.panes === "object" && record.panes !== null
      ? (record.panes as Record<string, unknown>)
      : {};
  const panes: Record<string, PaneBinding> = {};
  for (const paneId of paneIds) {
    if (paneId === V4_PRIMARY_PANE_ID) {
      continue;
    }
    const rawBinding = rawPanes[paneId];
    if (typeof rawBinding !== "object" || rawBinding === null) {
      return null;
    }
    const scope = sanitizeScope((rawBinding as Partial<PersistedBindingV2>).workspaceScope);
    if (!scope) {
      return null;
    }
    const rawSessionId = (rawBinding as Partial<PersistedBindingV2>).sessionId;
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
    panes[paneId] = {
      workspaceScope: scope,
      sessionId,
      ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
    };
  }
  const focusedPaneId =
    typeof record.focusedPaneId === "string" && paneIds.includes(record.focusedPaneId)
      ? record.focusedPaneId
      : V4_PRIMARY_PANE_ID;
  return { root, panes, focusedPaneId };
}

/** v1 workspaceKey 只在是可信本地绝对路径时才能当 workspacePath 迁移（POSIX / Windows 盘符）。 */
function isPlausibleLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * 旧版 v1（单值 splitPane）→ v2 迁移：v1 只存了 workspaceKey（identity ?? path），
 * 无法还原远程 scope——仅当它是可信本地路径时迁移为双叶子树，否则丢弃回单 pane（null）。
 */
function migratePersistedPaneLayoutV1(raw: unknown): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as {
    splitPane?: { workspaceKey?: unknown; sessionId?: unknown } | null;
    focusedPaneId?: unknown;
    splitRatio?: unknown;
  };
  const workspaceKey = record.splitPane?.workspaceKey;
  if (
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    !isPlausibleLocalPath(workspaceKey)
  ) {
    return null;
  }
  const rawSessionId = record.splitPane?.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
  return {
    root: {
      type: "split",
      id: "n1",
      direction: "row",
      ratio: clampSplitRatio(
        typeof record.splitRatio === "number" ? record.splitRatio : Number.NaN,
      ),
      first: PRIMARY_LEAF,
      second: { type: "leaf", paneId: V4_LEGACY_SPLIT_PANE_ID },
    },
    panes: {
      [V4_LEGACY_SPLIT_PANE_ID]: {
        workspaceScope: { workspacePath: workspaceKey },
        sessionId,
        ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
      },
    },
    focusedPaneId:
      record.focusedPaneId === V4_LEGACY_SPLIT_PANE_ID
        ? V4_LEGACY_SPLIT_PANE_ID
        : V4_PRIMARY_PANE_ID,
  };
}

/** 读取持久化布局（v2 优先，缺失时尝试 v1 迁移）；无记录/损坏/无 storage 环境返回 null。 */
export function readPersistedPaneLayout(): PaneLayoutSnapshot | null {
  try {
    const rawV2 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    if (rawV2) {
      return sanitizePersistedPaneLayout(JSON.parse(rawV2));
    }
    const rawV1 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY_V1);
    if (rawV1) {
      return migratePersistedPaneLayoutV1(JSON.parse(rawV1));
    }
    return null;
  } catch {
    return null;
  }
}

function serializeNode(node: PaneLayoutNode): PersistedNodeV2 {
  if (node.type === "leaf") {
    return { type: "leaf", paneId: node.paneId };
  }
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: serializeNode(node.first),
    second: serializeNode(node.second),
  };
}

// 去重写入：subscribe 对任何状态变化都触发，序列化相同（例如 restoredUnvalidated
// 清除，不进持久化面）时跳过 setItem。
let lastPersistedPaneLayout: string | null = null;

export function persistPaneLayout(snapshot: PaneLayoutSnapshot): void {
  const panes: Record<string, PersistedBindingV2> = {};
  for (const [paneId, binding] of Object.entries(snapshot.panes)) {
    panes[paneId] = {
      workspaceScope: {
        workspacePath: binding.workspaceScope.workspacePath,
        ...(binding.workspaceScope.workspaceIdentity
          ? { workspaceIdentity: binding.workspaceScope.workspaceIdentity }
          : {}),
        ...(binding.workspaceScope.remoteSessionId
          ? { remoteSessionId: binding.workspaceScope.remoteSessionId }
          : {}),
      },
      sessionId: binding.sessionId,
    };
  }
  const payload: PersistedPaneLayoutV2 = {
    root: serializeNode(snapshot.root),
    panes,
    focusedPaneId: snapshot.focusedPaneId,
  };
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === lastPersistedPaneLayout) {
      return;
    }
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, serialized);
    lastPersistedPaneLayout = serialized;
  } catch {
    // 无 storage 环境（测试/隐身）静默降级：刷新恢复不可用，但不影响正常分屏。
  }
}
