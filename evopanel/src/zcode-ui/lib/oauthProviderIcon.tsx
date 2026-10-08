import type { OAuthProviderId } from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { LogInIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import bigModelIcon from "@/assets/provider-icons/logo-bigmodel.svg";
import zaiIcon from "@/assets/provider-icons/logo-zai.svg";

const OAUTH_PROVIDER_ICON_SRC: Partial<Record<OAuthProviderId, string>> = {
  [BIGMODEL_PROVIDER_ID]: bigModelIcon,
  [ZAI_PROVIDER_ID]: zaiIcon,
};

export function renderOAuthProviderIcon(provider: OAuthProviderId, className?: string) {
  const src = OAUTH_PROVIDER_ICON_SRC[provider];
  if (!src) {
    return <LogInIcon className={cn("shrink-0", className)} />;
  }

  return (
    <img src={src} alt="" aria-hidden="true" className={cn("shrink-0 object-contain", className)} />
  );
}
