/**
 * EvoFlow v4 shell — ``IServiceAccessor`` 组装。
 *
 * zcode-ui 只消费它读到的那几个服务面；未接入的服务经 Proxy 在**方法调用**时才报错
 * （属性访问安全，React render 期不会因读取服务引用而崩溃）。
 *
 * ⚠ 稳定性契约：同名服务的桩实例必须**每次访问返回同一对象**——ZCode 的 hook 把
 * service 引用放进 useEffect 依赖数组，身份不稳定会造成「effect 重跑 → 拒绝 → setState →
 * 再渲染」的死循环（bring-up 期实测踩过）。
 */

import { Event } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { evoflowAgentService } from "./evoflowAgentService.js";

type BroadcastMessage = { type?: string; payload?: unknown };

/** 进程内广播：EvoFlow v4 shell 当前单窗口运行，跨窗口广播暂无必要。 */
const broadcastClaims = new Set<string>();
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
    if (broadcastClaims.has(key)) return false;
    broadcastClaims.add(key);
    return true;
  },
  onMessage: Event.None as Event<BroadcastMessage>,
};

/**
 * 空订阅桩：兼容两类事件形状——
 *  1) Event 属性：`service.onDidChange(listener)` → IDisposable
 *  2) 事件工厂方法：`service.onDynamicFrame(params)(listener)` → IDisposable
 * 自返回函数 + dispose 方法使任意深度的调用链都得到可释放的空订阅。
 */
const emptySubscription: ReturnType<typeof makeEmptySubscription> = makeEmptySubscription();
function makeEmptySubscription() {
  const fn = (() => emptySubscription) as unknown as { dispose(): void };
  fn.dispose = () => {};
  return fn as never;
}

const knownServices: Record<string, unknown> = {
  zcodeAgentService: evoflowAgentService,
  broadcastService,
  /**
   * 最小模型选择视图：解锁 composer 发送门禁（useDraftModelReadinessGate 只要求
   * providers.some(p => p.models.length > 0)）。config 结构按
   * ``@zcode/shared/model-config`` 的 completeModelConfigDataSchema 手写；
   * optionSpecs 的 map 是受限 CEL 对象字面量。真实 provider/model 列表 H3-C 接
   * EvoFlow 模型目录后替换。
   */
  modelSelectionService: {
    onDidChange: emptySubscription,
    getView: async () => {
      const preferred = {
        providerId: "evoflow",
        modelId: "evoflow-default",
        options: { reasoningLevel: "medium" },
      };
      return {
        // effectiveSelection 是 composer 生效选择的权威来源
        // （useDraftConfigControl: view 存在时忽略 draft.modelSelection）。
        effectiveSelection: preferred,
        revision: 1,
      providers: [
        {
          providerId: "evoflow",
          providerName: "EvoFlow",
          templateId: "evoflow",
          // api.type 非空才会进模型选择组（supportsRegistryApiFormat 过滤）。
          config: { api: { type: "evoflow-agent" } },
          models: [
            {
              modelId: "evoflow-default",
              config: {
                enabled: true,
                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 200000,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: true,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: true,
                  supportsJsonSchemaOutput: false,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: true,
                },
                optionSpecs: {
                  reasoningLevel: {
                    values: ["low", "medium", "high"],
                    map: '{"low": {}, "medium": {}, "high": {}}',
                  },
                  maxOutputTokens: {
                    max: 128000,
                    map:
                      '{"low": {"maxOutputTokens": 4096}, "medium": {"maxOutputTokens": 16384}, "high": {"maxOutputTokens": 65536}}',
                  },
                },
              },
            },
          ],
        },
      ],
      preferredSelection: preferred,
      };
    },
  },
};

/** 每个服务名一个稳定实例；未实现方法返回稳定的 rejected promise 工厂。 */
const rejectingServiceCache = new Map<string, Record<string, unknown>>();

function rejectingService(name: string): unknown {
  let cached = rejectingServiceCache.get(name);
  if (cached) return cached;
  const methodCache = new Map<string, unknown>();
  cached = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "then" || prop === "toJSON" || typeof prop === "symbol") return undefined;
        const cachedMember = methodCache.get(prop);
        if (cachedMember !== undefined) return cachedMember;
        let member: unknown;
        if (prop.startsWith("on")) {
          // `on*` 事件面返回空订阅（构造期订阅不能炸）。
          member = emptySubscription;
        } else {
          member = () =>
            Promise.reject(
              new Error(`[v4shell] services.${name}.${prop} 尚未接入 EvoFlow 后端（H3-C+）`),
            );
        }
        methodCache.set(prop, member);
        return member;
      },
    },
  ) as Record<string, unknown>;
  rejectingServiceCache.set(name, cached);
  return cached;
}

const serviceAccessorCache = new Map<string, unknown>();

export const evoflowServices: IServiceAccessor = new Proxy(
  {} as IServiceAccessor,
  {
    get(_target, prop: string) {
      if (prop in knownServices) return knownServices[prop];
      if (typeof prop === "symbol") return undefined;
      let cached = serviceAccessorCache.get(prop);
      if (cached === undefined) {
        cached = rejectingService(prop);
        serviceAccessorCache.set(prop, cached);
      }
      return cached;
    },
  },
);
