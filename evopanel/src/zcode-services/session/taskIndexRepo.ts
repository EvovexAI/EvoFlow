import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- task 索引仓库集中维护 sqlite schema、查询和状态写入，迁移稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";
import type {
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // 列表按当前 runtime provider 过滤；历史导入来源不改变此边界。
  where.push("provider = ?");
  args.push(provider);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface TaskIndexRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

interface TaskGroupRow {
  group_id: string;
  title: string;
  color: string;
  created_at: number;
  updated_at: number;
}

interface TaskGroupMemberRow {
  group_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  sort_order: number | null;
  added_at: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupViewNodeOrderRow {
  node_type: "group" | "task";
  node_key: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupWorkspaceBootstrapRow {
  workspace_key: string;
  group_id: string | null;
}

interface WorkspaceBootstrapScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  // 只有 unread 专属写路径可以修改现有行，其他 metadata/snapshot 写必须保留当前 CAS marker。
  writeUnreadAt?: boolean;
  // searchableText 可空：传入 undefined 表示保留 existing 行的现有值。
  // 这样 applyAgentPatch / updateTaskState 这类不带 messages 上下文的写入不会把已索引的正文清空。
  searchableText?: string;
}

interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
  updatedAt?: number;
}

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
const GROUPED_TASK_ORDER_STEP = 1000;
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY = "__zcode_internal_grouped_workspace_bootstrap_once__";
const DEFAULT_TASK_GROUP_COLOR: ZCodeTaskGroupColor = "gray";
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ZCodeTaskGroupColor[];

const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function shouldPreserveNewerTerminalStatus(
  existingMeta: ZCodeTaskMeta | null,
  incomingMeta: ZCodeTaskMeta,
): boolean {
  if (!existingMeta || !isTerminalTaskStatus(existingMeta.status)) {
    return false;
  }
  if (incomingMeta.status && incomingMeta.status !== "running") {
    return false;
  }
  return existingMeta.updatedAt > incomingMeta.updatedAt;
}

function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key 是 SQLite 查询与主键隔离的真实依据；只要它是统一格式的远端 identity，
  // 返回值就必须与它一致，不能让残留的 workspace_identity 列把实体投影到另一个远端。
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // identity 投影与主键不一致时不能采用，也不能把远端实体退回 workspacePath，
  // 否则相同路径的不同远端会在侧栏 activity join 时串行。
  return undefined;
}

function rowToMeta(row: TaskIndexRow): ZCodeTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite 使用这些字段查询并隔离实体，旧 meta_json 里的 identity
        // 可能缺失或属于旧远端。读取时必须与行主键投影一致，sessions-index 才能
        // 按 workspaceKey + taskId 附加 running activity。
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread 是 tasks-index 产品壳状态；标量列必须覆盖可能来自其他 Host 的旧 meta_json。
        unreadAt: row.unread_at ?? undefined,
        // cron 身份以 meta_json 为准；cron_automation_id 列是索引投影，仅作兜底：
        // 历史行 meta_json 里可能还没有该字段，回退读列，下次写入会自动回填进 meta_json。
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // off-peak 身份同款策略：meta_json 为准、列兜底——存量迁移只写列即可生效。
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    logger.warn(
      undefined,
      `读取 task index meta_json 非法 taskId=${row.task_id}`,
      parsed.error.flatten(),
    );
  } catch (error) {
    logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    traceId: `zcode-${row.task_id}`,
    title: row.title,
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    provider: row.provider === ZCODE_AGENT_PROVIDER ? ZCODE_AGENT_PROVIDER : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
    status: (row.task_status as ZCodeTaskMeta["status"]) ?? undefined,
  };
}

