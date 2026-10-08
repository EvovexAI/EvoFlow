import type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * 账号不可用原因，只回答"为什么不可用"。
 *
 * provider-refactor 之后 UI 只能看到 availability=unavailable + entitled=false，
 * "未登录"、"未连接"、"凭据获取/校验失败"、"服务端明确无该套餐权益"被抹平成同一件事，导致
 * 用户已登录但没有套餐时被显示成"未连接"。原因必须随 State 一起下发，UI 才不需要
 * 用二次请求去猜（不可用 provider 不会再发起权益查询）。
 */
export type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * 账号实时事实，不是配置 Overlay，也不写入用户设置。
 * current 表示匹配当前账号访问上下文：Start 可与当前付费套餐同时为 true；Off-Peak 不定义。
 */
export interface AccountProviderState {
  readonly availability: "available" | "pending" | "unavailable" | "unknown";
  readonly entitled: boolean;
  /** 仅在 availability === "unavailable" 时有意义；unknown 表示本轮无法判定原因。 */
  readonly unavailableReason?: AccountProviderUnavailableReason;
  readonly current?: boolean;
  /** 同一快照的账号/连接身份，仅供状态变化隔离；不持久化、不包含凭据。 */
  readonly connectionKey?: string;
  /** Unix 秒；与 billing effective_at 的单位一致。 */
  readonly effectiveAt?: number;
}

export type AccountProviderStates = Readonly<Record<string, AccountProviderState>>;
