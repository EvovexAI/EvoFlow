import type { ReactNode } from "react";
import { PluginIcon } from "@/components/PluginIcon.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * 商店条目头像：listing.icon（仅 https）优先，加载失败或缺失时降级为
 * `bg-surface` 圆角方形容器中的中性 Blocks 图标，避免无图插件产生过多装饰色，
 * 并与真实图标的外层形态保持一致，防止图片加载失败时发生圆形/方形视觉跳变。
 * 设计稿的图标资源只是图形本身，外层语义化容器负责主题背景；对整张图片
 * dark:invert 会把 Android 绿色等品牌色反相，因此这里保留资源原始颜色。
 */
export function PluginStoreAvatar({
  item,
  className,
  iconClassName,
  fallbackIcon,
}: {
  item: Pick<StorePluginItem, "name" | "listing"> & Partial<Pick<StorePluginItem, "id">>;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  return (
    <PluginIcon
      src={item.listing?.icon}
      pluginId={item.id}
      className={className}
      iconClassName={iconClassName}
      fallbackIcon={fallbackIcon}
    />
  );
}
