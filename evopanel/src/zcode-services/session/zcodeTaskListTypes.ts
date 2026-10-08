import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type ZCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ZCodeTaskGroup {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ZCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ZCodeGroupedTaskRef };

export type ZCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: ZCodeTaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: ZCodeTaskListItem;
      sortOrder?: number;
    };

export interface ZCodeGroupedTaskView {
  nodes: ZCodeGroupedTaskViewNode[];
}

export interface ZCodeGroupedTaskViewQuery {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface ZCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type ZCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface ZCodeGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: ZCodeTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: ZCodeGroupedTaskViewStructureMember[];
  topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[];
}

export interface ZCodeGroupedTaskViewOrderInput {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  topLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ZCodeGroupedTaskRef[];
  }>;
}

export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
