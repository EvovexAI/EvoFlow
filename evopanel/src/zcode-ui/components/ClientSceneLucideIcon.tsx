import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { dynamicIconImports, type IconName } from "lucide-react/dynamic.mjs";

interface ClientSceneLucideIconProps extends Omit<LucideProps, "children"> {
  fallback: ReactNode;
  name?: string;
}

function isLucideIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(dynamicIconImports, name);
}

/** 按 Client Scenes 下发的 Lucide canonical 名称加载图标，未知名称保留调用方语义回退。 */
export function ClientSceneLucideIcon({
  fallback,
  name,
  ...iconProps
}: ClientSceneLucideIconProps) {
  const normalizedName = name?.trim();
  const [resolved, setResolved] = useState<{
    Icon: LucideIcon;
    name: IconName;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!normalizedName || !isLucideIconName(normalizedName)) return undefined;

    void dynamicIconImports[normalizedName]()
      .then((iconModule) => {
        if (!cancelled) {
          setResolved({ Icon: iconModule.default, name: normalizedName });
        }
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedName]);

  if (!normalizedName || resolved?.name !== normalizedName) return fallback;

  const Icon = resolved.Icon;
  return <Icon {...iconProps} data-client-scene-lucide-icon={normalizedName} />;
}
