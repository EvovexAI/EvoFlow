import type { ReactNode } from "react";
import { resolvePrimaryArtifact } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { WorkflowArtifactIndex } from "./WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "./WorkflowArtifactRow.js";
import { ArtifactSheetGlyph, type WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * 完成卡的产物区。
 * 从 `WorkflowCompletionCard` 拆出来：卡本身要守 400 行的门。
 *
 * - **有交付物**（打了 primary 旗子的那件，或清单只有一件）：交付物行，然后其余产物作**索引**——
 *   一件一行，卡宽时两列；至多六行，从第七件起五行 + 一行「还有 N 个」（点开 run 侧板看全部）。
 * - **没有交付物**：没有哪一件配得上一张预览，就一张也不画——索引独占产物区，同一个上限。
 *
 * 只有交付物的框读字节（预览要么读得清，要么不画）；索引行与「还有 N 个」从不读。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 */

/** 卡上索引的行数上限，也是不折叠时的上限。 */
export const COMPLETION_INDEX_MAX = 6;
/** 需要「还有 N 个」时，与它同在的行数。 */
const COMPLETION_INDEX_WITH_MORE = COMPLETION_INDEX_MAX - 1;

export interface CompletionArtifactLayout {
  /** 交付物；缺席即索引独占。 */
  primary?: WorkflowCompletionArtifact;
  /** 画成行的那些件（交付物之外）。 */
  lines: readonly WorkflowCompletionArtifact[];
  /** 没画出来的件数（「还有 N 个」的 N）。 */
  folded: number;
  /** 画「还有 N 个」：有折叠的件，或清单被发射侧砍过（此时 N 不可知，写 `…`）。 */
  more: boolean;
}

/** 布局的**唯一**判定；卡（节奏）、取数门（哪些件读字节）与渲染都从这里读。 */
export function completionArtifactLayout(
  artifacts: readonly WorkflowCompletionArtifact[],
  truncated: boolean,
): CompletionArtifactLayout {
  if (artifacts.length === 0) return { lines: [], folded: 0, more: false };
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  // 砍过的清单（超 8）不知道真实件数：仍给一扇门，N 写 `…`——与产物条的省略号同一个诚实。
  const more = rest.length > COMPLETION_INDEX_MAX || truncated;
  const lines = rest.slice(0, more ? COMPLETION_INDEX_WITH_MORE : COMPLETION_INDEX_MAX);
  return {
    ...(primary === undefined ? {} : { primary }),
    lines,
    folded: rest.length - lines.length,
    more,
  };
}

/** 卡上画出来的格数（行算一格，每条索引行一格，「还有 N 个」一格）：四格数字的落地节拍接在它们之后。 */
export function completionArtifactCellCount(layout: CompletionArtifactLayout): number {
  return (layout.primary === undefined ? 0 : 1) + layout.lines.length + (layout.more ? 1 : 0);
}

/** 会读字节的那些件：只有交付物的框读；索引行与门从不读。 */
export function completionPreviewIds(layout: CompletionArtifactLayout): ReadonlySet<string> {
  return new Set(layout.primary === undefined ? [] : [layout.primary.id]);
}

export function WorkflowCompletionArtifacts({
  artifactsTruncated,
  labels,
  layout,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
}: {
  layout: CompletionArtifactLayout;
  artifactsTruncated: boolean;
  labels: PresetLabels;
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
}) {
  const { primary, lines, folded, more } = layout;
  if (primary === undefined && lines.length === 0 && !more) return null;
  const hasPrimary = primary !== undefined;
  return (
    <>
      {hasPrimary ? (
        <WorkflowArtifactRow
          artifact={primary}
          enterDelayMs={PILL_STAGGER_MS}
          labels={labels}
          preview={renderPreview?.(primary) ?? <ArtifactSheetGlyph />}
          testId="workflow-completion-row"
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ) : null}
      {lines.length > 0 || more ? (
        // 索引跟在交付物行之后时隔一条细线；独占产物区时不要（上面没有东西可隔）。
        <WorkflowArtifactIndex
          artifacts={lines}
          columns="auto"
          firstDelayMs={PILL_STAGGER_MS * (hasPrimary ? 2 : 1)}
          folded={folded}
          labels={labels}
          lineTestId="workflow-completion-line"
          more={more}
          moreTestId="workflow-completion-more"
          rule={hasPrimary}
          testId="workflow-completion-index"
          truncated={artifactsTruncated}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
          {...(onOpenRun === undefined ? {} : { onOpenRun })}
        />
      ) : null}
    </>
  );
}
