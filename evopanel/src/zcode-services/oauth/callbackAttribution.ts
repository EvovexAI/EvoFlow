import type { OAuthLoginAttribution } from "@zcode/shared";

const ATTRIBUTION_PARAM_KEYS = ["channel_id", "utm_source", "utm_campaign"] as const;

export function parseOAuthLoginAttribution(
  searchParams: URLSearchParams,
): OAuthLoginAttribution | undefined {
  const attribution: OAuthLoginAttribution = {};

  for (const key of ATTRIBUTION_PARAM_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) {
      attribution[key] = value;
    }
  }

  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

export function hasOAuthAuthorizationCode(searchParams: URLSearchParams): boolean {
  return Boolean(searchParams.get("code") || searchParams.get("authCode"));
}
