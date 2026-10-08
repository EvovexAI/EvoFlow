import type {
  AccountAccessIdentityInput,
  AccountRequestAuthInput,
  AccountRequestAuthMaterial,
  AccountRequestAuthResolver,
} from "./accountProviderRequestAuthService.js";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";

/**
 * 请求期 Account 鉴权边界。
 *
 * 服务按 Active Model 的静态 family/mode 约束，从当前账号连接解析请求材料。
 * 它不保存 Provider Config，也不提供 Registry fallback。
 */
export interface IAccountRequestAuthService {
  resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial>;
  assertCurrent(input: AccountAccessIdentityInput): Promise<void>;
}

export function createAccountRequestAuthService(
  resolver: AccountRequestAuthResolver,
): IAccountRequestAuthService {
  return {
    resolveAccessCurrent(access) {
      return resolver.resolveAccessCurrent(access);
    },
    resolveCurrent(input) {
      return resolver.resolveCurrent(input);
    },
    assertCurrent(input) {
      return resolver.assertCurrent(input);
    },
  };
}

export type {
  AccountRequestAuthInput,
  AccountAccessIdentityInput,
  AccountRequestAuthMaterial,
  AccountRequestAuthResolver,
} from "./accountProviderRequestAuthService.js";
