import { useState } from "react";
import { GlobeIcon } from "lucide-react";

function BrowserTabFaviconImage({ faviconUrl }: { faviconUrl: string }) {
  const [hasFailed, setHasFailed] = useState(false);

  if (hasFailed) return <GlobeIcon className="size-3.5" />;

  return (
    <img
      src={faviconUrl}
      alt=""
      className="size-3.5 rounded-sm object-contain"
      draggable={false}
      // renderer 直接加载 guest favicon 时会携带 localhost Referer，
      // 带防盗链的 CDN 会返回 403；禁用 referrer 后与网页 guest 自身的成功请求一致。
      referrerPolicy="no-referrer"
      onError={() => setHasFailed(true)}
    />
  );
}

/** Browser 与 Browser Use 共用的 favicon；请求失败时保持稳定的地球占位。 */
export function BrowserTabFavicon({ faviconUrl }: { faviconUrl?: string | null }) {
  if (!faviconUrl) return <GlobeIcon className="size-3.5" />;

  return <BrowserTabFaviconImage key={faviconUrl} faviconUrl={faviconUrl} />;
}
