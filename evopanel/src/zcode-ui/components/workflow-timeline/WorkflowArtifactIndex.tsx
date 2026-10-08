import type { CSSProperties } from "react";
import { ArrowUpRightIcon, EllipsisIcon } from "lucide-react";
import {
  ArtifactDetail,
  ArtifactKindIcon,
  artifactDetailText,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * 产物索引（侧板）：交付物行之后的**其余产物**，一件一行。
 *
 * 规则只有一条：**预览要么读得清，要么不画**。交付物留着它的框；其余产物把框丢掉，只剩瓦片说明行
 * 那一套语法——kind 图标、完整标题、等宽细节（迷你瓦片曾把它藏进 tooltip）、尾槽（v{n}，悬停让位
 * 给 ↗）——独立成行。层级由此来自**形态**（有图的一件 vs 只有字的其余），而不是大框与小框。
 *
 * 一行 26px。卡上按 `repeat(auto-fit, minmax(220px, 1fr))` 流成两列（窄卡一列）；侧板恒为一列。
 * 与交付物行之间隔一条细线（`--color-workflow-rule`，四格数字前的那条），卡因此读作收据的三段：
 * 交付了什么、还做了什么、花了多少。
 *
 * 「还有 N 个」是一扇门不是一件产物：省略号图标、次要色的字、↗ 不等悬停就在（与名册的「还有 n 个」
 * 一行同一条规则），点开 run 侧板看全部。
 *
 * 每一行永远是一颗 `<button>`：宿主没给回调时是**禁用**的按钮（「交付了什么」是事实，「能不能
 * 打开」是能力），与药丸、瓦片同一条门。悬停 / 聚焦时整行填 `surface-hover`（像侧栏行），填色向
 * 文字左右各多出 6px（负外边距），文字本身仍与交付物框的左边对齐。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 */
function enterStyle(enterDelayMs: number | undefined): CSSProperties | undefined {
  return enterDelayMs === undefined || enterDelayMs <= 0
    ? undefined
    : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };
}

const LINE_CLASS =
  "wf-line wf-arrive -mx-1.5 flex h-[26px] min-w-0 items-center gap-2 rounded-md bg-transparent px-1.5 text-left text-ui-sm outline-none";

function WorkflowArtifactLine({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  testId = "workflow-artifact-line",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** tooltip 覆盖（侧板把工作区出处放进来）；缺席时是「种类词 · 标题」。 */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;

  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
          : undefined
      }
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-testid={testId}
      data-variant="line"
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={enterStyle(enterDelayMs)}
      title={tooltip ?? `${kindLabel} · ${title}`}
      type="button"
    >
      <ArtifactKindIcon
        className="wf-line-icon size-3.5 shrink-0 text-foreground-subtle"
        kind={artifact.kind}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {hasDetail ? (
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-line-detail"
        >
          <ArtifactDetail artifact={artifact} labels={labels} />
        </span>
      ) : null}
      {showVersion || openable ? (
        <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          {showVersion ? (
            // 按版本重挂：同 id 再发布时尾槽弹入一次（wf-mark 的进场），悬停时让位给 ↗。
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-artifact-tile-version"
              key={version}
              title={intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.version" },
                { version: String(version) },
              )}
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                { version: String(version) },
              )}
            </span>
          ) : null}
          {openable ? (
            <span
              aria-hidden
              className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
              data-testid="workflow-artifact-tile-open"
            >
              <ArrowUpRightIcon className="size-3" />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** 「还有 N 个」——门，不是产物。砍过的清单不知道 N，写 `…`。 */
function WorkflowArtifactMoreLine({
  count,
  enterDelayMs,
  onOpen,
  testId = "workflow-artifact-more-line",
  truncated = false,
}: {
  count: number;
  /** 发射侧砍过（超 8）：N 不可知，写 `…`。 */
  truncated?: boolean;
  onOpen?: () => void;
  enterDelayMs?: number;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const openable = onOpen !== undefined;
  return (
    <button
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-testid={testId}
      data-variant="more"
      disabled={!openable}
      onClick={onOpen}
      style={enterStyle(enterDelayMs)}
      title={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      type="button"
    >
      <EllipsisIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
      <span className="min-w-0 flex-1 truncate text-foreground-subtle">
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.completion.moreArtifacts" },
          { count: truncated ? "…" : count.toLocaleString() },
        )}
      </span>
      {openable ? (
        // 一扇门没有状态标记可让位：↗ 在场即在，不等悬停（wf-pill-go-rest）。
        <span className="grid size-3 shrink-0 place-items-center">
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex items-center justify-center text-foreground-subtlest"
            data-testid="workflow-artifact-tile-open"
          >
            <ArrowUpRightIcon className="size-3" />
          </span>
        </span>
      ) : null}
    </button>
  );
}

type WorkflowArtifactIndexColumns = "auto" | "one";

/**
 * 索引本身：行 + 可选的门。`columns="auto"` 是卡上的两列流（≥ 2 × 220px 才成两列），`"one"` 是侧板
 * 的单列。`rule` 在上方画那条细线（跟在交付物行之后时要；索引独占卡时不要）。行依次落地，从
 * `firstDelayMs` 起每行错 30ms，门排在最后一行之后。
 */
export function WorkflowArtifactIndex({
  artifacts,
  columns = "auto",
  firstDelayMs = 0,
  folded = 0,
  labels,
  lineTestId,
  more = false,
  moreTestId,
  onOpenArtifact,
  onOpenRun,
  rule = false,
  testId = "workflow-artifact-index",
  tooltipOf,
  truncated = false,
}: {
  artifacts: readonly WorkflowCompletionArtifact[];
  labels: PresetLabels;
  columns?: WorkflowArtifactIndexColumns;
  rule?: boolean;
  /** 画「还有 N 个」；`folded` 是 N。 */
  more?: boolean;
  folded?: number;
  truncated?: boolean;
  firstDelayMs?: number;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
  testId?: string;
  lineTestId?: string;
  moreTestId?: string;
  tooltipOf?: (artifact: WorkflowCompletionArtifact) => string;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-5",
        columns === "auto" ? "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]" : "grid-cols-1",
        rule && "border-t border-[var(--color-workflow-rule)] pt-1.5",
      )}
      data-columns={columns}
      data-testid={testId}
    >
      {artifacts.map((artifact, index) => (
        <WorkflowArtifactLine
          artifact={artifact}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * index}
          key={artifact.id}
          labels={labels}
          {...(lineTestId === undefined ? {} : { testId: lineTestId })}
          {...(tooltipOf === undefined ? {} : { title: tooltipOf(artifact) })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {more ? (
        <WorkflowArtifactMoreLine
          count={folded}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * artifacts.length}
          truncated={truncated}
          {...(moreTestId === undefined ? {} : { testId: moreTestId })}
          {...(onOpenRun === undefined ? {} : { onOpen: onOpenRun })}
        />
      ) : null}
    </div>
  );
}
