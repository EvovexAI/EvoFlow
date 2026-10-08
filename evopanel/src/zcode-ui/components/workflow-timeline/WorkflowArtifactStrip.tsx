import type { KeyboardEvent, MouseEvent } from "react";
import { ARTIFACT_CHIP_MAX_VISIBLE } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";
import {
  WorkflowArtifactPill,
  type ArtifactPillData,
  type ArtifactPillSize,
} from "./WorkflowArtifactPill.js";

/**
 * 产物条：一行产物药丸，至多三枚，
 * 其余折成等宽的 `+N`。时间线下（工具卡、轮尾摘要）、完成通知的折叠头部、中枢的运行历史行与
 * 「最近产物」条都是它——同一个产物在四处必须长得一样。全量清单在 run 侧板。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 *
 * 事件只替**药丸**止步：条常坐在别的可点区域里（通知行的折叠开关、轮尾
 * 摘要的整块开关、中枢的历史行），药丸是一颗按钮而不是那块区域的一部分——**包括禁用的**：禁用
 * 只让打开变成空操作，不该顺带把外面那块点开（浏览器对禁用控件不派发 click，jsdom 会派到祖先；
 * 这里两边一致）。条的空白与 `+N` 则**是**那块区域的一部分：点它们冒泡给宿主，轮尾摘要因此切换。
 */
function hitsPill(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

export function WorkflowArtifactStrip({
  artifacts,
  className,
  moreTestId,
  onOpenArtifact,
  pillTestId,
  size = "md",
  testId,
  truncated = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifacts: readonly ArtifactPillData[];
  size?: ArtifactPillSize;
  /** 缺席即药丸全部禁用（回调的存在即门控）。 */
  onOpenArtifact?: (artifactId: string) => void;
  /** 发射侧砍过（超上界或被过滤）——`+N` 因此可能少报，用 `…` 而不是数字。 */
  truncated?: boolean;
  testId?: string;
  pillTestId?: string;
  moreTestId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  if (artifacts.length === 0) return null;
  const visible = artifacts.slice(0, ARTIFACT_CHIP_MAX_VISIBLE);
  const overflow = artifacts.length - visible.length;
  return (
    <span
      className={cn(
        "wf-motion flex min-w-0 shrink flex-wrap items-center",
        size === "md" ? "gap-1.5" : "gap-1",
        className,
      )}
      data-testid={testId}
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        if (hitsPill(event.target)) event.stopPropagation();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (hitsPill(event.target)) event.stopPropagation();
      }}
    >
      {visible.map((artifact, i) => (
        <WorkflowArtifactPill
          artifact={artifact}
          variant={variant}
          enterDelayMs={PILL_STAGGER_MS * i}
          key={artifact.id}
          size={size}
          truncateTitle
          {...(pillTestId === undefined ? {} : { testId: pillTestId })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {overflow > 0 || truncated ? (
        <span
          className="shrink-0 px-0.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid={moreTestId}
        >
          {intl.formatMessage(
            { id: "chat.backgroundResult.workflow.artifacts.more" },
            { count: truncated && overflow === 0 ? "…" : String(overflow) },
          )}
        </span>
      ) : null}
    </span>
  );
}
