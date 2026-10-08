import { ChevronRightIcon, Save } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { formatWorkflowArgValue } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  readSaveWorkflowInput,
  SaveWorkflowOverwriteBadge,
  type WorkflowArgDeclaration,
} from "@/ToolCallBlocks/renderers/save-workflow.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const NO_VALUE_PLACEHOLDER = "—";

function MetadataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="shrink-0 text-ui-sm text-foreground-subtlest">{label}</span>
      <span
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle",
          mono === true && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * args 声明表。列是 名称 / 类型 / 必填 / 默认值，说明另起一行跨列——五列在权限窗这个宽度上
 * 会把说明挤成一列碎字，而 DESIGN.md 明令不允许「靠紧凑截断才活得下去」的布局，也要求
 * 版面扛得住 i18n 膨胀。必填用文字而不是对勾：语义不靠图标单独表达。
 */
function WorkflowArgsTable({ args }: { args: readonly WorkflowArgDeclaration[] }) {
  const { intl } = useZCodeIntl();

  const headers = [
    intl.formatMessage({ id: "chat.permission.workflow.save.args.name" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.type" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.required" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.default" }),
  ];
  const requiredLabel = intl.formatMessage({
    id: "chat.permission.workflow.save.args.requiredYes",
  });
  const optionalLabel = intl.formatMessage({
    id: "chat.permission.workflow.save.args.requiredNo",
  });

  return (
    <table className="w-full border-collapse text-left" data-workflow-save-args="true">
      <thead>
        <tr>
          {headers.map((header) => (
            <th
              key={header}
              scope="col"
              className="border-b border-border pb-1 pr-3 text-ui-xs font-medium text-foreground-subtlest"
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {args.map((arg) => (
          <Fragment key={arg.name}>
            <tr data-workflow-save-arg={arg.name}>
              <td className="pr-3 pt-1.5 align-top font-mono text-ui-sm text-foreground-subtle">
                {arg.name}
              </td>
              <td className="pr-3 pt-1.5 align-top font-mono text-ui-sm text-foreground-subtlest">
                {arg.type ?? NO_VALUE_PLACEHOLDER}
              </td>
              <td className="pr-3 pt-1.5 align-top text-ui-sm text-foreground-subtlest">
                {arg.required ? requiredLabel : optionalLabel}
              </td>
              <td className="pt-1.5 align-top font-mono text-ui-sm text-foreground-subtlest">
                {arg.hasDefault ? formatWorkflowArgValue(arg.defaultValue) : NO_VALUE_PLACEHOLDER}
              </td>
            </tr>
            {arg.description === undefined ? null : (
              <tr>
                <td
                  colSpan={headers.length}
                  className="whitespace-pre-wrap break-words pb-1 pt-0.5 text-ui-sm text-foreground-subtlest"
                >
                  {arg.description}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * SaveWorkflow 的保存确认块。
 *
 * 这个 gate **没有 display 载荷**（spec 明确 v1 不加 `save_workflow` display kind）：入参就是
 * 全部内容，所以块里的每一项都读自归一化入参。脚本折叠沿用运行确认窗的同一习语与同一组文案
 * ——同一段脚本在两个窗里必须同名。
 *
 * 刻意**不**接 Refine：Refine 的语义是「拒绝这次运行并告诉模型怎么改工作流」，
 * 而保存是一次写盘，改法是模型换一组元数据重新调用，不需要第三个选项。
 */
export function SaveWorkflowPermissionBlock({ request }: { request: ZCodePermissionRequest }) {
  const { intl } = useZCodeIntl();

  const input = readSaveWorkflowInput(request.raw);
  const [scriptOpen, setScriptOpen] = useState(false);

  // PermissionDialog 跨请求复用组件实例，换请求后必须回到默认折叠态，
  // 否则上一次的展开会泄漏到下一个保存确认。
  useEffect(() => {
    setScriptOpen(false);
  }, [request.requestId]);

  // 覆盖与新建是两句**不同的问句**，不是同一句话加个标记：用户要在读第一行时就知道
  // 这次操作会不会替换掉已经存在的东西。
  const title = intl.formatMessage({
    id: input.overwrite
      ? "chat.permission.workflow.save.overwriteTitle"
      : "chat.permission.workflow.save.title",
  });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const overwriteLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.overwrite" });
  const overwriteHint = intl.formatMessage({ id: "chat.permission.workflow.save.overwriteHint" });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });

  return (
    <div className="space-y-3" data-save-workflow-permission-block="true">
      <p className="text-ui-base font-medium leading-5 text-foreground">{title}</p>

      <div className="flex min-w-0 items-center gap-2">
        <Save className="size-4 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 truncate font-mono text-ui-base text-foreground-subtle">
          {input.name ?? fallbackName}
        </span>
        {input.overwrite ? <SaveWorkflowOverwriteBadge label={overwriteLabel} /> : null}
      </div>

      {input.overwrite ? (
        <p
          className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-sm text-foreground-subtle"
          data-workflow-overwrite-hint="true"
        >
          {overwriteHint}
        </p>
      ) : null}

      <div className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2">
        {input.path === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.path" })}
            value={input.path}
            mono
          />
        )}
        {input.description === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.description" })}
            value={input.description}
          />
        )}
        {input.whenToUse === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.whenToUse" })}
            value={input.whenToUse}
          />
        )}
      </div>

      {input.args.length === 0 ? null : (
        <div className="space-y-1.5">
          <p className="text-ui-sm font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.permission.workflow.save.args" })}
          </p>
          <WorkflowArgsTable args={input.args} />
        </div>
      )}

      {input.script === undefined ? null : (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <CodeBlock
              code={input.script}
              language="typescript"
              renderMermaid={false}
              showLineNumbers
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
