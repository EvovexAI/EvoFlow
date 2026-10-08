/**
 * 预置产物渲染器的公开面。
 *
 * 四个渲染器 + 两个纯函数层：
 * - `parseArtifactPresetSpec(kind, spec)` 把 wire 上的 `unknown` spec 判成「可渲染 / 不可渲染」；
 * - `applyArtifactItems(kind, spec, items)` 把 `report(item, id)` 的条目流折成视图模型；
 * - `<ArtifactChart|Table|Metrics|Board>` 渲染它，`compact` 是 run 侧板卡片里的小尺寸形态。
 *
 * **这个 barrel 的静态依赖里没有 recharts**：`ArtifactChart` 是一层 `lazy()` 封装
 * （见 `ArtifactChart.tsx`），所以 import 本模块不会把图表库拖进首屏。
 */

export { type ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
export {
  parseArtifactPresetSpec,
  type ArtifactPresetKind,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

export { type PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
export { ArtifactChart } from "@/app-shell/workflow-artifacts/presets/ArtifactChart.js";
export { ArtifactTable } from "@/app-shell/workflow-artifacts/presets/ArtifactTable.js";
export { ArtifactMetrics } from "@/app-shell/workflow-artifacts/presets/ArtifactMetrics.js";
export { ArtifactBoard } from "@/app-shell/workflow-artifacts/presets/ArtifactBoard.js";
