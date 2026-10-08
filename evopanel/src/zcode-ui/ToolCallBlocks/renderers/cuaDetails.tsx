import { CheckCircle2, XCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CuaDetailsModel } from "@/ToolCallBlocks/renderers/cua.js";
import { CuaScreenshotSection } from "@/ToolCallBlocks/renderers/CuaScreenshotSection.js";
import { CuaDetailListSection } from "@/ToolCallBlocks/renderers/cuaListDetails.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function CuaDetailRows({ rows }: { rows: CuaDetailsModel["actionRows"] }) {
  const { intl } = useZCodeIntl();
  return (
    <dl className="grid grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {rows.map((row) => (
        <div key={`${row.labelId}:${row.value}`} className="contents">
          <dt className="text-foreground-subtlest">{intl.formatMessage({ id: row.labelId })}</dt>
          <dd
            className={
              row.code
                ? "min-w-0 break-all font-mono text-foreground"
                : "min-w-0 break-words text-foreground"
            }
          >
            <span className="flex items-center gap-2">
              {row.status === true ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
              ) : null}
              {row.status === false ? (
                <XCircle className="size-3.5 shrink-0 text-destructive" />
              ) : null}
              {row.value}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CuaToolCallDetails({
  model,
  toolCall,
}: {
  model: CuaDetailsModel;
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
}) {
  const { intl } = useZCodeIntl();
  const typedCount = readText(asRecord(toolCall.input), "text")?.length ?? 0;
  // 完整 tool call JSON 混入了面向用户的 CUA 详情，暴露内部生命周期字段并制造无效入口。
  // 原始数据继续保留在协议与持久化层；这里仅渲染用户完成操作所需的信息。
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface/40 p-3">
      {model.actionRows.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.action" })}
          </h4>
          <CuaDetailRows rows={model.actionRows} />
        </section>
      ) : null}
      <section
        className={
          model.actionRows.length > 0 ? "space-y-2 border-t border-border pt-3" : "space-y-2"
        }
      >
        <h4 className="text-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.cua.details.result" })}
        </h4>
        <div
          className={
            model.success
              ? "flex items-center gap-2 text-sm text-foreground"
              : "flex items-center gap-2 text-sm text-destructive"
          }
        >
          {model.success ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : (
            <XCircle className="size-3.5 shrink-0" />
          )}
          <span>
            {intl.formatMessage(
              { id: model.resultId },
              model.resultValues ?? { count: String(typedCount) },
            )}
          </span>
        </div>
      </section>
      {model.failureReasonId || model.failureReason ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.failureReason" })}
          </h4>
          <p className="text-sm text-foreground">
            {model.failureReasonId
              ? intl.formatMessage({ id: model.failureReasonId })
              : model.failureReason}
          </p>
        </section>
      ) : null}
      {model.suggestedActionId || model.suggestedAction ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.suggestedAction" })}
          </h4>
          <p className="text-sm text-foreground">
            {model.suggestedActionId
              ? intl.formatMessage({ id: model.suggestedActionId })
              : model.suggestedAction}
          </p>
        </section>
      ) : null}
      {model.screenshot ? <CuaScreenshotSection screenshot={model.screenshot} /> : null}
      {model.permissionRows?.length ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.permissions" })}
          </h4>
          <CuaDetailRows rows={model.permissionRows} />
        </section>
      ) : null}
      {model.environmentRows?.length ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.environment" })}
          </h4>
          <CuaDetailRows rows={model.environmentRows} />
        </section>
      ) : null}
      {model.list && model.list.items.length > 0 ? (
        <CuaDetailListSection list={model.list} />
      ) : null}
      {model.stateRows.length > 0 ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.state" })}
          </h4>
          <CuaDetailRows rows={model.stateRows} />
        </section>
      ) : null}
    </div>
  );
}
