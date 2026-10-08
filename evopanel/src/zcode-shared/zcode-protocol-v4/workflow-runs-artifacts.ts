// ============================================================
// workflowRuns 归约里的用户面产物部分
// ============================================================
// 从 workflow-runs-reducer.ts 拆出（max-lines 门），与 workflow-runs-concurrency.ts 同一先例：
// 主归约只剩 switch 的分派，产物的三条规则住在这里。同一条纪律：纯函数、无时钟、无 I/O。
//
// ⚠ 术语：本模块的 artifact 是脚本经
// `artifact.*` 发布给**用户**看的产出。主归约里 `resultPreview` 调用的
// `serializeWorkflowArtifact`（workflow-artifact.ts，单数）里那个 artifact 是**另一个意思**
// ——引擎内部对「脚本顶层返回值」的叫法，给模型看的。两者无关。
//
// 三条规则各有各的键，这是本模块最要紧的一句话：
//   artifact-published ⇒ 按**产物 id** upsert。同 id 再发布是新版本，必须覆盖同一张卡；
//                        而同一个 id 的两个版本来自两个不同的**站点实例**，所以这里不能
//                        用 nodes/actors/reports 那把 (siteId, ordinal) 钥匙。
//   artifact-failed    ⇒ 不动状态（在主归约里，只有一行 return）。失败行不认领 id / 种类 /
//                        版本，没有可 upsert 的东西。
//   report(artifactId) ⇒ 该 id 的 itemCount 加一。去重键回到 (siteId, ordinal)——它是一条
//                        report，身份仍是 report 的身份。

import {
  WORKFLOW_ARTIFACT_LIMITS,
  type WorkflowRunArtifactKind,
  type WorkflowRunArtifactSummary,
} from "./workflow-artifacts.js";

/** 产物的六个成员种类。归约不校验 schema，所以这里自带一张闭集表判读。 */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<WorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/**
 * `artifact-published` 载荷里的 `ArtifactVersionRecord` → 快照里的**最新版元数据**。
 *
 * 裁剪掉 `versions` / `spec` / `description` / `uri` / `sourcePath` / `publishedAt`：快照是
 * 高频状态键，它的读者只需要「有哪些产物、现在第几版、变了没有」。全量元数据走
 * `workflowRunArtifacts` 查询，字节走 `workflowRunArtifactRead`——权威始终在 journal。
 *
 * `id` / `kind` / `version` 缺任一即无从展示（返回 undefined，只抬水位）：一张认不出种类的卡
 * 既选不出图标也分派不了渲染器。其余字段有则带、无则整键缺席。
 */
export function workflowArtifactSummary(value: unknown): WorkflowRunArtifactSummary | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const kind = nonEmptyString(value.kind);
  const version = value.version;
  if (id === undefined || kind === undefined || !ARTIFACT_KINDS.has(kind)) return undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const title = nonEmptyString(value.title);
  const contentType = nonEmptyString(value.contentType);
  const bytes = value.bytes;
  return {
    id: id.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: kind as WorkflowRunArtifactKind,
    ...(title === undefined
      ? {}
      : { title: title.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxTitleLength) }),
    version: Math.min(version, WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    ...(contentType === undefined ? {} : { contentType: contentType.slice(0, 128) }),
    ...(typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? { bytes } : {}),
    ...(value.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * 按**产物 id** upsert 进有界的产物表，并**保留已有条目的 `itemCount`**。
 *
 * 保留计数是这个函数与 `upsertBoundedByInstance` 唯一的实质差别，也是它存在的理由：新版本
 * 的记录里没有 `itemCount`（那是标签 report 数出来的，不是发布时刻的事实），整条替换会把
 * 一块正在被喂数据的看板的计数清零——刷新信号归零，看板从此不再增量取数。
 *
 * 触界语义与其他三张表同族：拒绝新条目、已有条目照常更新。
 */
export function upsertBoundedByArtifactId(
  list: readonly WorkflowRunArtifactSummary[],
  entry: WorkflowRunArtifactSummary,
  limit: number,
): { list: WorkflowRunArtifactSummary[]; truncated: boolean } {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    const previous = list[index]!;
    const next = [...list];
    next[index] = {
      ...entry,
      ...(previous.itemCount === undefined ? {} : { itemCount: previous.itemCount }),
    };
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/**
 * 一条打了标签的 `report` 落在某个产物上：把该 id 的 `itemCount` 加一。
 *
 * 表里没有这个 id 时**忽略计数**（返回原表，条目仍照常进 `reports`）。运行期这是不可能的
 * ——`report(item, tag)` 的 tag 必须先被声明为预置产物，否则引擎 failRun——所以这里纯粹是
 * 防御：事件乱序或载荷残缺时，宁可少一个计数，也不要凭空造出一张没有 spec、渲染不了的卡。
 *
 * **计数的失准方向是有意的。** 去重键 (siteId, ordinal) 来自 `reports` 表，而那张表在 64 条
 * 之后拒收新条目——超界之后一条被重放的标签 report 认不出自己是重放，会多数一次。选择这个
 * 方向是因为 `itemCount` 的职责只是**刷新信号**：多数一次让看板多发一次带 `afterSequence`
 * 的增量查询、拿回零行，无害；少数一次（例如改成"超界就不再计数"）会让折线在第 64 个点上
 * 永远冻住，而那正是这个特性存在的理由。触界时 `truncated` 已置位，读者据此知道 `reports`
 * 与 `itemCount` 都已是近似值；条目的**权威**计数在 journal，经 `workflowRunArtifactData` 翻页得到。
 */
export function countTaggedReport(
  list: readonly WorkflowRunArtifactSummary[] | undefined,
  artifactId: string,
): WorkflowRunArtifactSummary[] | undefined {
  if (list === undefined) return undefined;
  const index = list.findIndex((item) => item.id === artifactId);
  // 返回 undefined = **这个键不用动**：调用方整个不写 artifacts，于是幂等重放得到
  // 逐字节相同的 run 对象，顶层的 JSON 比对随即返回 null。
  if (index < 0) return undefined;
  const previous = list[index]!;
  const next = [...list];
  next[index] = { ...previous, itemCount: (previous.itemCount ?? 0) + 1 };
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
