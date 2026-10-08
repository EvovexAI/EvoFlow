import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  truncateArtifactChipTitle,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 产物药丸：与子代理药丸同一套语法——
 * 同样的高度、圆角、底色、悬停抬起、尾槽里 ↗ 顶替原有内容——只换两样：**方**的墨灰瓦片代替
 * **圆**的带色头像（颜色说「谁」，形状说「什么」），尾槽里放版本号而不是状态标记。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是引擎内部「脚本顶层返回值」的同名词。
 *
 * 两个尺寸：`md`（32px）用在药丸本来就在的地方——时间线下的产物条、中枢的「最近产物」；
 * `sm`（24px）用在单行里——完成通知的折叠头部、中枢的运行历史行。产物**有地方**时（完成卡、
 * run 侧板的画廊）用的是瓦片（`WorkflowArtifactTile`），说明行就是这枚药丸的语法。
 *
 * 永远是 `<button>`：产物是一个「可以打开的东西」，宿主没给回调时它是**禁用**的按钮，看起来与
 * 没有会话的子代理药丸一样安静——「交付了什么」是事实，「能不能打开」是能力。版本号从 v2 起才
 * 出现（v1 是常态，写出来是噪音）；同 id 再发布时尾槽按版本重挂，播标记的弹入动画。
 */
export interface ArtifactPillData {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  version?: number;
}

export type ArtifactPillSize = "md" | "sm";

export function WorkflowArtifactPill({
  artifact,
  className,
  detail,
  enterDelayMs,
  fill = false,
  onOpen,
  size = "md",
  testId = "workflow-artifact-pill",
  title,
  truncateTitle = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifact: ArtifactPillData;
  size?: ArtifactPillSize;
  /** 名字之后、尾槽之前的等宽附属信息（侧栏行的 `PDF · 1.2 MB` / `12 items`）。 */
  detail?: ReactNode;
  /** 在场即可打开；缺席即禁用（回调的存在即门控）。 */
  onOpen?: (artifactId: string) => void;
  /** 名字占满剩余宽度（侧栏行）；缺席时药丸按内容收拢（时间线下的产物条）。 */
  fill?: boolean;
  /** 条里的标题截到 24 字（完整标题在 tooltip 里）；侧栏行靠 CSS truncate，不截字。 */
  truncateTitle?: boolean;
  /** tooltip 覆盖；缺席时是「种类词 · 标题」。 */
  title?: string;
  /** 入场延迟（产物条里依次落地，每枚错 30 ms）。 */
  enterDelayMs?: number;
  testId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const fullTitle = artifactDisplayTitle(artifact);
  const label = truncateTitle ? truncateArtifactChipTitle(fullTitle) : fullTitle;
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const versionLabel = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.artifacts.version" },
    { version: String(version) },
  );
  const md = size === "md";
  // 有延迟的入场要 backwards 填充：等待期间保持起始帧（与子代理药丸同一条理由）。
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  // 通知摘要复用 Read 链接语法，避免工具行中出现厚重的产物药丸。
  if (variant === "link")
    return (
      <button
        type="button"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        data-testid={testId}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-version={String(version)}
        title={title ?? `${kindLabel} · ${fullTitle}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-ui-base font-normal text-foreground-subtle enabled:cursor-pointer enabled:hover:underline"
      >
        <ArtifactKindIcon className="size-4 shrink-0" kind={artifact.kind} />
        <span className="min-w-0 truncate">{label}</span>
        {showVersion ? (
          <span data-testid="workflow-run-artifact-version">{versionLabel}</span>
        ) : null}
      </button>
    );
  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${fullTitle}`
          : undefined
      }
      className={cn(
        "wf-pill wf-arrive flex min-w-0 max-w-full items-center bg-surface text-left",
        md
          ? "h-8 gap-2 rounded-[9px] pl-2 pr-2.5 text-ui-sm"
          : "h-6 gap-1.5 rounded-md pl-1.5 pr-2 text-ui-xs",
        openable
          ? "wf-pill-open cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          : "cursor-default",
        fill && "w-full",
        className,
      )}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-pill-size={size}
      data-testid={testId}
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={style}
      title={title ?? `${kindLabel} · ${fullTitle}`}
      type="button"
    >
      <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
      <span className={cn("wf-pill-name min-w-0 truncate text-foreground", fill && "flex-1")}>
        {label}
      </span>
      {detail === undefined || detail === null ? null : (
        <span className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {detail}
        </span>
      )}
      {showVersion || openable ? (
        <span
          className={cn(
            "wf-pill-tail grid shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1",
            md ? "size-3.5" : "size-3",
          )}
          data-testid="workflow-pill-tail"
        >
          {showVersion ? (
            // 按版本重挂：同 id 再发布时尾槽弹入一次（wf-mark 的进场），悬停时让位给 ↗。
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-run-artifact-version"
              key={version}
              title={versionLabel}
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
              data-testid="workflow-artifact-pill-open"
            >
              <ArrowUpRightIcon className={md ? "size-3.5" : "size-3"} />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
