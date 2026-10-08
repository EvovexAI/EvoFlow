import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ArtifactPillData } from "./WorkflowArtifactPill.js";

/**
 * 产物瓦片：一件产物 = 预览区 + 说明行。
 * 说明行是产物药丸的语法原样（方形 kind 瓦片、标题、等宽细节、版本尾槽、悬停 ↗ 顶替）；预览区是
 * 产物**本身**的缩略——文档开头的缩放渲染、CSV 的前几行、看板自己——由调用方按 kind 交进来，
 * 交不出来（PDF / 二进制 / 字节没到）就画一张安静的纸页字形。
 *
 * 药丸是产物在一行里的样子，瓦片是它有地方时的样子。今天只剩一处画它：run 侧板**没有交付物**时的
 * 画廊（130–180px 一列，读得清）。有交付物时其余产物走索引行（`WorkflowArtifactIndex`）——预览
 * 要么读得清，要么不画；曾经的「迷你瓦片」（六列的小框）就是因为读不清才撤的。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 *
 * 整张瓦片永远是一颗 `<button>`：宿主没给回调时是**禁用**的按钮（「交付了什么」是事实，「能不能
 * 打开」是能力），与药丸同一条门。
 *
 * 预览框曾是按钮的子节点，而 markdown 缩略里可能有自己的控件（表格的
 * 「复制 Markdown」、文件链接），于是 `<button>` 嵌进了 `<button>`——React 报 DOM 嵌套错误。现在预览
 * 框是按钮的**兄弟**节点并标 `inert`（它是缩略图，不可交互也不进无障碍树），按钮只包说明行，用一个
 * 铺满整张瓦片的 `::after`（`.wf-tile-hit`）接住整块的点击、悬停与焦点；悬停时框的抬起由
 * `.wf-tile:has(.wf-tile-hit:hover)` 驱动。
 */
export interface WorkflowCompletionArtifact extends ArtifactPillData {
  contentType?: string;
  bytes?: number;
  sourcePath?: string;
  /** 预置看板喂进来的条数；通知载荷上没有，只有活投影 / journal 补过之后才有。 */
  itemCount?: number;
  /** 预置看板的 spec（只有 journal 带得回来）；预览区据它画图。 */
  spec?: unknown;
  /** 作者写的一两句说明；只有交付物行念它（瓦片放不下）。 */
  description?: string;
  /** run 的交付物。 */
  primary?: true;
}

/** 内容拿不到时的纸页字形：一张小纸 + 右下角的扩展名徽字。诚实，不装饰。 */
export function ArtifactSheetGlyph({ badge }: { badge?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center" data-testid="workflow-artifact-sheet">
      <div className="flex aspect-[3/4] w-[38%] max-w-[72px] flex-col gap-1.5 rounded-[4px] border border-border bg-card p-2.5 shadow-[0_1px_0_var(--color-workflow-rule)]">
        <i className="block h-[5px] w-[55%] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] w-[70%] rounded-sm bg-surface-hover" />
      </div>
      {badge === undefined ? null : (
        <span
          className="absolute bottom-2 right-2 rounded-[4px] bg-surface-hover px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
          data-testid="workflow-artifact-sheet-badge"
        >
          {badge}
        </span>
      )}
    </div>
  );
}

export function WorkflowArtifactTile({
  artifact,
  detail,
  enterDelayMs,
  onOpen,
  preview,
  testId = "workflow-artifact-tile",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  /** 预览区的内容；缺席即纸页字形。 */
  preview?: ReactNode;
  /** 名字之后、尾槽之前的等宽附属信息（`CSV · 6 KB` / `4 items`）。 */
  detail?: ReactNode;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** tooltip 覆盖（侧板把工作区出处放进来）；缺席时是「种类词 · 标题」。 */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div className="wf-tile relative flex min-w-0 flex-col gap-1.5" data-variant="tile">
      {/* 预览框：底部渐隐由预览内容自己决定（文档缩略要「还有」的暗示，看板与图片不要）。 */}
      <div
        aria-hidden
        className="wf-tile-frame wf-arrive relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-panel"
        data-testid="workflow-artifact-tile-frame"
        inert
        style={style}
      >
        {preview ?? <ArtifactSheetGlyph />}
      </div>
      <button
        aria-label={
          openable
            ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
            : undefined
        }
        className={cn(
          "wf-tile-hit wf-arrive flex min-w-0 items-center gap-1.5 rounded-lg bg-transparent p-0 px-0.5 text-left text-ui-sm outline-none",
          openable ? "wf-tile-open cursor-pointer" : "cursor-default",
        )}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-open={openable ? "true" : undefined}
        data-artifact-version={String(version)}
        data-testid={testId}
        data-variant="tile"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        style={style}
        title={tooltip ?? `${kindLabel} · ${title}`}
        type="button"
      >
        <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
        <span className="wf-pill-name min-w-0 flex-1 truncate text-foreground">{title}</span>
        {detail === undefined || detail === null ? null : (
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
            data-testid="workflow-artifact-tile-detail"
          >
            {detail}
          </span>
        )}
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
    </div>
  );
}
