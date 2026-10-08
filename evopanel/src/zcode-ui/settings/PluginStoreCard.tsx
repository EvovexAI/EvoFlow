import {
  Crown,
  Download,
  Loader2,
  MoreHorizontal,
  Power,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  canUpdatePluginItem,
  resolveItemDescription,
  resolveItemDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

/** 商店条目的通用动作集：列表卡片、详情页共用同一套回调与进行中态判定。 */
export interface PluginStoreActions {
  onOpenDetail: (pluginId: string) => void;
  /** 安装或恢复（restorable 内置插件走 restoreBuiltin，其余走 install）。 */
  onInstall: (item: StorePluginItem) => void;
  onUninstall: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  /** 删除当前 Workspace scope 的显式配置，使其回退到 User。 */
  onResetConfig?: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  operationId: string | null;
  togglingPluginId: string | null;
}

function isItemBusy(item: StorePluginItem, actions: PluginStoreActions): boolean {
  return (
    actions.operationId === `plugin:install:${item.name}@${item.marketplace}` ||
    actions.operationId === `plugin:restore:${item.id}` ||
    actions.operationId === `plugin:uninstall:${item.id}` ||
    actions.operationId === `plugin:update:${item.id}` ||
    actions.operationId === `plugin:reset-config:${item.id}` ||
    actions.togglingPluginId === item.id
  );
}

/**
 * 付费套餐提示：目录条目声明 `listing.requiresPaidPlan` 时，在标题右侧展示渐变徽标。
 * 表达的是「需要付费套餐才好用」这个使用条件，不是「插件是收费商品」——不做安装门禁。
 * 商店卡片与详情页标题共用同一渐变徽标。
 * 徽标使用短文案，完整条件由 Tooltip 和 aria-label 表达；缺字段时整个标记不渲染。
 * hover 提示走 ControlHintTooltip（Root Provider 的 delayDuration=0，即时弹出），
 * 不用原生 title——后者有约 1s 系统延迟。
 */
export function PluginStorePaidPlanBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "listing">;
}) {
  const { intl } = useZCodeIntl();
  if (!item.listing?.requiresPaidPlan) return null;
  const label = intl.formatMessage({ id: "settings.plugins.store.requiresPaidPlan" });
  const badgeLabel = intl.formatMessage({ id: "settings.plugins.store.paidPlanBadge" });
  return (
    <ControlHintTooltip title={label}>
      <span
        data-testid="plugin-store-paid-plan-badge"
        data-plugin-id={item.id}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-plugin-paid-plan-badge)] px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-[var(--color-plugin-paid-plan-badge-foreground)]"
        aria-label={label}
      >
        <Crown className="size-3" aria-hidden="true" />
        {badgeLabel}
      </span>
    </ControlHintTooltip>
  );
}

