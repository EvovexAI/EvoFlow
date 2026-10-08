/**
 * 工作流一族工具的**按名字**识别，三处原本各自一份同款匹配器的合并：
 * - 可复用工作流：`SaveWorkflow` / `ListSavedWorkflows`；
 * - 升级问答：`escalate` / `ResolveWorkflowQuestion`；
 * - 观察与恢复：`GetWorkflowRun` / `ListWorkflowRuns` / `EvalWorkflowSnippet` 与 `ResumeWorkflowRun`；
 * - 模型目录：`ListModels`。
 *
 * 为什么不走 `resolveToolCallIdentity`：这些工具名都不在 `packages/shared` 的
 * `ZCODE_KNOWN_TOOL_NAMES` 里，identity 对它们只会回 `unknown`，分流会掉进 raw JSON 兜底卡。
 *
 * 而且这些判定必须排在 family 分流**之前**：`workflow` family 的兜底分支是 CreateWorkflow
 * 卡（`resolveRenderer.ts`）与运行确认块（`PermissionDialog.tsx`），一旦有人把这些名字登记
 * 进 workflow family，保存与列举就会静默渲染成「创建工作流」——保存确认窗甚至会长出
 * 因果图与 Refine 选项。按名字先判定让登记前后两种世界都成立。
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  // 照 cron-create.tsx 的同款归一：抹掉大小写与分隔符，`SaveWorkflow` / `save_workflow`
  // 两种 wire 写法都命中。
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface WorkflowToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: WorkflowToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

export function isSaveWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "saveworkflow");
}

export function isListSavedWorkflowsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listsavedworkflows");
}

export function isEscalateToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "escalate");
}

export function isResolveWorkflowQuestionToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resolveworkflowquestion");
}

export function isGetWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "getworkflowrun");
}

export function isListWorkflowRunsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listworkflowruns");
}

export function isEvalWorkflowSnippetToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "evalworkflowsnippet");
}

export function isResumeWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resumeworkflowrun");
}

/**
 * 模型目录。同款按名判定：
 * `ListModels` 也不在已知工具表里，兜底卡会把那段以 providerId 开头的模型面文本原样摊开。
 */
export function isListModelsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listmodels");
}

/**
 * 创建入口。渲染分流仍走 `workflow` family（它的兜底就是创建卡）；这个按名判定只给不经过分流的读者用：
 * 编译反馈的稿号联接要在行窗口里认出
 * 每一次创建，而 family 会把修订也算进来。
 */
export function isCreateWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "createworkflow");
}

/**
 * 修订入口。它**已登记**进 workflow
 * family（确认窗按 family 选运行确认块），但工具行仍按名先判：同一个 create-workflow 渲染器换
 * 一套修订词汇，而不是让 family 兜底把它画成一张普通的「创建工作流」卡。
 */
export function isAmendWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "amendworkflow");
}
