import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 工具卡卡体顶部的一行元信息：淡色标签 + 等宽值（来源文件名、run id……），可带一句淡色注记。
 * `marker` 落成 `data-workflow-card-<marker>="true"`，测试与样式按它找行；`flag` 落成
 * `data-workflow-card-<marker>-<flag>="true"`，说这一行额外成立的事实。
 */
export function WorkflowCardMetaLine({
  marker,
  label,
  value,
  title,
  note,
  flag,
}: {
  marker: string;
  label: string;
  value: string;
  title?: string;
  note?: string;
  flag?: string;
}) {
  return (
    <p
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-sm"
      {...{ [`data-workflow-card-${marker}`]: "true" }}
      {...(flag === undefined ? {} : { [`data-workflow-card-${marker}-${flag}`]: "true" })}
    >
      <span className="shrink-0 text-foreground-subtlest">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground-subtle" title={title ?? value}>
        {value}
      </span>
      {note === undefined ? null : (
        <span className="shrink-0 text-foreground-subtlest">· {note}</span>
      )}
    </p>
  );
}

/**
 * 修订行卡体里的 lineage：
 * 「调整 run X」——这张卡要改的是哪个 run。`runId` 从 AmendWorkflow 入参读（`run_id`），
 * 与确认窗同一条读取规则；CreateWorkflow 行没有它，卡体也就没有这一行。
 *
 * `scriptInherited`：这次修订省略了脚本、沿用前驱的那一份（「Keeping the predecessor's script」），
 * 行尾多说一句「脚本不变」——卡上没有脚本可折叠，缺脚本正是这次调用的用意。
 */
export function WorkflowAmendsLine({
  runId,
  scriptInherited = false,
}: {
  runId: string;
  scriptInherited?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <WorkflowCardMetaLine
      marker="amends"
      label={intl.formatMessage({ id: "chat.toolCall.workflow.amend.amends" })}
      value={runId}
      {...(scriptInherited
        ? {
            note: intl.formatMessage({ id: "chat.toolCall.workflow.amend.scriptUnchanged" }),
            flag: "script-inherited",
          }
        : {})}
    />
  );
}
