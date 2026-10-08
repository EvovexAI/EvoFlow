import { useRef } from "react";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";

type StableAccountAccess = ZCodeProviderAccountAccess | ZCodeAccountAccess;

/** Schema 解析会为同一份 Account Access 生成新对象；hook 依赖必须按配置值稳定。 */
export function useStableAccountAccess(
  accountAccess: StableAccountAccess | null | undefined,
): StableAccountAccess | undefined {
  const normalized = accountAccess ?? undefined;
  const key = JSON.stringify(accountAccess ?? null);
  const stable = useRef({ key, value: normalized });
  if (stable.current.key !== key) {
    stable.current = { key, value: normalized };
  }
  return stable.current.value;
}
