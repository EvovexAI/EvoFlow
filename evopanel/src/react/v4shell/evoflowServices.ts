/**
 * EvoFlow v4 shell — ``IServiceAccessor`` 组装。
 *
 * zcode-ui 只消费它读到的那几个服务面；未接入的服务经 Proxy 在**方法调用**时才报错
 * （属性访问安全，React render 期不会因读取服务引用而崩溃）。
 */

import { Event } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { evoflowAgentService } from "./evoflowAgentService.js";

type BroadcastMessage = { type?: string; payload?: unknown };

/** 进程内广播：EvoFlow v4 shell 当前单窗口运行，跨窗口广播暂无必要。 */
const broadcastService = {
  async send(_message: BroadcastMessage): Promise<void> {
    /* 单窗口：无跨进程接收方 */
  },
  async acquireClaim(key: string): Promise<unknown> {
    return { acquired: true, key, token: `claim-${key}` };
  },
  async commitClaim(_lease: unknown): Promise<void> {},
  async releaseClaim(_lease: unknown): Promise<void> {},
  tryClaim(key: string): boolean {
    const claimed = (broadcastService as unknown as { _claims?: Set<string> })._claims ?? (
      ((broadcastService as unknown as { _claims?: Set<string> })._claims = new Set<string>())
    );
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  },
  onMessage: Event.None as Event<BroadcastMessage>,
};

const knownServices: Record<string, unknown> = {
  zcodeAgentService: evoflowAgentService,
  broadcastService,
};

function rejectingService(name: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "then" || prop === "toJSON" || typeof prop === "symbol") return undefined;
        // `on*` 事件工厂返回空事件流（构造期订阅不能炸）；其余方法调用时才拒绝。
        if (prop.startsWith("on")) {
          return () => Event.None;
        }
        return () =>
          Promise.reject(
            new Error(`[v4shell] services.${name}.${prop} 尚未接入 EvoFlow 后端（H3-C+）`),
          );
      },
    },
  );
}

export const evoflowServices: IServiceAccessor = new Proxy(
  {} as IServiceAccessor,
  {
    get(_target, prop: string) {
      if (prop in knownServices) return knownServices[prop];
      if (typeof prop === "symbol") return undefined;
      return rejectingService(prop);
    },
  },
);
