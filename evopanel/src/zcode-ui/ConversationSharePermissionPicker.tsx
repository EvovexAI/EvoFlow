import { Fragment } from "react";
import { Check, Globe, Info, Lock, UserRoundPen } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ConversationSharePermission = "private" | "link-viewer" | "link-editor";

const PERMISSION_OPTIONS = [
  {
    value: "private",
    labelId: "conversationShare.permission.private",
    Icon: Lock,
  },
  {
    value: "link-viewer",
    labelId: "conversationShare.permission.linkViewer",
    Icon: Globe,
  },
  {
    value: "link-editor",
    labelId: "conversationShare.permission.linkEditor",
    Icon: UserRoundPen,
  },
] as const;

export function ConversationSharePermissionPicker({
  permission,
  onChange,
  disabled = false,
  variant = "default",
}: {
  permission: ConversationSharePermission;
  onChange: (permission: ConversationSharePermission) => void;
  disabled?: boolean;
  variant?: "default" | "compact";
}) {
  const { intl } = useZCodeIntl();
  const compact = variant === "compact";

  return (
    <div
      data-testid="conversation-share-permission-picker"
      data-variant={variant}
      className={cn("flex flex-col", compact ? "min-w-0 gap-1" : "gap-1.5")}
    >
      {/* compact 变体曾把字段标签降到 text-ui-xs，导致它和同一确认表单的分享标题层级不一致。*/}
      <span
        data-testid="conversation-share-permission-label"
        className={cn(compact ? "text-ui-sm" : "text-ui-base", "text-foreground-subtle")}
      >
        {intl.formatMessage({ id: "conversationShare.permissionLabel" })}
      </span>
      {/* 根因：窗口断点无法反映侧栏挤压后的空间；按确认面板实际宽度分列，并完整展示权限。 */}
      <div
        role="radiogroup"
        aria-label={intl.formatMessage({ id: "conversationShare.permissionLabel" })}
        className={cn(
          compact
            ? "grid grid-cols-1 gap-1.5 @min-[640px]/share:grid-cols-3"
            : "flex flex-col overflow-hidden rounded-lg border border-border",
        )}
      >
        {PERMISSION_OPTIONS.map(({ value, labelId, Icon }, index) => {
          const selected = permission === value;
          const label = intl.formatMessage({ id: labelId });
          return (
            <Fragment key={value}>
              {!compact && index > 0 ? (
                <div className="px-2" data-share-permission-divider>
                  <div className="h-px bg-border" />
                </div>
              ) : null}
              <button
                type="button"
                role="radio"
                data-conversation-share-permission={value}
                aria-checked={selected}
                aria-label={label}
                aria-disabled={disabled}
                disabled={disabled}
                onClick={() => onChange(value)}
                className={cn(
                  "flex w-full min-w-0 items-center text-left text-foreground outline-none transition-colors hover:bg-menu-hover focus-visible:bg-menu-hover disabled:pointer-events-none disabled:opacity-60",
                  compact
                    ? "min-h-11 gap-2 rounded-lg border border-input-border bg-input px-2.5 py-2 text-ui-sm"
                    : "h-11 gap-1.5 p-3 text-ui-base",
                  compact && selected && "border-input-border-focused bg-selected",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <Icon className={cn(compact ? "size-4" : "size-4", "text-foreground")} />
                </span>
                <span className={cn("min-w-0 flex-1", compact ? "grid gap-0.5" : "truncate")}>
                  <span className={cn(compact && "whitespace-normal break-words")}>{label}</span>
                  {compact ? (
                    <span className="whitespace-normal break-words text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({
                        id:
                          value === "private"
                            ? "conversationShare.permission.privateHint"
                            : value === "link-viewer"
                              ? "conversationShare.permission.linkViewerHint"
                              : "conversationShare.permission.linkEditorHint",
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {selected ? <Check className="size-4 text-foreground" /> : null}
                </span>
              </button>
            </Fragment>
          );
        })}
      </div>

      {!compact && permission !== "private" ? (
        <div role="note" className="flex items-start gap-1 text-warning">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <Info className="size-4" aria-hidden="true" />
          </span>
          <p className="min-w-0 flex-1 text-ui-sm leading-4">
            {intl.formatMessage({ id: "conversationShare.publicWarning" })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
