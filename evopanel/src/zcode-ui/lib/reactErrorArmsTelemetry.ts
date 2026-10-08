import {
  redactTelemetryText,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/** ARMS 自定义事件名：React 错误边界捕获的渲染层异常 */
const REACT_ERROR_ARMS_EVENT_NAME = "perf_react_error";
/** ARMS 业务分组 */
const REACT_ERROR_ARMS_GROUP = "react_error";

/**
 * stack / componentStack 截断上限。
 * 原因：React 组件堆栈与错误栈可能很长，ARMS 单字段过长会被截断/拒绝，
 * 主动截断到上限保证关键头部（最近的抛错组件）一定上得去。
 */
const REACT_ERROR_STACK_MAX_LEN = 4000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

/**
 * 注入 ARMS reporter。
 *
 * 注意：必须在 renderer 入口 createRoot 之前注入，不能依赖 Root 的 effect。
 * 因为根级 AppErrorBoundary 的职责正是兜住 Root 自身渲染崩溃——若 reporter 走
 * Root effect 注入，Root 首帧就崩时 effect 从未执行，根级错误依旧丢失。
 */
export function setReactErrorArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

/**
 * 上报副本必须先脱敏：渲染层 stack 与 componentStack 在桌面端携带 `file:///Users/<用户名>/...`
 * 路径，error.message 也可能带工作区路径或用户内容。与 ARMS 自动采集 exception 事件共用
 * `redactTelemetryText`；本地日志与 fallback 恢复继续使用原值。截断仍保留 4000 上限，
 * 保证最近的抛错组件一定上得去。
 */
function redactStack(value: string): string {
  return redactTelemetryText(value, { maxLength: REACT_ERROR_STACK_MAX_LEN });
}

function buildReactErrorArmsPayload(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): ArmsCustomEventPayload {
  const errorStack = params.error.stack ? redactStack(params.error.stack) : undefined;
  const componentStack = params.componentStack ? redactStack(params.componentStack) : undefined;
  return {
    name: REACT_ERROR_ARMS_EVENT_NAME,
    group: REACT_ERROR_ARMS_GROUP,
    value: 1,
    properties: {
      error_name: params.error.name,
      error_message: redactTelemetryText(params.error.message),
      error_stack: errorStack || undefined,
      component_stack: componentStack || undefined,
      // 根级边界无 scope，统一记为 app；scoped 边界用各自的 scope 区分 sidebar/chat/settings 等。
      boundary_scope: params.scope ?? "app",
    },
  };
}

/**
 * 把 React 错误边界捕获的异常上报到 ARMS RUM。
 *
 * 背景：React 错误边界拦截子树渲染异常、阻止其冒泡到 window.onerror，
 * 而 Browser RUM SDK 靠 window.onerror / unhandledrejection 自动采集，
 * 故边界捕获的错误对 RUM 默认完全不可见，只能靠本地日志。这里把它转发到
 * 与 perf_crash 同一条 ARMS 自定义事件干道，补上这块盲区。
 */
export function reportReactErrorToArms(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): void {
  if (!armsReporter) {
    return;
  }

  try {
    const payload = buildReactErrorArmsPayload(params);
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      // 原因：ARMS 属观测链路，错误边界的 fallback 恢复流程不得因埋点失败而中断。
      logger.warn("[react-error] ARMS 自定义事件上报失败", {
        scope: params.scope ?? "app",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[react-error] ARMS 自定义事件上报异常", {
      scope: params.scope ?? "app",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
