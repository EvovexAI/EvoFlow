import {
  ArtifactBoard,
  ArtifactChart,
  ArtifactMetrics,
  ArtifactTable,
  parseArtifactPresetSpec,
  type ArtifactItem,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/index.js";
import { isArtifactPresetKind } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * 预置看板的正文。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是引擎内部那个「脚本顶层返回值」
 * 的同名词。
 *
 * 曾与侧板的产物卡同住一个文件；卡换成产物药丸之后，
 * 这里只剩侧板小预览与全尺寸 tab 共用的这一个分派。
 */
/**
 * 按 kind 把 spec + 条目交给四个渲染器之一。侧板小卡（`compact`）与全尺寸 tab 共用它——
 * 两处若各写一份 switch，迟早出现「小卡画了图、大图什么也没画」这种只在一处发生的偏斜。
 */
export function ArtifactPresetBody({
  artifact,
  items,
  labels,
  compact,
  invalidLabel,
  missingLabel,
  className,
}: {
  artifact: Pick<WorkflowRunArtifactView, "kind" | "spec">;
  items: readonly ArtifactItem[];
  labels: PresetLabels;
  compact?: boolean;
  /** spec 在场但**解析不出来**时的降级文案；缺席即整块不渲染。 */
  invalidLabel?: string;
  /** spec **整个不在场**时的文案；缺席即整块不渲染（见下面那段关于加载中的注释）。 */
  missingLabel?: string;
  className?: string;
}) {
  if (!isArtifactPresetKind(artifact.kind)) return null;
  // 「spec 不在场」与「spec 坏了」必须分开说。
  //
  // spec 只有 journal 查询带得回来（活投影刻意不带它），所以**每次打开面板的头几帧**
  // spec 都还是 undefined。两者合并成一句「无法渲染」的结果，是每个看板在加载期间都先
  // 闪一次错误文案。所以：不在场 ⇒ 交给调用方决定（侧板小卡传 undefined，保持安静；
  // 全尺寸 tab 只在元数据**已经读完**之后才传 missingLabel）。
  if (artifact.spec === undefined) {
    return missingLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-missing"
      >
        {missingLabel}
      </p>
    );
  }
  const spec = parseArtifactPresetSpec(artifact.kind, artifact.spec);
  if (spec === undefined) {
    return invalidLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-invalid"
      >
        {invalidLabel}
      </p>
    );
  }
  // 四个 `as` 都由**同一个 kind** 担保：`parseArtifactPresetSpec(kind, …)` 是按 kind 校验的，
  // 它认下来的形状就是该 kind 的 spec。4b 的这个函数没有按 kind 的重载（只有
  // `applyArtifactItems` 有），所以这层收窄只能在调用方做。
  const shared = { compact, items, labels, className };
  switch (artifact.kind) {
    case "chart":
      return <ArtifactChart spec={spec as ChartSpec} {...shared} />;
    case "table":
      return <ArtifactTable spec={spec as TableSpec} {...shared} />;
    case "metrics":
      return <ArtifactMetrics spec={spec as MetricsSpec} {...shared} />;
    default:
      return <ArtifactBoard spec={spec as BoardSpec} {...shared} />;
  }
}