/** 序列化 meta 到 meta_json。cron 身份随 meta 一起写入（单一来源），另在 writeRecord 投影到 cron_automation_id 索引列。 */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspaceBootstrapScopes(
  scopes: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  }>,
): WorkspaceBootstrapScope[] {
  const seen = new Set<string>();
  const result: WorkspaceBootstrapScope[] = [];
  for (const scope of scopes) {
    if (scope.workspacePurpose === "conversation") {
      // 对话 backing workspace 只是 cwd，不是项目；迁移期不能为它生成同名项目分组。
      continue;
    }
    const key = workspaceKey(scope);
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      workspaceKey: key,
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
    });
  }
  return result;
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// 全局会话搜索 (TaskSearchDialog) 期望命中正文时返回若干片段做摘要展示。
// 以匹配点为中心截窗，去重相近窗口，最多 4 条；
// 全部未命中（title 命中）时回退一条整段摘要，避免下方空白。
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // 同一个关键词在很近的位置多次出现时，摘要窗口会高度重叠；服务端先合并近重复摘要。
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // title 命中但正文没命中时，仍给一条整段摘要兜底，避免标题下方空白。
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(row: TaskIndexRow, search: string | null): ZCodeTaskListItem {
  const meta = rowToMeta(row);
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

function isTaskGroupColor(value: string): value is ZCodeTaskGroupColor {
  return (
    value === "gray" ||
    value === "red" ||
    value === "orange" ||
    value === "yellow" ||
    value === "green" ||
    value === "blue" ||
    value === "purple"
  );
}

function rowToTaskGroup(row: TaskGroupRow): ZCodeTaskGroup {
  return {
    id: row.group_id,
    title: row.title,
    color: isTaskGroupColor(row.color) ? row.color : DEFAULT_TASK_GROUP_COLOR,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceGroupId(targetWorkspaceKey: string): string {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest("hex");
  return `workspace-group-${hash.slice(0, 24)}`;
}

function workspaceGroupTitle(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const leaf = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return leaf?.trim() || normalized.trim() || "Workspace";
}

function workspaceGroupColor(targetWorkspaceKey: string): ZCodeTaskGroupColor {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest();
  const colorIndex = hash.readUInt8(0) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.length;
  return WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[colorIndex] ?? DEFAULT_TASK_GROUP_COLOR;
}

function taskNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  return `${workspaceKey(params)}\u0000${params.taskId}`;
}

function taskOrderNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  // task_group_view_node_orders.node_key 不能使用 "\u0000" 分隔；
  // node:sqlite 读 TEXT 时会截断 NUL 后面的 taskId，导致 grouped 视图排序写入后查询匹配不上。
  return JSON.stringify([workspaceKey(params), params.taskId]);
}

function groupedTopNodeOrderRef(node: ZCodeGroupedTaskViewNode): {
  nodeType: "group" | "task";
  nodeKey: string;
  mapKey: string;
} {
  if (node.type === "group") {
    return {
      nodeType: "group",
      nodeKey: node.group.id,
      mapKey: `group:${node.group.id}`,
    };
  }
  const nodeKey = taskOrderNodeKey(node.task);
  return {
    nodeType: "task",
    nodeKey,
    mapKey: `task:${nodeKey}`,
  };
}

function compareGroupedNodes(
  left: ZCodeGroupedTaskViewNode,
  right: ZCodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return groupedTopNodeOrderRef(left).mapKey.localeCompare(groupedTopNodeOrderRef(right).mapKey);
}

function compareCronGroupTasks(left: ZCodeTaskListItem, right: ZCodeTaskListItem): number {
  // cron 系统分组固定按创建时间倒序：最新的定时任务结果始终展示在最前面，
  // 不参与用户手动排序（sort_order），新 session 到达时天然排到组顶部。
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return taskNodeKey(right).localeCompare(taskNodeKey(left));
}

function compareGroupTasks(
  left: ZCodeTaskListItem,
  right: ZCodeTaskListItem,
  memberByTaskKey: Map<string, TaskGroupMemberRow>,
): number {
  const leftMember = memberByTaskKey.get(taskNodeKey(left));
  const rightMember = memberByTaskKey.get(taskNodeKey(right));
  const leftOrder = leftMember?.sort_order ?? 0;
  const rightOrder = rightMember?.sort_order ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return taskNodeKey(left).localeCompare(taskNodeKey(right));
}

export class TaskIndexRepo {
  constructor(
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // Worker 已完成该路径的原始准备，业务连接不再重复全表修复。
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
    this.backfillOffPeakTaskMarkers();
    this.backfillOffPeakGroupMemberships();
    this.cleanupDeletedTaskGroupingReferences();
  }

  /**
   * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
   * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
   * join 只补投影列——rowToMeta 以列兜底即可生效，下次 syncTaskMeta 会自动回填 meta_json。
   * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    const hasOffPeakTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  /**
   * 成员关系回填（幂等，每次 bootstrap 自愈）：历史回填只补了 off_peak_task_id
   * 投影列，syncTaskMeta 的"首次获得标记"钩子对这些存量永远不会再触发（existing 已带
   * 标记），必须在 bootstrap 里补一次系统分组归属。OR IGNORE 保证用户手动整理不被覆盖，
   * 也保证重复执行零副作用；无标记行时不创建空组（从未用过闲时的用户不会看到组）。
   */
  private backfillOffPeakGroupMemberships(): void {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `SELECT workspace_key, workspace_path, workspace_identity, task_id FROM tasks
         WHERE off_peak_task_id IS NOT NULL AND deleted = 0`,
      )
      .all() as Array<{
      workspace_key: string;
      workspace_path: string;
      workspace_identity: string | null;
      task_id: string;
    }>;
    for (const row of rows) {
      // 闲时任务暂不支持远程 workspace：远程存量行不归组。历史行的 workspace_identity
      // 列可能缺失，remote 判定必须看主键 workspace_key——否则 ensureSystemGroupMembership
      // 会用 workspacePath 重算出本地 key，把成员关系串写到同路径本地 workspace 上。
      if (isRemoteWorkspaceIdentity(row.workspace_key)) {
        continue;
      }
      this.ensureOffPeakGroupMembership({
        workspacePath: row.workspace_path,
        workspaceIdentity: row.workspace_identity ?? undefined,
        taskId: row.task_id,
      });
    }
  }

  private deleteTaskGroupingReferencesReady(workspaceKeyValue: string, taskId: string): void {
    const database = this.getDatabase();
    database
      .prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(workspaceKeyValue, taskId);
    database
      .prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      )
      .run(JSON.stringify([workspaceKeyValue, taskId]), workspaceKeyValue);
  }

  private cleanupDeletedTaskGroupingReferences(): void {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `SELECT workspace_key, task_id
        FROM tasks
        WHERE deleted = 1`,
      )
      .all() as Array<{ workspace_key: string; task_id: string }>;
    if (rows.length === 0) {
      return;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      // 旧版本删除 task 时只写 tasks.deleted，membership/顶层顺序仍会被
      // sessions-index 历史摘要重新投影；初始化时幂等收敛已经落盘的脏引用。
      for (const row of rows) {
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  private getNextGroupedTopSortOrder(): number {
    const row = this.getDatabase()
      .prepare(
        `SELECT MIN(sort_order) AS min_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { min_sort_order: number | null } | undefined;
    return (row?.min_sort_order ?? GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP;
  }

  private upsertGroupedTopOrder(params: {
    nodeType: "group" | "task";
    nodeKey: string;
    sortOrder: number;
    now: number;
  }): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_type, node_key) DO UPDATE SET
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      )
      .run(params.nodeType, params.nodeKey, params.sortOrder, params.now, params.now);
  }

  private normalizeGroupedTopNodeOrders(
    nodes: ZCodeGroupedTaskViewNode[],
    orderByNodeKey: Map<string, TaskGroupViewNodeOrderRow>,
  ): void {
    const missingNodes = nodes
      .filter((node) => !orderByNodeKey.has(groupedTopNodeOrderRef(node).mapKey))
      .sort((left, right) => {
        const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
        const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
        if (rightCreated !== leftCreated) {
          return rightCreated - leftCreated;
        }
        return groupedTopNodeOrderRef(left).mapKey.localeCompare(
          groupedTopNodeOrderRef(right).mapKey,
        );
      });
    if (missingNodes.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const insertOrder = this.getDatabase().prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const node of missingNodes) {
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        const ref = groupedTopNodeOrderRef(node);
        insertOrder.run(ref.nodeType, ref.nodeKey, nextSortOrder, now, now);
        const rowValue: TaskGroupViewNodeOrderRow = {
          node_type: ref.nodeType,
          node_key: ref.nodeKey,
          sort_order: nextSortOrder,
          created_at: now,
          updated_at: now,
        };
        orderByNodeKey.set(ref.mapKey, rowValue);
        node.sortOrder = nextSortOrder;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  private normalizeGroupMemberOrders(
    groupId: string,
    tasks: ZCodeTaskListItem[],
    memberByTaskKey: Map<string, TaskGroupMemberRow>,
  ): void {
    const missingTasks = tasks
      .filter((task) => {
        const member = memberByTaskKey.get(taskNodeKey(task));
        return Boolean(member) && member?.sort_order === null;
      })
      .sort((left, right) => {
        const leftMember = memberByTaskKey.get(taskNodeKey(left));
        const rightMember = memberByTaskKey.get(taskNodeKey(right));
        const leftAdded = leftMember?.added_at ?? left.createdAt;
        const rightAdded = rightMember?.added_at ?? right.createdAt;
        if (rightAdded !== leftAdded) {
          return rightAdded - leftAdded;
        }
        return taskNodeKey(left).localeCompare(taskNodeKey(right));
      });
    if (missingTasks.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_members
        WHERE group_id = ?`,
      )
      .get(groupId) as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const updateMemberOrder = this.getDatabase().prepare(
      `UPDATE task_group_members
      SET sort_order = ?, updated_at = ?
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const task of missingTasks) {
        const memberKey = taskNodeKey(task);
        const member = memberByTaskKey.get(memberKey);
        if (!member) {
          continue;
        }
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        updateMemberOrder.run(nextSortOrder, now, member.workspace_key, member.task_id);
        member.sort_order = nextSortOrder;
        member.updated_at = now;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return this.hasGroupedWorkspaceBootstrapRunSync();
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    const where = [
      "workspace_key = ?",
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      "unread_at IS NULL",
      "updated_at < ?",
      "task_status = 'completed'",
    ];
    const args: Array<string | number> = [workspaceKey(params), cutoff];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    if (rows.length === 0) {
      return [];
    }

    const archiveTask = this.getDatabase().prepare(
      `UPDATE tasks
      SET archived = 1
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        archiveTask.run(row.workspace_key, row.task_id);
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
    return rows.map(rowToMeta);
  }

  private hasGroupedWorkspaceBootstrapRunSync(): boolean {
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS found
        FROM task_group_workspace_bootstraps
        LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

  private bootstrapWorkspaceGroupsForActiveTasks(params: {
    scopes: WorkspaceBootstrapScope[];
    activeTasks: TaskIndexRow[];
  }): void {
    if (params.scopes.length === 0 || this.hasGroupedWorkspaceBootstrapRunSync()) {
      return;
    }
    const database = this.getDatabase();
    const candidateRowsByWorkspaceKey = new Map<string, TaskIndexRow[]>();
    for (const row of params.activeTasks) {
      const rows = candidateRowsByWorkspaceKey.get(row.workspace_key) ?? [];
      rows.push(row);
      candidateRowsByWorkspaceKey.set(row.workspace_key, rows);
    }
    const now = Date.now();
    const markBootstrapRun = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        updated_at = excluded.updated_at`,
    );
    if (candidateRowsByWorkspaceKey.size === 0) {
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      return;
    }
    const existingGroupOrderKeys = new Set(
      (
        database
          .prepare(
            `SELECT node_key
            FROM task_group_view_node_orders
            WHERE node_type = 'group'`,
          )
          .all() as Array<{ node_key: string }>
      ).map((row) => row.node_key),
    );
    const maxOrderRow = database
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextGroupSortOrder = maxOrderRow?.max_sort_order ?? 0;
    const insertGroup = database.prepare(
      `INSERT OR IGNORE INTO task_groups (
        group_id,
        title,
        color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertGroupOrder = database.prepare(
      `INSERT OR IGNORE INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES ('group', ?, ?, ?, ?)`,
    );
    const deleteExistingMember = database.prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const insertMember = database.prepare(
      `INSERT INTO task_group_members (
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        group_id = excluded.group_id,
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
    );
    const deleteTopTaskOrder = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND node_key = ?`,
    );
    const insertBootstrap = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        group_id = excluded.group_id,
        updated_at = excluded.updated_at`,
    );
    const deleteEmptyGroups = database.prepare(
      `DELETE FROM task_groups
      WHERE group_id NOT IN (
        SELECT DISTINCT group_id
        FROM task_group_members
      )`,
    );
    const deleteDanglingGroupOrders = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'group'
        AND node_key NOT IN (
          SELECT group_id
          FROM task_groups
        )`,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      // grouped workspace bootstrap 是迁移期的一次性初始化。记录全局 marker，
      // 避免后续新 workspace 出现时再次自动生成 workspace group。
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      for (const scope of params.scopes) {
        const rows = candidateRowsByWorkspaceKey.get(scope.workspaceKey);
        if (!rows) {
          continue;
        }
        // 初始化按没有分组功能时的 workspace 视角重建 membership，
        // 旧 group 不参与归属判断，避免历史分组把 task 留在非 workspace group 里。
        const groupedRows = rows.sort((left, right) => {
          if (right.updated_at !== left.updated_at) {
            return right.updated_at - left.updated_at;
          }
          if (right.created_at !== left.created_at) {
            return right.created_at - left.created_at;
          }
          return left.task_id.localeCompare(right.task_id);
        });
        if (groupedRows.length === 0) {
          continue;
        }
        const groupId = workspaceGroupId(scope.workspaceKey);
        const title = workspaceGroupTitle(scope.workspacePath);
        insertGroup.run(groupId, title, workspaceGroupColor(scope.workspaceKey), now, now);
        if (!existingGroupOrderKeys.has(groupId)) {
          nextGroupSortOrder += GROUPED_TASK_ORDER_STEP;
          insertGroupOrder.run(groupId, nextGroupSortOrder, now, now);
          existingGroupOrderKeys.add(groupId);
        }
        groupedRows.forEach((row, index) => {
          deleteExistingMember.run(row.workspace_key, row.task_id);
          insertMember.run(
            groupId,
            row.workspace_key,
            row.workspace_path,
            row.workspace_identity,
            row.task_id,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
          deleteTopTaskOrder.run(
            taskOrderNodeKey({
              workspacePath: row.workspace_path,
              workspaceIdentity: row.workspace_identity ?? undefined,
              taskId: row.task_id,
            }),
          );
        });
        insertBootstrap.run(scope.workspaceKey, groupId, now, now);
      }
      deleteEmptyGroups.run();
      deleteDanglingGroupOrders.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    // searchable_text 传 undefined 表示"不动现有值"。读一次 row 拿到当前值，
    // 否则 ON CONFLICT 时 excluded.searchable_text 会被赋成空字符串，把已索引正文清空。
    const existing =
      record.searchableText === undefined
        ? this.getTaskRow({
            workspacePath: record.meta.workspacePath,
            workspaceIdentity: record.meta.workspaceIdentity,
            taskId: record.meta.taskId,
          })
        : null;
    const searchableText =
      record.searchableText !== undefined
        ? record.searchableText.slice(0, TASK_SEARCH_TEXT_MAX_CHARS)
        : (existing?.searchable_text ?? "");
    this.getDatabase()
      .prepare(
        `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = CASE
            WHEN @write_unread_at = 1 THEN excluded.unread_at
            ELSE tasks.unread_at
          END,
          last_unread_at = MAX(
            tasks.last_unread_at,
            COALESCE(tasks.unread_at, 0),
            CASE WHEN @write_unread_at = 1 THEN excluded.last_unread_at ELSE 0 END
          ),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
      )
      .run({
        workspace_key: workspaceKey(record.meta),
        workspace_path: record.meta.workspacePath,
        workspace_identity: record.meta.workspaceIdentity ?? null,
        task_id: record.meta.taskId,
        title: record.meta.title,
        task_status: record.meta.status ?? null,
        provider: record.meta.provider ?? null,
        mode: record.meta.mode,
        model: record.meta.model ?? null,
        migration_source: record.meta.migrationSource ?? null,
        forked_from_task_id: record.meta.forkedFromTaskId ?? null,
        // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
        cron_automation_id: record.meta.cronAutomationId ?? null,
        // off-peak 身份同款投影。
        off_peak_task_id: record.meta.offPeakTaskId ?? null,
        created_at: record.meta.createdAt,
        updated_at: record.meta.updatedAt,
        unread_at: record.meta.unreadAt ?? null,
        last_unread_at: record.meta.unreadAt ?? 0,
        write_unread_at: record.writeUnreadAt ? 1 : 0,
        pinned: record.pinned ? 1 : 0,
        archived: record.archived ? 1 : 0,
        deleted: record.deleted ? 1 : 0,
        title_overridden: record.titleOverridden ? 1 : 0,
        searchable_text: searchableText,
        meta_json: serializeMetaJson(record.meta),
      });
    const persisted = this.getTaskRow(record.meta);
    if (!persisted) {
      throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
    }
    return rowToMeta(persisted);
  }

  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    // 调用方可以从 snapshot.messages 计算正文，传进来同步刷新 searchable_text。
    // 不传则保留 sqlite 已有的 searchable_text（在 writeRecord 里兜底）。
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    const result = await this.syncTaskMetaWithGroupedAdmission(params, false);
    return result.meta;
  }

  /** 首次公开 root task 时，原子提交 task row 与 grouped 顶层顺序。 */
  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    return this.syncTaskMetaWithGroupedAdmission(params, true);
  }

  private async syncTaskMetaWithGroupedAdmission(
    params: {
      meta: ZCodeTaskMeta;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
      titleOverridden?: boolean;
      searchableText?: string;
    },
    initializeGroupedAtTop: boolean,
  ): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const database = this.getDatabase();
      if (initializeGroupedAtTop) database.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        const existingMeta = existing ? rowToMeta(existing) : null;
        const titleOverridden = params.titleOverridden ?? existing?.title_overridden === 1;
        // snapshot 来源的 updatedAt 是 runtime sessionStore 里的"最后一次结构变更"时间，
        // 不一定包含 session.titleUpdated / turn.completed 这些事件触发的 Date.now() 增量。
        // 如果这里直接用 params.meta.updatedAt 覆盖，会把刚刚走 applyAgentPatch 写入的更新时间戳冲回旧值，
        // 表现为新会话第一次 prompt 后又被压回列表底部。这里取与 sqlite 已有值的 max，保证单调不回退。
        const updatedAt = Math.max(params.meta.updatedAt, existingMeta?.updatedAt ?? 0);
        const preserveExistingTerminalStatus = shouldPreserveNewerTerminalStatus(
          existingMeta,
          params.meta,
        );
        const meta: ZCodeTaskMeta = {
          ...params.meta,
          // agent 只负责 session 核心标题，用户手动重命名属于 app 侧 task 状态。
          // 同步 agent snapshot 时保留已覆盖标题，避免后台状态刷新把用户标题冲掉。
          title: titleOverridden && existingMeta ? existingMeta.title : params.meta.title,
          titleOverridden,
          // turn.completed 会先通过 applyAgentPatch 写入较新的 completed/error。
          // 随后到达的 protocol snapshot 可能仍带较旧 running；如果这里降级 status，
          // 手机 replayable 切回 task 时就会把已完成任务恢复成“工作中”。
          status: preserveExistingTerminalStatus ? existingMeta?.status : params.meta.status,
          lastError: preserveExistingTerminalStatus
            ? existingMeta?.lastError
            : params.meta.lastError,
          target: Object.prototype.hasOwnProperty.call(params.meta, "target")
            ? params.meta.target
            : existingMeta?.target,
          // Claude Code 导入升级成真实 ZCode session 后，protocol snapshot
          // 本身不知道迁移来源。同步运行态快照时保留已有 migrationSource，避免
          // 列表过滤和后续切模型把导入任务重新当成普通 ZCode 任务。
          migrationSource: params.meta.migrationSource ?? existingMeta?.migrationSource,
          // 同步运行态快照时保留已有 cron automation 身份：运行态 protocol snapshot 的 meta 不带 cron 标记，
          // 不用已存值兜底会在后续 sync 时把 cron 身份冲掉，导致 icon / 分组 / 关联查询失效。
          cronAutomationId: params.meta.cronAutomationId ?? existingMeta?.cronAutomationId,
          // off-peak 身份同款兜底：快照不带标记时保全既有归属。
          offPeakTaskId: params.meta.offPeakTaskId ?? existingMeta?.offPeakTaskId,
          updatedAt,
          unreadAt: params.meta.unreadAt ?? existingMeta?.unreadAt,
        };
        const persistedMeta = this.writeRecord({
          meta,
          pinned: params.pinned ?? existing?.pinned === 1,
          archived: params.archived ?? existing?.archived === 1,
          deleted: params.deleted ?? existing?.deleted === 1,
          titleOverridden,
          searchableText: params.searchableText,
        });
        // cron session 首次获得 cronAutomationId 时归入固定 cron 分组。
        // 会话内 CronCreate 是给已有 task 补 cron 标记，不能只判断 !existing，否则左侧列表不会归入定时任务分组。
        // INSERT OR IGNORE 不覆盖已有成员关系——用户后续把它拖出 cron 组后不会被自动拖回。
        if (meta.cronAutomationId && !existingMeta?.cronAutomationId) {
          this.ensureCronGroupMembership(meta);
        }
        // 闲时会话首次获得 offPeakTaskId 时归入固定闲时系统分组（机制同 cron）。
        if (meta.offPeakTaskId && !existingMeta?.offPeakTaskId) {
          this.ensureOffPeakGroupMembership(meta);
        }
        // root draft 首发过去先提交 task row，再另一次写 sort_order；
        // sessions-index 在两次写之间公开 task 时，Renderer 会把缺序节点补到末尾。
        const initializedGroupedOrder = initializeGroupedAtTop
          ? this.initializeGroupedTaskAtTopReady(meta)
          : false;
        if (initializeGroupedAtTop) database.exec("COMMIT");
        return { meta: persistedMeta, initializedGroupedOrder };
      } catch (error) {
        if (initializeGroupedAtTop) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * 把一条 cron session 归入固定的 cron 系统分组（见 CRON_DEFAULT_GROUP_ID）。
   * 幂等：分组行、视图排序、成员关系都用 INSERT OR IGNORE，绝不覆盖用户手动整理的结果。
   * 仅在 session 首次获得 cronAutomationId 时由 syncTaskMeta 调用一次。
   */
  private ensureCronGroupMembership(meta: ZCodeTaskMeta): void {
    this.ensureSystemGroupMembership(meta, {
      groupId: CRON_DEFAULT_GROUP_ID,
      title: "cron",
      color: "blue",
    });
  }

  /**
   * 把一条闲时会话归入固定的闲时系统分组（见 OFF_PEAK_DEFAULT_GROUP_ID）。
   * 机制与 cron 完全同构；仅在首次获得 offPeakTaskId 时由 syncTaskMeta 调用，
   * 或由 bootstrap 为存量回填补齐。
   */
  private ensureOffPeakGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): void {
    // 闲时任务暂不支持远程 workspace：远程会话即使带标记也不归入闲时系统分组。
    if (meta.workspaceIdentity && isRemoteWorkspaceIdentity(meta.workspaceIdentity)) {
      return;
    }
    this.ensureSystemGroupMembership(meta, {
      groupId: OFF_PEAK_DEFAULT_GROUP_ID,
      title: "off-peak",
      color: "purple",
    });
  }

  private ensureSystemGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
    params: { groupId: string; title: string; color: string },
  ): void {
    const database = this.getDatabase();
    const now = Date.now();
    database
      .prepare(
        `INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(params.groupId, params.title, params.color, now, now);
    // 分组视图排序：不存在才插入（OR IGNORE），避免每次新建系统分组 session 都把该组顺序打乱。
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
        VALUES ('group', ?, ?, ?, ?)`,
      )
      .run(params.groupId, this.getNextGroupedTopSortOrder(), now, now);
    // OR IGNORE：若该 task 已有成员关系（用户已手动分组），保持不动。
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        params.groupId,
        workspaceKey(meta),
        meta.workspacePath,
        meta.workspaceIdentity ?? null,
        meta.taskId,
        now,
        now,
        now,
      );
  }

  /**
   * 只在索引行不存在时写入基线元数据；已存在（含已删除）的产品壳状态原样保留。
   *
   * 远端 workspace 的 V4 会话路径可能晚于会话创建才建立 sessions-index
   * 订阅。首次 snapshot 必须能补齐全新的 tasks-index.sqlite，但不能用摘要默认值
   * 覆盖已有的 pin/archive/unread/手动标题，也不能与随后到达的完整 snapshot 竞态回写。
   */
  async seedTaskMetaIfMissing(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(meta, () => {
      const existing = this.getTaskRow(meta);
      if (existing) {
        return rowToMeta(existing);
      }
      return this.writeRecord({
        meta,
        pinned: false,
        archived: false,
        deleted: false,
        titleOverridden: meta.titleOverridden ?? false,
      });
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        if (current.unreadAt !== params.expectedUnreadAt) {
          database.exec("COMMIT");
          return { meta: current, cleared: false };
        }

        const nextMeta: ZCodeTaskMeta = {
          ...current,
          unreadAt: undefined,
        };
        // 手机已读请求可能晚于新的终态未读到达。比较和写入必须持有同一
        // SQLite 写事务，否则旧点击会把随后产生的 unreadAt 无条件清掉。
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          deleted: false,
          titleOverridden: row.title_overridden === 1,
          writeUnreadAt: true,
        });
        database.exec("COMMIT");
        return { meta: persistedMeta, cleared: true };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      const deleting = params.patch.deleted === true;
      const requestedUnreadAt = params.patch.unreadAt;
      const allocatingUnreadAt = typeof requestedUnreadAt === "number";
      const mutatingUnreadAt = "unreadAt" in params.patch;
      const transactional = deleting || mutatingUnreadAt;
      if (transactional) {
        database.exec("BEGIN IMMEDIATE");
      }
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        // 毫秒时间戳可能让同一 task 的两个逻辑未读得到相同版本，
        // 且清除 unreadAt 后只看当前值会再次复用旧版本。必须在 SQLite 写锁内
        // 基于不会随清除重置的持久 watermark 分配严格递增 marker。
        const lastUnreadAt = Math.max(
          row.last_unread_at,
          row.unread_at ?? 0,
          current.unreadAt ?? 0,
        );
        const unreadAt = allocatingUnreadAt
          ? Math.max(requestedUnreadAt, lastUnreadAt + 1)
          : "unreadAt" in params.patch
            ? undefined
            : current.unreadAt;
        const nextMeta: ZCodeTaskMeta = {
          ...current,
          title: params.patch.title ?? current.title,
          titleOverridden: params.patch.titleOverridden ?? current.titleOverridden,
          model: params.patch.model ?? current.model,
          updatedAt: params.patch.updatedAt ?? current.updatedAt,
          unreadAt,
          status: params.patch.status ?? current.status,
          lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
          target: "target" in params.patch ? params.patch.target : current.target,
        };
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: params.patch.pinned ?? row.pinned === 1,
          archived: params.patch.archived ?? row.archived === 1,
          deleted: params.patch.deleted ?? row.deleted === 1,
          titleOverridden: params.patch.titleOverridden ?? row.title_overridden === 1,
          writeUnreadAt: mutatingUnreadAt,
        });
        if (deleting) {
          // 删除标记和 grouped 引用必须原子提交；否则任一写入失败都会让
          // sessions-index 内容、task 可见性和 SQLite 分组归属长期处于互相矛盾的状态。
          this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        }
        if (transactional) database.exec("COMMIT");
        return persistedMeta;
      } catch (error) {
        if (transactional) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target" | "updatedAt">;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const row = this.getTaskRow(params);
      if (!row || row.deleted === 1) {
        return null;
      }
      const current = rowToMeta(row);
      const canAcceptAgentTitle = row.title_overridden !== 1;
      const nextMeta: ZCodeTaskMeta = {
        ...current,
        title: canAcceptAgentTitle && params.patch.title ? params.patch.title : current.title,
        titleOverridden: row.title_overridden === 1,
        updatedAt: params.patch.updatedAt ?? current.updatedAt,
        status: params.patch.status ?? current.status,
        lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
        target: "target" in params.patch ? params.patch.target : current.target,
      };
      return this.writeRecord({
        meta: nextMeta,
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        deleted: row.deleted === 1,
        titleOverridden: row.title_overridden === 1,
      });
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND (@include_deleted = 1 OR deleted = 0)
          -- 按请求指定的 runtime provider 过滤；迁移来源另存于 migration_source。
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /**
   * 列出某条 automation 产生的所有 cron session（用于 automation 详情展开、关联查询）。
   * 走 cron_automation_id 索引列，只返回未删除的 session，按创建时间倒序。
   */
  async listSessionsByAutomation(automationId: string): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE cron_automation_id = @automation_id
          AND deleted = 0
        ORDER BY created_at DESC, task_id DESC`,
      )
      .all({ automation_id: automationId }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = ["deleted = 0", `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
      where.push("(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)");
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? "created_at DESC, updated_at DESC, task_id DESC"
        : "updated_at DESC, created_at DESC, task_id DESC";
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  async createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const now = Date.now();
    const id = `task-group-${randomUUID()}`;
    const title = params?.title?.trim() || "New Group";
    const color = params?.color ?? DEFAULT_TASK_GROUP_COLOR;
    this.getDatabase()
      .prepare(
        `INSERT INTO task_groups (
          group_id,
          title,
          color,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, color, now, now);
    // 新建内容必须立即进入用户排序，并插到当前混排列表顶部；
    // 不能依赖 created_at 和已有 sort_order 混排，否则两套坐标量级不同会导致刷新后位置漂移。
    this.upsertGroupedTopOrder({
      nodeType: "group",
      nodeKey: id,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return {
      id,
      title,
      color,
      createdAt: now,
      updatedAt: now,
    };
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const title = params.title.trim() || "New Group";
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET title = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(title, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法重命名");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Task group 重命名后读取失败");
    }
    return rowToTaskGroup(row);
  }

  async updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    if (!isTaskGroupColor(params.color)) {
      throw new Error("Task group 颜色无效");
    }
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET color = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(params.color, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法更新颜色");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Task group 更新颜色后读取失败");
    }
    return rowToTaskGroup(row);
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database
        .prepare("DELETE FROM task_groups WHERE group_id = ?")
        .run(params.groupId);
      if (result.changes === 0) {
        throw new Error("Task group 不存在，无法删除");
      }
      database
        .prepare(
          `DELETE FROM task_group_view_node_orders
          WHERE node_type = 'group' AND node_key = ?`,
        )
        .run(params.groupId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async initializeGroupedTaskAtTop(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return this.initializeGroupedTaskAtTopReady(params);
  }

  private initializeGroupedTaskAtTopReady(params: ZCodeGroupedTaskRef): boolean {
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
      return false;
    }
    const database = this.getDatabase();
    const existingMember = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?
        LIMIT 1`,
      )
      .get(workspaceKey(params), params.taskId) as { found: number } | undefined;
    const nodeKey = taskOrderNodeKey(params);
    const existingTopOrder = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?
        LIMIT 1`,
      )
      .get(nodeKey) as { found: number } | undefined;
    if (existingMember || existingTopOrder) {
      return false;
    }
    const now = Date.now();
    // session 可见与首标题缺行都可能并发触发完整 snapshot 回源。
    // 顶层顺序只能在第一次出现时初始化；重复回源若再次分配最小 sort_order，
    // 较慢完成的旧任务会越过之后创建的新任务，使最终顺序依赖异步完成时序。
    this.upsertGroupedTopOrder({
      nodeType: "task",
      nodeKey,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return true;
  }

  // 过渡面：grouped 列表消费已切 sessions-index + queryGroupedTaskViewStructure，
  // 本方法仅剩 applyGroupedTaskViewOrder 的回包复用（UI 已不采信该回包），
  // 随 applyGroupedTaskViewOrder 返回面收敛一并收口。
  async queryGroupedTaskView(
    params: ZCodeGroupedTaskViewQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const includeAllWorkspaces = params.includeAllWorkspaces === true;
    const requestedWorkspaceScopes = normalizeWorkspaceBootstrapScopes(params.workspaceScopes);
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    const activeTaskWhere = [
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      ...(includeAllWorkspaces
        ? []
        : [`workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`]),
    ];
    const activeTaskArgs: Array<string | number> = includeAllWorkspaces ? [] : [...workspaceKeys];
    if (params.provider) {
      // grouped 和 workspace 都是 ZCode Agent 任务列表入口，必须共享旧 provider
      // 残留过滤口径；否则历史 claude/codex/gemini 索引行会只在 grouped 里冒出来。
      appendZCodeAgentIndexedProviderFilter(activeTaskWhere, activeTaskArgs, params.provider);
    }
    const activeTasks =
      !includeAllWorkspaces && workspaceKeys.length === 0
        ? []
        : (this.getDatabase()
            .prepare(
              `SELECT
                workspace_key,
                workspace_path,
                workspace_identity,
                task_id,
                title,
                task_status,
                provider,
                mode,
                model,
                migration_source,
                forked_from_task_id,
                cron_automation_id,
                created_at,
                updated_at,
                unread_at,
                pinned,
                archived,
                deleted,
                title_overridden,
                searchable_text,
                meta_json
              FROM tasks
              WHERE ${activeTaskWhere.join(" AND ")}`,
            )
            .all(...activeTaskArgs) as unknown as TaskIndexRow[]);
    const workspaceScopes = includeAllWorkspaces
      ? normalizeWorkspaceBootstrapScopes(
          activeTasks.map((row) => ({
            workspacePath: row.workspace_path,
            workspaceIdentity: row.workspace_identity ?? undefined,
          })),
        )
      : requestedWorkspaceScopes;
    this.bootstrapWorkspaceGroupsForActiveTasks({
      scopes: workspaceScopes,
      activeTasks,
    });
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const visibleWorkspaceKeys = new Set(
      includeAllWorkspaces ? activeTasks.map((task) => task.workspace_key) : workspaceKeys,
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const members = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const orderByNodeKey = new Map(
      orderRows.map((row) => [`${row.node_type}:${row.node_key}`, row]),
    );
    const memberByTaskKey = new Map(
      members.map((member) => [`${member.workspace_key}\u0000${member.task_id}`, member]),
    );
    const membersByGroupId = new Map<string, TaskGroupMemberRow[]>();
    for (const member of members) {
      const groupMembers = membersByGroupId.get(member.group_id) ?? [];
      groupMembers.push(member);
      membersByGroupId.set(member.group_id, groupMembers);
    }

    const activeTaskByKey = new Map(
      activeTasks.map((row) => [
        `${row.workspace_key}\u0000${row.task_id}`,
        rowToTaskListItem(row, null),
      ]),
    );
    const groupedVisibleTaskKeys = new Set<string>();
    const nodes: ZCodeGroupedTaskViewNode[] = groups.map((group) => {
      const groupTasks = (membersByGroupId.get(group.id) ?? [])
        .map((member) => activeTaskByKey.get(`${member.workspace_key}\u0000${member.task_id}`))
        .filter((task): task is ZCodeTaskListItem => Boolean(task));
      if (group.id === CRON_DEFAULT_GROUP_ID) {
        // cron 系统分组不走用户手动排序，固定按创建时间倒序展示最新结果。
        groupTasks.sort(compareCronGroupTasks);
      } else {
        this.normalizeGroupMemberOrders(group.id, groupTasks, memberByTaskKey);
        groupTasks.sort((left, right) => compareGroupTasks(left, right, memberByTaskKey));
      }
      for (const task of groupTasks) {
        groupedVisibleTaskKeys.add(taskNodeKey(task));
      }
      const order = orderByNodeKey.get(`group:${group.id}`);
      return {
        type: "group",
        group,
        tasks: groupTasks,
        ...(order ? { sortOrder: order.sort_order } : {}),
      };
    });

    for (const task of activeTaskByKey.values()) {
      const key = taskNodeKey(task);
      if (memberByTaskKey.has(key) || groupedVisibleTaskKeys.has(key)) {
        continue;
      }
      const order = orderByNodeKey.get(`task:${taskOrderNodeKey(task)}`);
      nodes.push({
        type: "task",
        task,
        ...(order ? { sortOrder: order.sort_order } : {}),
      });
    }

    // 首次查询时把当前可见顶层节点全部补齐成用户排序，之后展示只认 sort_order。
    this.normalizeGroupedTopNodeOrders(nodes, orderByNodeKey);
    nodes.sort(compareGroupedNodes);
    return { nodes };
  }

  /**
   * grouped 原始结构读取（不 join tasks 表、无 bootstrap / normalize 写回）。
   * 任务内容改由 sessions-index 提供，客户端 join；这里只回 group / member / 顶层排序三张表。
   * 组可见性沿用 queryGroupedTaskView 口径：bootstrap workspace group 只在其 workspace 可见。
   */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }): Promise<ZCodeGroupedTaskViewStructure> {
    await this.ensureReady();
    const visibleWorkspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const memberRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const members: ZCodeGroupedTaskViewStructureMember[] = memberRows.map((row) => ({
      groupId: row.group_id,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
      taskId: row.task_id,
      sortOrder: row.sort_order,
      addedAt: row.added_at,
    }));
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[] = [];
    for (const row of orderRows) {
      if (row.node_type === "group") {
        topLevelOrders.push({
          type: "group",
          groupId: row.node_key,
          sortOrder: row.sort_order,
        });
        continue;
      }
      // task node_key = JSON.stringify([workspaceKey, taskId])（NUL 分隔在 sqlite TEXT 会被截断）。
      try {
        const parsed = JSON.parse(row.node_key) as unknown;
        if (
          Array.isArray(parsed) &&
          typeof parsed[0] === "string" &&
          typeof parsed[1] === "string"
        ) {
          topLevelOrders.push({
            type: "task",
            workspaceKey: parsed[0],
            taskId: parsed[1],
            sortOrder: row.sort_order,
          });
        }
      } catch {
        // 历史脏 node_key 跳过：客户端会按 createdAt 补内存序，不致崩溃。
      }
    }
    return { groups, members, topLevelOrders };
  }

  async applyGroupedTaskViewOrder(
    params: ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const workspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const now = Date.now();
    const database = this.getDatabase();

    const groupIds = new Set(
      (
        database.prepare("SELECT group_id FROM task_groups").all() as Array<{
          group_id: string;
        }>
      ).map((row) => row.group_id),
    );
    const validateTaskRef = (task: ZCodeGroupedTaskRef): string | null => {
      const key = workspaceKey(task);
      if (!workspaceKeys.has(key)) {
        throw new Error("Grouped task order 包含当前 scope 外的 task");
      }
      const row = this.getTaskRow(task);
      if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
        throw new Error("Grouped task order 包含不可见 task");
      }
      if (params.provider && row.provider !== params.provider) {
        // grouped 保存回包之前没有 provider 边界，旧 gemini/codex/claude 排序残留会在保存后重新展示。
        // 带 provider 的 ZCode Agent 视图只接受当前 glm task；旧 provider 引用作为不可见遗留数据跳过。
        return null;
      }
      return key;
    };

    const topLevelTaskKeys = new Set<string>();
    const groupedTaskKeys = new Set<string>();
    const visibleTopLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[] = [];
    const visibleGroups: Array<{ groupId: string; taskRefs: ZCodeGroupedTaskRef[] }> = [];
    for (const node of params.topLevelNodes) {
      if (node.type === "group") {
        if (!groupIds.has(node.groupId)) {
          throw new Error("Grouped task order 包含不存在的 group");
        }
        visibleTopLevelNodes.push(node);
        continue;
      }
      const workspaceKey = validateTaskRef(node.task);
      if (!workspaceKey) {
        continue;
      }
      const key = `${workspaceKey}\u0000${node.task.taskId}`;
      topLevelTaskKeys.add(key);
      visibleTopLevelNodes.push(node);
    }
    for (const group of params.groups) {
      if (!groupIds.has(group.groupId)) {
        throw new Error("Grouped task order 包含不存在的 group");
      }
      const visibleTaskRefs: ZCodeGroupedTaskRef[] = [];
      for (const taskRef of group.taskRefs) {
        const workspaceKey = validateTaskRef(taskRef);
        if (!workspaceKey) {
          continue;
        }
        const key = `${workspaceKey}\u0000${taskRef.taskId}`;
        if (groupedTaskKeys.has(key)) {
          throw new Error("Grouped task order 不能让同一个 task 进入多个 group");
        }
        groupedTaskKeys.add(key);
        visibleTaskRefs.push(taskRef);
      }
      visibleGroups.push({ groupId: group.groupId, taskRefs: visibleTaskRefs });
    }

    const scopedTaskOrderKeys =
      workspaceKeys.size === 0
        ? []
        : (
            database
              .prepare(
                `SELECT workspace_key, task_id
              FROM tasks
              WHERE workspace_key IN (${[...workspaceKeys].map(() => "?").join(", ")})`,
              )
              .all(...workspaceKeys) as Array<{
              workspace_key: string;
              task_id: string;
            }>
          ).map((row) => `${row.workspace_key}\u0000${row.task_id}`);

    database.exec("BEGIN IMMEDIATE");
    try {
      const markWorkspaceBootstrapDisabled = database.prepare(
        `INSERT INTO task_group_workspace_bootstraps (
          workspace_key,
          group_id,
          created_at,
          updated_at
        ) VALUES (?, NULL, ?, ?)
        ON CONFLICT(workspace_key) DO UPDATE SET
          updated_at = excluded.updated_at`,
      );
      // 用户已经显式保存 grouped 排序时，后续查询不能再执行 workspace 自动初始化。
      // 这里写全局 marker，避免新 workspace 出现后又触发迁移式 workspace group 初始化。
      markWorkspaceBootstrapDisabled.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      const deleteMembership = database.prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      );
      const upsertMembership = database.prepare(
        `INSERT INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          group_id = excluded.group_id,
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      );
      for (const key of topLevelTaskKeys) {
        const [targetWorkspaceKey, taskId] = key.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          throw new Error("Grouped task order 顶层 task key 非法");
        }
        deleteMembership.run(targetWorkspaceKey, taskId);
      }
      for (const group of visibleGroups) {
        group.taskRefs.forEach((taskRef, index) => {
          const targetWorkspaceKey = workspaceKey(taskRef);
          upsertMembership.run(
            group.groupId,
            targetWorkspaceKey,
            taskRef.workspacePath,
            taskRef.workspaceIdentity ?? null,
            taskRef.taskId,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
        });
      }

      // 一次提交最终排序，避免菜单/草稿/取消分组等 grouped 视图变更留下部分写入状态。
      database.prepare("DELETE FROM task_group_view_node_orders WHERE node_type = 'group'").run();
      const deleteTaskOrder = database.prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      );
      // 只清理当前 workspace scope 里的 task 排序；否则远端/未展开 workspace 的混排位置会被本次变更误删。
      for (const nodeKey of scopedTaskOrderKeys) {
        const [targetWorkspaceKey, taskId] = nodeKey.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          continue;
        }
        deleteTaskOrder.run(JSON.stringify([targetWorkspaceKey, taskId]), targetWorkspaceKey);
      }
      const insertOrder = database.prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      visibleTopLevelNodes.forEach((node, index) => {
        const nodeType = node.type;
        const nodeKey = node.type === "group" ? node.groupId : taskOrderNodeKey(node.task);
        insertOrder.run(nodeType, nodeKey, (index + 1) * GROUPED_TASK_ORDER_STEP, now, now);
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return this.queryGroupedTaskView({
      workspaceScopes: params.workspaceScopes,
      provider: params.provider,
    });
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
