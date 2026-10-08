import { TID_CHAT_WORKFLOW_ARTIFACT_CHIP } from "@zcode/shared";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * 终态通知行折叠头部尾部的产物条：小号产物药丸，≤ 3 枚 + `+N`。
 *
 * ⚠ 术语：条上的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与同一条通知里的
 * `result`（脚本顶层返回值）不是一回事。
 *
 * 载荷缺席（批量轮 / 旧 transcript / 旧 CLI）⇒ 整块缺席，通知行与今天逐像素相同。
 * 回调缺席（冷恢复联查不到、只读会话）⇒ 药丸禁用而不是消失：「这次运行交付了什么」是事实，
 * 能不能打开是能力。事件在条这一层止步——头部整条是折叠开关，药丸不是它的一部分。
 */
export function WorkflowNotificationArtifactChips({
  artifacts,
  truncated,
  onOpenArtifact,
}: {
  artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>;
  /** 发射侧砍过（超 8 或被过滤）——「+N」因此可能少报，用「…」而不是数字。 */
  truncated?: boolean;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-notification-artifacts-more"
      pillTestId={TID_CHAT_WORKFLOW_ARTIFACT_CHIP}
      size="sm"
      variant="link"
      testId="workflow-notification-artifacts"
      {...(truncated === undefined ? {} : { truncated })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
