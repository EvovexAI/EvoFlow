/* eslint-disable max-lines -- 已安装插件列表与详情弹窗共享组件分组/Hook 明细渲染，集中维护更利于与参考图保持一致。 */
import { AlertTriangle } from "lucide-react";
import type { ZCodePluginDiagnostic, ZCodePluginInfo } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 插件 warning 诊断列表。CLI 对「声明的技能路径扫描为空」等异常
 * 只写 diagnostics 的话 UI 无渲染位置，用户无从排查。message 由 CLI 下发并包含
 * 具体路径（协议 wire 不携带 path 字段），因此正文直出 message 即可。
 */
export function PluginWarningList({ warnings }: { warnings: ZCodePluginDiagnostic[] }) {
  return (
    <ul className="space-y-2">
      {warnings.map((diagnostic, index) => (
        <li
          key={`${diagnostic.code}-${index}`}
          className="flex min-w-0 items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-all text-ui-sm text-foreground">{diagnostic.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function PluginHookDetails({
  hooks,
}: {
  hooks: NonNullable<ZCodePluginInfo["hookDetails"]>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div>
      <div className="mb-2 text-ui-xs font-medium text-foreground">
        {intl.formatMessage({ id: "settings.plugins.detail.hooks" })}
      </div>
      {hooks.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.detail.none" })}
        </div>
      ) : (
        <div className="space-y-2">
          {hooks.map((hook, index) => (
            <div
              key={`${hook.event}-${hook.matcher ?? "default"}-${hook.command}-${index}`}
              className="min-w-0 space-y-2 rounded-lg border border-border bg-surface px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="rounded-md font-mono">
                  {hook.event}
                </Badge>
                <Badge variant="outline" className="rounded-md">
                  {hook.matcher ??
                    intl.formatMessage({
                      id: "settings.plugins.detail.hook.defaultMatcher",
                    })}
                </Badge>
                <Badge variant={hook.runnable ? "secondary" : "outline"} className="rounded-md">
                  {hook.runnable
                    ? intl.formatMessage({
                        id: "settings.plugins.detail.hook.runnable",
                      })
                    : intl.formatMessage({
                        id: "settings.plugins.detail.hook.diagnosticOnly",
                      })}
                </Badge>
              </div>
              <PluginDetailInlineValue
                label={intl.formatMessage({
                  id: "settings.plugins.detail.hook.command",
                })}
                value={formatHookCommand(hook)}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {hook.timeoutMs !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.timeoutMs",
                    })}
                    value={`${hook.timeoutMs}ms`}
                  />
                ) : null}
                {hook.timeout !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.timeout",
                    })}
                    value={String(hook.timeout)}
                  />
                ) : null}
                {hook.async !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.async",
                    })}
                    value={String(hook.async)}
                  />
                ) : null}
                {hook.shell !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.shell",
                    })}
                    value={hook.shell === true ? "true" : hook.shell}
                  />
                ) : null}
                {hook.statusMessage ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.statusMessage",
                    })}
                    value={hook.statusMessage}
                  />
                ) : null}
              </div>
              <PluginDetailInlineValue
                label={intl.formatMessage({
                  id: "settings.plugins.detail.hook.sourcePath",
                })}
                value={hook.sourcePath}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PluginDetailInlineValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground">{value}</div>
    </div>
  );
}

function formatHookCommand(hook: NonNullable<ZCodePluginInfo["hookDetails"]>[number]): string {
  if (!hook.args || hook.args.length === 0) return hook.command;
  return `${hook.command} ${hook.args.join(" ")}`;
}

export function PluginDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-1 break-all font-mono text-ui-xs text-foreground">{value}</div>
    </div>
  );
}
