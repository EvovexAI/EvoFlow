/**
 * CUA 输入框常驻入口按钮。
 *
 * 纯展示件：所有状态判定都在 useCuaComposerEntry / cuaComposerEntryState，这里只负责
 * 「不可见就不渲染」以及把 view 映射成 DOM。视觉上刻意与 toolbar 其它控件同权重，避免在不可用场景误导用户以为装了就能用。
 */
import { memo } from "react";
import { MonitorCogIcon } from "lucide-react";
import { TID_V4_COMPOSER_CUA_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import {
  useCuaComposerEntry,
  type UseCuaComposerEntryParams,
} from "@/hooks/useCuaComposerEntry.js";

type V4ComposerCuaEntryProps = UseCuaComposerEntryParams;

/**
 * 平台门前置层：平台不支持（或宿主根本没提供 platform / services context）时连内层都不挂载。
 *
 * 拆两层的原因有二：
 * 1. 语义——「不可见就不该有任何后台开销」。平台门不过时不建立 settings 订阅、不读插件 store、
 *    不起权限轮询，比在内层判完再返回 null 更彻底。
 * 2. 健壮性——composer 会在没有 PlatformProvider / ServiceProvider 的宿主（含既有的组件级
 *    测试）里渲染。内层用的 usePlatform / useServices 在缺 provider 时会抛异常，把整个
 *    composer 拖崩。这里用 optional 变体判定，缺失即静默降级为不渲染。
 */
function V4ComposerCuaEntryImpl(props: V4ComposerCuaEntryProps) {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const platformSupported =
    platform !== null &&
    services !== null &&
    (supportsLocalMacCuaPermissionOnboarding(platform) || supportsLocalWindowsCuaEntry(platform));
  if (!platformSupported) return null;
  return <V4ComposerCuaEntryMounted {...props} />;
}

function V4ComposerCuaEntryMounted(props: V4ComposerCuaEntryProps) {
  const { intl } = useZCodeIntl();
  const { view, onActivate } = useCuaComposerEntry(props);
  const label = intl.formatMessage({ id: "chat.toolbar.computerUse.label" });

  // 余下三层可见性门（设置页隐藏 / mac 服务缺失 / 电脑控制未启用）→ 不渲染 DOM。
  if (!view.visible) return null;
  const tooltip = intl.formatMessage({ id: view.tooltipMessageId });

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_CUA_ENTRY}
        data-composer-collapse-priority="0"
        // e2e / 排障锚点：对外 UI 态与禁用原因，避免测试去反推颜色类名。
        data-cua-state={view.uiState}
        data-cua-interaction-disabled={view.interactionDisabled ? "true" : "false"}
        aria-label={label}
        // aria-disabled 只反映「暂时不能操作」（session-busy），这也是唯一没有点击动作的情形。
        // 其余状态（就绪 / 错误 / 启用中）都是状态指示而非禁用按钮，一并标 disabled 会让屏幕
        // 阅读器把正常就绪的入口读成不可用。禁用态用 aria-disabled + 点击短路而非原生 disabled，
        // 因为原生 disabled 在多数浏览器上不触发 hover，用户就看不到「会话进行中」的解释。
        aria-disabled={view.interactionDisabled || undefined}
        onClick={view.clickAction === "open-settings" ? onActivate : undefined}
        className={
          "group/cua h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:size-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:p-0 " +
          (view.interactionDisabled ? "opacity-50" : "")
        }
      >
        <MonitorCogIcon className="size-4 shrink-0" aria-hidden />
        <span
          className="inline-flex whitespace-nowrap group-data-[composer-compact=true]/cua:hidden"
          data-cua-label
        >
          {label}
        </span>
        {/* M7：状态色点已按产品决策移除——入口不承载状态展示，状态读数在设置页
            （打开即按需启动 Helper 并读真值）。 */}
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerCuaEntry = memo(V4ComposerCuaEntryImpl);
