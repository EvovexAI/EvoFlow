import { memo, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  TID_WORKFLOW_ARTIFACTS_SECTION,
  TID_WORKFLOW_ARTIFACTS_TOGGLE,
  TID_WORKFLOW_ARTIFACT_CARD,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactIndex } from "@/components/workflow-timeline/WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "@/components/workflow-timeline/WorkflowArtifactRow.js";
import { WorkflowArtifactTile } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  ArtifactDetail,
  artifactDisplayTitle,
  artifactKindMessageId,
  buildPresetLabels,
  resolvePrimaryArtifact,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

/**
 * workflow run 详情页的产物区。
 *
 * ⚠ 术语：这一节的 artifact 是脚本经 `artifact.*` 交付给**用户**的产出。它与上面那个「结果」
 * 面板（脚本的顶层返回值，给模型的）**是两件事**，约定要求两者在屏幕上同时可见且措辞
 * 可区分。
 *
 * 节头走阶段清单的节奏（同一高度、同一内缩、同一枚 chevron）。节身两种画法：
 * - **有交付物**（打了 primary 旗子的那件，或清单只有一件）：交付物行（与完成卡同一条
 *   `WorkflowArtifactRow`；面板窄于 380px 时框收成 136 × 85，由节身的容器查询决定），细线之下
 *   其余产物作**索引**：一件一行、单列、全部列出（与完成卡同一条 `WorkflowArtifactIndex`，卡上
 *   六行封顶、这里不封）。十二件产物是十二行，一屏之内。
 * - **没有交付物**：一片**画廊**：一件产物一张瓦片（预览框 + 说明行，`WorkflowArtifactTile`），列数
 *   随面板宽度自适应——130px 起一列、单列至多 180px，这个尺寸的缩略读得清，所以留着它。
 * 预览框里是产物本身：看板按自然尺寸居中、随 report 条目实时长；文档缩放着露出开头；CSV 前几行；
 * PDF 与二进制画纸页字形。清单已经是交付物在前、其余按首次发布顺序（hook 排过）。
 *
 * **默认展开**（与阶段节相反）：产物是这次运行**交付给用户的东西**，收起等于把交付物藏起来，
 * 而它恰恰是用户打开这个面板最常见的目的。仍可手动收起，收起时节头带件数。
 * **失败与取消的 run 一样渲染**：一个死在第 12 步的 run 仍然可能已经发布了一份 pdf。
 */
export const WorkflowRunArtifactsSection = memo(function WorkflowRunArtifactsSection({
  artifacts,
  sessionId,
  runId,
  onOpenArtifact,
}: {
  /** 已确认非空；零件时调用方整区不渲染（「无则缺席」惯例，不留空壳）。 */
  artifacts: readonly WorkflowRunArtifactView[];
  sessionId: string;
  runId: string;
  /** 缺席即瓦片禁用（宿主没注入打开 tab 的能力）。 */
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(true);
  // markdown 缩略要按 theme 选代码块配色；无 Provider 的宿主（单测）拿到 system。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const title = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.title" });
  // 稳定引用：四个渲染器都是 memo 的，labels 每帧换一个新对象会让那层比较永远命中不了。
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  const preview = (artifact: WorkflowRunArtifactView) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version}`}
      runId={runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // 工作区出处进 tooltip：它是一条路径，说明行放不下，也不该抢标题的位置。
  const tooltipOf = (
    artifact: Pick<WorkflowRunArtifactView, "id" | "kind" | "title" | "sourcePath">,
  ) => {
    const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
    return (
      `${kindLabel} · ${artifactDisplayTitle(artifact)}` +
      (artifact.sourcePath === undefined ? "" : `\n${artifact.sourcePath}`)
    );
  };

  return (
    <section
      className="wf-motion shrink-0 border-t border-border/60"
      data-artifacts-open={expanded ? "true" : "false"}
      data-testid={TID_WORKFLOW_ARTIFACTS_SECTION}
    >
      <button
        aria-expanded={expanded}
        aria-label={intl.formatMessage({
          id: expanded
            ? "chat.toolCall.workflow.run.artifacts.collapse"
            : "chat.toolCall.workflow.run.artifacts.expand",
        })}
        className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid={TID_WORKFLOW_ARTIFACTS_TOGGLE}
        onClick={() => setExpanded((previous) => !previous)}
        type="button"
      >
        <span className="min-w-0 shrink-0 truncate text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* 件数在**收起时也在场**——折叠不能让「这个 run 到底交付了什么」不可见。 */}
        <span
          className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-run-artifacts-count"
        >
          {artifacts.length.toLocaleString()}
        </span>
        {/* 收起时交付物的名字仍在节头上：它是用户打开面板最常要找的那一件。 */}
        {!expanded && primary !== undefined ? (
          <span
            className="min-w-0 truncate text-ui-sm text-foreground-subtle"
            data-testid="workflow-run-artifacts-primary-title"
          >
            · {artifactDisplayTitle(primary)}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-foreground-subtlest transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && primary !== undefined ? (
        // `@container/wf-artifacts`：交付物行的框按这个容器的宽度选 160 × 100 或 136 × 85。
        <div
          className="wf-unfold @container/wf-artifacts flex max-h-[50vh] flex-col gap-2.5 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-primary-body"
        >
          <WorkflowArtifactRow
            artifact={primary}
            enterDelayMs={PILL_STAGGER_MS}
            labels={labels}
            preview={preview(primary)}
            // 与瓦片同一个 testid（`data-variant="row"` 区分形态）：它仍是「一件产物的卡」。
            testId={TID_WORKFLOW_ARTIFACT_CARD}
            title={tooltipOf(primary)}
            {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
          />
          {rest.length > 0 ? (
            // 单列、不封顶：侧板是承诺列出全部产物的地方。行也是「一件产物的卡」（`data-variant="line"`）。
            <WorkflowArtifactIndex
              artifacts={rest}
              columns="one"
              firstDelayMs={PILL_STAGGER_MS * 2}
              labels={labels}
              lineTestId={TID_WORKFLOW_ARTIFACT_CARD}
              rule
              testId="workflow-run-artifact-index"
              tooltipOf={tooltipOf}
              {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            />
          ) : null}
        </div>
      ) : expanded ? (
        <div
          className="wf-unfold grid max-h-[50vh] grid-cols-[repeat(auto-fill,minmax(130px,180px))] gap-3 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-gallery"
        >
          {artifacts.map((artifact, index) => (
            <WorkflowArtifactTile
              artifact={artifact}
              detail={<ArtifactDetail artifact={artifact} labels={labels} />}
              enterDelayMs={PILL_STAGGER_MS * (index + 1)}
              key={artifact.id}
              preview={preview(artifact)}
              testId={TID_WORKFLOW_ARTIFACT_CARD}
              title={tooltipOf(artifact)}
              {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
});
