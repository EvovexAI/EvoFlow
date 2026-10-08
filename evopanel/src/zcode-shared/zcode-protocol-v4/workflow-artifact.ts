/**
 * workflow run 里**任意脚本值**（顶层返回的产物、`report(item)` 的条目）→ 给模型或读者看的
 * 文本。规则：string 原样；其余 `JSON.stringify(v, null, 2)`；stringify 回 undefined 或抛错
 * 时退 `String(v)`；`undefined` 回 `undefined`（调用方据此让整个字段缺席）。
 *
 * 原住 contracts（dynamic-workflow-run.port.ts），因为它当时的三个跨包消费者——完成通知的
 * `<result>` / `<reports>`（core）、runtime task 条目上的 `resultText`（core，TaskOutput 的
 * 唯一来源）、`workflowRuns.reports[].preview`（v4 投影，详情页 Results 区的那一行）——给出
 * 的文本必须逐字节相同。第四个消费者出现后搬到这里：`reports[].preview` 的归约随共享
 * reducer 下沉进本包（workflow-runs-reducer.ts），而依赖方向是 contracts → shared，本包
 * import 不了 contracts。contracts 原位保留 re-export，core 侧的消费者一行不改。
 *
 * 同理这里不设长度上限：通知端有 120k 截断、TaskOutput 端有 artifact 预算、投影端有
 * `maxReportPreviewLength`，界属于各自的边界。
 *
 * 产物形状不受约束——record、数组、字符串、数字、null 都合法，所以这里没有 `isRecord` 门
 * （原实现按 legacy `Workflow` 的 `output.response` 取值，正是那个桌面实测 bug 的成因）。
 */
export function serializeWorkflowArtifact(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    // JSON.stringify 对 undefined / function / symbol 回 undefined，对循环引用抛错——
    // 两种情况都退到 String(value)，绝不把值整段丢掉。
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
