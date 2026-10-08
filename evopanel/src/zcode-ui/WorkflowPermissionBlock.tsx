import { ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowPhasesDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  formatWorkflowArgValue,
  isWorkflowAmendPredecessorLive,
  readWorkflowAmendPredecessor,
  readWorkflowAmendScriptInherited,
  readWorkflowAmendTarget,
  readWorkflowMaxConcurrency,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
  readWorkflowSubagentModel,
  type WorkflowSavedSource,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * saved 来源徽标：这次运行的脚本来自项目里的一个文件，而不是模型现写的一段。
 *
 * 刻意只有一行加一张实参表，并且放在时间线**上方**：图仍是决策主体，来源与实参是「跑的是哪一份、带什么参数」这条
 * 前置事实，读完它才轮到图。徽标不表达任何信任——不变式 1：保存不产生信任。
 */
function WorkflowSavedSourceBadge({ saved }: { saved: WorkflowSavedSource }) {
  const { intl } = useZCodeIntl();

  const savedLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const scopeLabel =
    saved.scope === "project"
      ? intl.formatMessage({ id: "chat.permission.workflow.saved.scope.project" })
      : saved.scope;
  const argsLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.args" });
  const argEntries = Object.entries(saved.args);

  return (
    <div
      className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2"
      data-workflow-saved-source="true"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 text-ui-sm font-medium text-foreground-subtle">
          {scopeLabel === undefined ? savedLabel : `${savedLabel} · ${scopeLabel}`}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtlest"
          data-workflow-saved-name="true"
          title={saved.path ?? saved.name}
        >
          {saved.name}
        </span>
      </div>

      {saved.path === undefined ? null : (
        <p
          className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
          data-workflow-saved-path="true"
          title={saved.path}
        >
          {saved.path}
        </p>
      )}

      {argEntries.length === 0 ? null : (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-0.5"
          data-workflow-saved-args="true"
          aria-label={argsLabel}
        >
          {argEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-ui-sm text-foreground-subtlest">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-ui-sm text-foreground-subtle">
                {formatWorkflowArgValue(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * CreateWorkflow / AmendWorkflow 的运行确认块：表头（问句 +
 * 名字，右侧只有 `N phases`——没有「compiled」灯，也不再数子代理与步）+ lineage（只有修订有）+ 并发上限
 * （只有用户提过才有）+ saved 徽标 + **时间线** + 折叠脚本。Deny / Refine / Run 仍由 PermissionDialog 给。
 *
 * 修订的确认窗只在前驱是**别的会话**的 run（或用户亲手停过的 run）时出现：问句换成「调整此工作流？」，lineage 行说要改哪个 run、它是否还在跑。
 *
 * 权限块通常禁止折叠（见 PermissionDialog getPermissionBlockInteraction 的注释）；时间线和名称
 * 是决策关键内容且不可折叠，脚本是审计细节层。
 */
export function WorkflowPermissionBlock({
  request,
  workspacePath,
}: {
  request: ZCodePermissionRequest;
  /** 会话模型清单的作用域（PermissionDialog 给）：只用来把 provider id 换成 provider 名。 */
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();

  // v4 ask 的 raw 就是工具入参（product-projection 的 detail: payload.input），
  // 与聊天卡片共用 create-workflow.tsx 的读取规则，避免两处对同一入参各自解析。
  const scriptText = readWorkflowScript(request.raw);
  const workflowName = readWorkflowName(request.raw);
  const saved = readWorkflowSaved(request.raw);
  // 修订按工具名判（kind / title 是 v4 ask 挂上的工具名）；lineage 只对修订成立。
  const amend = isAmendWorkflowToolCall(request);
  const amendTarget = amend ? readWorkflowAmendTarget(request.raw) : undefined;
  const predecessor = amend ? readWorkflowAmendPredecessor(request.raw) : undefined;
  // 这次修订沿用前驱的脚本：
  // 入参里的脚本是 CLI 回填的那一份——图与折叠照常画将要跑的脚本，lineage 行多说一句「脚本不变」。
  const scriptInherited = amend && readWorkflowAmendScriptInherited(request.raw);
  // 并发上限：Create 与 Amend 同一个
  // 入参字段，所以不按工具名分叉——批准的是「以这个上限跑」，两种窗都要把它说出来。入参到这里
  // 已经过 resolveInput 的 clamp，所以窗上这个数就是会生效的那一条界。
  const maxConcurrency = readWorkflowMaxConcurrency(request.raw);
  // 子代理模型：与并发上限同族的一条「用户自己提的条件」，
  // 而且比它更该说出口——批准的是「让这些子代理跑在另一个模型上」。入参到这里已被 resolveInput
  // 解析成规范串，所以窗上这个 id 就是真会被用上的那个。主代理不受影响，文案因此只说子代理。
  const subagentModel = readWorkflowSubagentModel(request.raw);
  // 规范串只进 tooltip：屏幕上说模型名（必要时加思考强度），拼名规则与模型菜单同一条。
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  const describedSubagentModel = useMemo(
    () =>
      subagentModel === undefined
        ? undefined
        : describeWorkflowSubagentModel(subagentModel, {
            formatMessage: intl.formatMessage.bind(intl),
            ...(subagentModelProviderName === undefined
              ? {}
              : { providerName: subagentModelProviderName }),
          }),
    [intl, subagentModel, subagentModelProviderName],
  );

  // 空图（脚本里一次 ask / files.* 都没有）不值得一条空轨道；和聊天卡片同一判定。
  const display = request.display?.kind === "create_workflow" ? request.display : null;
  const causalityGraph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const hasGraph = causalityGraph !== undefined;
  const model = useMemo(
    () =>
      causalityGraph === undefined ? undefined : buildWorkflowTimeline(causalityGraph, undefined),
    [causalityGraph],
  );

  // 有图时脚本默认收起；零 step 脚本没有图可看，代码就是唯一内容，默认展开。
  const [scriptOpen, setScriptOpen] = useState(!hasGraph);

  // PermissionDialog 会跨请求复用同一组件实例（只按 requestId 重置内部状态），
  // 换请求后必须回到默认折叠态，否则上一次的展开会泄漏到下一个工作流。
  useEffect(() => {
    setScriptOpen(!hasGraph);
  }, [hasGraph, request.requestId]);

  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const title = intl.formatMessage({
    id: amend ? "chat.permission.workflow.amend.title" : "chat.permission.workflow.title",
  });
  const amendsLabel = intl.formatMessage({ id: "chat.permission.workflow.amends" });
  const stillRunningLabel = intl.formatMessage({ id: "chat.permission.workflow.amends.running" });
  const scriptUnchangedLabel = intl.formatMessage({
    id: "chat.permission.workflow.amends.scriptUnchanged",
  });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });
  const detail =
    model === undefined
      ? undefined
      : workflowPhasesDetail(intl.formatMessage.bind(intl), model, causalityGraph);

  return (
    <div className="space-y-3" data-workflow-permission-block="true">
      {/* 问句在最上：弹窗通用标题「需要权限」紧贴其上，两句连读才是完整的决策提问；
          名字随后，作为它下方那条时间线的标题。 */}
      <WorkflowCardHeader
        detail={detail}
        expanded
        kind={title}
        name={workflowName ?? fallbackName}
      />

      {/* lineage 行（修订才有）：紧贴名称行，与它一同构成「这次要改的是什么」的抬头；前驱还在跑时
          多说一句「将被停止」——用户批准的不只是一段新脚本，还有停掉一个正在跑的 run。 */}
      {amendTarget === undefined ? null : (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
          data-workflow-amends="true"
          {...(isWorkflowAmendPredecessorLive(predecessor)
            ? { "data-workflow-amends-live": "true" }
            : {})}
          {...(scriptInherited ? { "data-workflow-amends-script-inherited": "true" } : {})}
        >
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">{amendsLabel}</span>
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
            title={amendTarget}
          >
            {amendTarget}
          </span>
          {scriptInherited ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              · {scriptUnchangedLabel}
            </span>
          ) : null}
          {isWorkflowAmendPredecessorLive(predecessor) ? (
            <span className="shrink-0 text-ui-xs text-warning">· {stillRunningLabel}</span>
          ) : null}
        </div>
      )}

      {/* 并发上限：模型只在用户开口要求时才写这个字段，所以它在场就是**用户自己提的条件**——
          与 lineage 行同族的一句次要事实，紧随其后、排在来源徽标之前。缺席即不留位置。 */}
      {maxConcurrency === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-max-concurrency"
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.maxConcurrency" },
            { count: String(maxConcurrency) },
          )}
        </p>
      )}

      {/* 子代理模型：与并发上限同族，紧跟其后——两行都是「用户给这次 run 定下的条件」，
          而这一条更该说出口：批准的是让这些子代理跑在另一个模型上。主代理不受影响。 */}
      {describedSubagentModel === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-subagent-model"
          title={workflowSubagentModelTooltip(
            intl.formatMessage.bind(intl),
            describedSubagentModel,
          )}
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.subagentModel" },
            {
              model: workflowSubagentModelText(
                intl.formatMessage.bind(intl),
                describedSubagentModel,
              ),
            },
          )}
        </p>
      )}

      {saved ? <WorkflowSavedSourceBadge saved={saved} /> : null}

      {model === undefined ? null : <WorkflowTimeline className="py-1" model={model} />}

      {scriptText ? (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {/* 限高可滚动：长脚本不再把确认窗撑高。 */}
            <div className="max-h-72 overflow-auto" data-testid="workflow-script-scroll">
              <CodeBlock
                code={scriptText}
                language="typescript"
                renderMermaid={false}
                showLineNumbers
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
