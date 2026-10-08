import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { formatAgentMessage } from "./agentHelpers.js";

export function AgentPromptSection({
  prompt,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  prompt: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  const { intl } = useZCodeIntl();
  const promptLabel = formatAgentMessage(intl, "chat.toolCall.agent.prompt", "Prompt");

  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border flex flex-col">
        <div className="flex min-w-0 items-center p-3">
          <h4 className="min-w-0 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
            {promptLabel}
          </h4>
        </div>
        <div className="overflow-auto max-h-50" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent prompt 里可能包含代码块或长命令，手机窄屏只开纵向滚动会裁掉横向内容。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {prompt}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}