/** 已安装条目的「…」菜单：启用/禁用、更新（有更新时）、卸载。卡片与详情页共用。 */
export function PluginStoreItemMenu({
  item,
  actions,
  triggerClassName,
  triggerVariant = "ghost",
  triggerSize = "icon-md",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  triggerClassName?: string;
  triggerVariant?: "ghost" | "outline";
  triggerSize?: "icon-md" | "icon-lg";
}) {
  const { intl } = useZCodeIntl();
  const enabled = item.info?.enabled ?? false;
  const updatePending = canUpdatePluginItem(item);
  const busy = isItemBusy(item, actions);
  const canToggleEnabled = Boolean(item.info && actions.onSetEnabled);
  // 分隔线不应跟随 item.installed 无条件渲染；启停/更新/恢复配置都不出现时，
  // 菜单只剩「卸载」一项，上方却留下一条孤立横线。分隔线只在卸载前确有其他操作项时才有意义。
  const hasActionsBeforeUninstall =
    canToggleEnabled || updatePending || Boolean(actions.onResetConfig);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/**
         * 原实现重复声明 data-testid，导致 TSX 编译报错 TS17001，
         * 仅保留一个测试 id 即可。
         */}
        <Button
          type="button"
          data-testid="plugin-store-item-menu"
          data-plugin-id={item.id}
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          aria-label={intl.formatMessage({ id: "settings.plugins.store.menu.label" })}
          onClick={(event) => event.stopPropagation()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <MoreHorizontal className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {canToggleEnabled ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-enabled"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onSetEnabled?.(item.id, !enabled)}
          >
            <Power className="size-4" aria-hidden="true" />
            {enabled
              ? intl.formatMessage({ id: "settings.plugins.store.menu.disable" })
              : intl.formatMessage({ id: "settings.plugins.store.menu.enable" })}
          </DropdownMenuItem>
        ) : null}
        {updatePending ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-update"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onUpdate(item.id)}
          >
            <Download className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.detail.update" })}
          </DropdownMenuItem>
        ) : null}
        {actions.onResetConfig ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-reset-config"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onResetConfig?.(item.id)}
          >
            {intl.formatMessage({ id: "settings.plugins.store.menu.resetConfig" })}
          </DropdownMenuItem>
        ) : null}
        {item.installed ? (
          <>
            {hasActionsBeforeUninstall ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid="plugin-store-menu-uninstall"
              data-plugin-id={item.id}
              variant="destructive"
              disabled={busy}
              onSelect={() => actions.onUninstall(item.id)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.detail.uninstall" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 安装/恢复胶囊按钮（未安装条目的卡片与详情页主按钮共用）。 */
export function PluginStoreInstallButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  const installing =
    actions.operationId === `plugin:install:${item.name}@${item.marketplace}` ||
    actions.operationId === `plugin:restore:${item.id}`;
  return (
    <Button
      type="button"
      data-testid="plugin-store-install"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      disabled={installing}
      onClick={(event) => {
        event.stopPropagation();
        runUserAction({
          input: { featureId: "extension.plugin", action: "install", trigger: "button" },
          operation: () => actions.onInstall(item),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "plugin_install",
        });
      }}
    >
      {installing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
      {installing
        ? intl.formatMessage({ id: "settings.plugins.marketplace.installing" })
        : intl.formatMessage({ id: "settings.plugins.store.install" })}
    </Button>
  );
}

/** 已安装条目的「可更新」角标：列表/卡片标题行直接标出哪个插件有更新，与详情页入口共用判定。 */
export function PluginStoreUpdateBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "installedMeta" | "orphaned"> | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (!canUpdatePluginItem(item)) return null;
  const label = intl.formatMessage({ id: "settings.plugins.list.updateAvailable" });
  return (
    <span
      data-testid="plugin-store-update-badge"
      data-plugin-id={item?.id}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/14 px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-success dark:bg-success/18"
      aria-label={label}
    >
      <Download className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/** 行内「更新」胶囊：已安装且可更新的条目原地触发更新，不必进详情页。 */
export function PluginStoreUpdateButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem | null | undefined;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  if (!item || !canUpdatePluginItem(item)) return null;
  const updating = actions.operationId === `plugin:update:${item.id}`;
  return (
    <Button
      type="button"
      data-testid="plugin-store-card-update"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      disabled={actions.operationId !== null}
      onClick={(event) => {
        event.stopPropagation();
        actions.onUpdate(item.id);
      }}
    >
      {updating ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3.5" aria-hidden="true" />
      )}
      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
    </Button>
  );
}

/**
 * 商店卡片（双列网格单元）：40px 头像 + 显示名 + 单行截断描述；
 * 尾部动作：已安装 → 「…」菜单，未安装 → 「安装」胶囊。点击主体进入详情页。
 */
export function PluginStoreCard({
  item,
  actions,
  locale,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const displayName = resolveItemDisplayName(item, locale);
  const description = resolveItemDescription(item, locale);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="plugin-store-card"
      data-plugin-id={item.id}
      className="group/card flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => actions.onOpenDetail(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.onOpenDetail(item.id);
        }
      }}
    >
      <PluginStoreAvatar item={item} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {displayName}
          </span>
          <PluginStorePaidPlanBadge item={item} />
          <PluginStoreUpdateBadge item={item} />
        </div>
        {item.orphaned ? (
          <div
            data-testid="plugin-store-source-degraded"
            data-plugin-id={item.id}
            className="mt-0.5 flex items-center gap-1 truncate text-ui-sm text-warning"
          >
            <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {intl.formatMessage({ id: "settings.plugins.store.sourceMissing" })}
            </span>
          </div>
        ) : null}
        {description ? (
          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.installed ? (
          <>
            <PluginStoreUpdateButton item={item} actions={actions} />
            {/* 旧版误写 suppression 后可能只剩安装记录、没有运行时 info；
                此时仍须保留卸载菜单，让用户能清理安装记录与脏 suppression。 */}
            <PluginStoreItemMenu item={item} actions={actions} />
          </>
        ) : (
          <PluginStoreInstallButton item={item} actions={actions} />
        )}
      </div>
    </div>
  );
}
