// 中枢的「通过对话创建 / 在对话里修订」预填文案。
// 它们是普通 user message：只预填草稿、不自动发送，用户接着写要改什么 / 要建什么。
// 「提升为全局」的文案（buildSavedWorkflowPromotePrompt）例外：它作为 createSession.firstInput
// **自动发送**，所以是完整的指令而不是开头。

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/** 「在对话里修订」：只预填、不自动发送——用户接着写要改什么。 */
export function buildSavedWorkflowRevisePrompt(input: {
  name: string;
  path: string;
  locale: string;
  scope?: "project" | "global";
}): string {
  // 全局档修订时追加一句「保持 scope: "global"」，让模型覆盖保存时落回同一档。
  const globalReminderZh =
    input.scope === "global" ? '它是全局工作流，保存时保持 scope: "global"。' : "";
  const globalReminderEn =
    input.scope === "global" ? 'It is a global workflow; keep scope: "global" when saving. ' : "";
  return isZh(input.locale)
    ? `请修订已保存的工作流「${input.name}」（${input.path}）：${globalReminderZh}`
    : `Please revise the saved workflow "${input.name}" (${input.path}): ${globalReminderEn}`;
}

/** 空态 / 顶栏「通过对话创建」：预填一个开头。 */
export function buildSavedWorkflowCreatePrompt(
  locale: string,
  scope?: "project" | "global",
): string {
  if (scope === "global") {
    return isZh(locale)
      ? '帮我设计一个工作流，跑通后用 SaveWorkflow 保存为全局工作流（scope: "global"）：'
      : 'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: ';
  }
  return isZh(locale)
    ? "帮我设计一个工作流，跑通后保存到本项目："
    : "Help me design a workflow and save it to this project once it works: ";
}

/**
 * 「提升为全局」：把项目档概括成全局档的完整指令（自动发送，不是预填开头）。
 *
 * 只给名字与路径，模型自己读文件。清单是用户裁定的：读 → 找仓库特有引用 → 抽成 args 或中性
 * 表述 → 保持因果结构 → SaveWorkflow(scope: "global"，名字可改) → 总结；天然绑定项目时可以说不。
 * 明说「不要改动原文件」：两份并存、用户自删是既定边界（不变式 9）。
 */
export function buildSavedWorkflowPromotePrompt(input: {
  name: string;
  path: string;
  locale: string;
}): string {
  if (isZh(input.locale)) {
    return [
      `请把已保存的项目工作流「${input.name}」（${input.path}）提升为全局工作流。全局工作流对所有项目可见、在任何项目里都能运行，所以它不能依赖本仓库的任何东西。请按下面的步骤做：`,
      "1. 读取这个文件，理解它的因果结构（哪些子代理、什么顺序、什么交接）。",
      "2. 找出所有引用本仓库的地方：具体路径、命令、目录结构、命名约定、分支名等。",
      "3. 把它们抽成 `args` 声明（带说明与合理默认值），或改成不依赖项目的中性表述；保持因果结构不变。",
      '4. 用 SaveWorkflow 以 scope: "global" 保存。名字可以沿用，也可以取一个更贴切的名字。不要改动原来的项目工作流文件。',
      "5. 最后用几句话总结你概括了什么、哪些点被抽成了参数。",
      "如果这个工作流本质上就绑定在这个项目上、无法有意义地概括，请说明原因并停下，不要保存。",
    ].join("\n");
  }
  return [
    `Promote the saved project workflow "${input.name}" (${input.path}) to a global workflow. Global workflows are visible to every project and can run from any of them, so it must not depend on anything in this repository. Follow these steps:`,
    "1. Read the file and understand its causal structure (which subagents, in what order, with what hand-offs).",
    "2. Find everything that refers to this repository: concrete paths, commands, directory layout, naming conventions, branch names, and so on.",
    "3. Lift those into `args` declarations (with descriptions and sensible defaults) or rewrite them in project-neutral terms, keeping the causal structure intact.",
    '4. Save it with SaveWorkflow using scope: "global". Keep the name or pick a better one. Do not modify the original project workflow file.',
    "5. Finish with a short summary of what you generalized and which points became arguments.",
    "If the workflow is inherently bound to this project and cannot be generalized meaningfully, say why and stop without saving.",
  ].join("\n");
}
