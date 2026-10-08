/**
 * CUA 输入框常驻入口按钮的状态推导（零依赖纯函数）。
 *
 * 为什么抽成纯函数：状态组合是「平台 × 隐藏开关 × 插件态 × 权限态 × session busy」的笛卡尔积，
 * 放在组件或 hook 里就只能靠搭 store mock 来测，覆盖不全。这里不 import React、不读 store，
 * 全部输入由调用方（useCuaComposerEntry）注入。
 */
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";
import { isCuaPermissionTccGranted } from "@/lib/cuaPermissionStatusStore.js";
import type { StatusDotTone } from "@/settings/StatusDot.js";

/**
 * 对外 4 个 UI 态；内部细分状态只用于日志，不直接暴露给用户。
 *
 * 无 "disabled"（插件未启用）态：电脑控制默认关闭后，未启用
 * 不再渲染成灰点拉新按钮，而是整个不渲染（见 isEntryVisible 的插件门），该态因此不可达。
 */
export type CuaComposerEntryUiState =
  | "starting"
  /** 懒启动：Helper 未运行（正常空闲，首次使用自动启动）——中性灰点，不是错误。 */
  | "idle"
  | "permission-required"
  | "ready"
  | "error";

interface CuaComposerEntryInputs {
  /** macOS 本地桌面且具备 CUA onboarding 能力（UA + preload capability 双判）。 */
  macLocalDesktop: boolean;
  /** Windows 本地桌面。 */
  windowsLocalDesktop: boolean;
  /** 设置页「在输入框显示电脑操作按钮」已关闭（内部 hidden 态）。 */
  hiddenBySettings: boolean;
  /** cuaPermissionService 是否存在；远端 host 上为 false。 */
  permissionServiceAvailable: boolean;
  /** zcode-cua 插件启用态。 */
  pluginEnabled: boolean;
  /** zcode-cua 插件正在切换中。 */
  pluginToggling: boolean;
  /** 最近一次 zcode-cua 插件操作失败。 */
  pluginError: boolean;
  /** Helper 权限状态。入口不查询权限，恒为 null（idle 中性态）；真值只在设置页读。 */
  permissionStatus: CuaPermissionStatusResult | null;
  /** 当前 workspace 内任一 task 的 turn 正在运行。 */
  sessionBusy: boolean;
}

export type CuaComposerEntryView =
  | { visible: false }
  | {
      visible: true;
      uiState: CuaComposerEntryUiState;
      tone: StatusDotTone;
      spinning: boolean;
      tooltipMessageId: string;
      /**
       * open-settings = 跳设置页 computerUse 区；none = 仅 hover tooltip。
       * 可见态一律 open-settings，只有 session-busy 覆盖时为 none（见 resolve 函数尾部注释）。
       */
      clickAction: "open-settings" | "none";
      /** session-busy 覆盖：置灰且不响应点击。不改 uiState 与 tone。 */
      interactionDisabled: boolean;
    };

const TOOLTIP_MESSAGE_ID: Record<CuaComposerEntryUiState, string> = {
  idle: "chat.toolbar.computerUse.tooltip.idle",
  starting: "chat.toolbar.computerUse.tooltip.starting",
  "permission-required": "chat.toolbar.computerUse.tooltip.permissionRequired",
  ready: "chat.toolbar.computerUse.tooltip.ready",
  error: "chat.toolbar.computerUse.tooltip.error",
};

const BUSY_TOOLTIP_MESSAGE_ID = "chat.toolbar.computerUse.tooltip.sessionBusy";

/**
 * 四层可见性门。任一不过 → 不渲染 DOM，而不是渲染成 disabled 按钮：
 * 不可用场景下留一个灰按钮会误导用户以为「装了就能用」。
 */
function isEntryVisible(inputs: CuaComposerEntryInputs): boolean {
  // 平台门：remote workspace / linux 本地 / 普通 Web / 手机远控都不满足。
  if (!inputs.macLocalDesktop && !inputs.windowsLocalDesktop) return false;
  // 设置门：用户显式隐藏后不再渲染，且不因重启或版本更新自愈。
  if (inputs.hiddenBySettings) return false;
  // 服务门：mac 的状态全部来自 Helper；服务缺失时按钮无法反映任何真值。
  // Windows 无 TCC、不读 Helper 权限，因此不受此门约束。
  if (inputs.macLocalDesktop && !inputs.permissionServiceAvailable) return false;
  // 电脑控制插件未启用时不显示入口，避免默认关闭或用户手动关闭后，
  // 输入框仍常驻一个用于推广的灰色按钮，让关闭状态难以辨认。
  // 例外是切换中：toggling 时 pluginEnabled 还是切换前的旧值，一并挡掉会让「开启中」
  // 的 spinner 消失成空档，用户从设置页切回会话时看不到任何进度。
  if (!inputs.pluginEnabled && !inputs.pluginToggling) return false;
  return true;
}

/**
 * 内部态判定，自上而下短路（优先级自高到低固定）。
 *
 * 前置条件：调用方已过 isEntryVisible，因此这里必然满足 pluginEnabled || pluginToggling。
 * 「插件未启用」不再是一个 UI 态，而是不渲染，所以本函数不再有对应分支。
 */
function resolveUiState(inputs: CuaComposerEntryInputs): CuaComposerEntryUiState {
  // toggling 优先级最高：切换过程中的中间态不应被旧的 enabled/权限值覆盖。
  // 它同时兜住了「未启用 + 切换中」这唯一能过插件门的未启用组合。
  if (inputs.pluginToggling) return "starting";
  if (inputs.pluginError) return "error";

  // Windows 无 TCC：插件启用即就绪，不参与权限判定。
  if (!inputs.macLocalDesktop) return "ready";

  // 懒启动入口不承载状态展示，permissionStatus 恒为 null——
  // 不存在「冷启动查询中」的中间态（查询会按需启动 Helper，挂载即查等于打开 app
  // 就拉起 Helper）。null 归入 idle 中性态；真值只在设置页（打开时查询）读取。
  if (inputs.permissionStatus === null) return "idle";

  // Helper 不健康（状态里没有 accessibility 字段）→ 错误态，对应「Helper 启动失败」。
  if (!isCuaPermissionStatusAvailable(inputs.permissionStatus)) {
    // 带 idle 标记的 unavailable 是 Helper 空闲自退后的正常回包（300s 无访问），
    // 不是错误。只有拿到明确失败（无 idle 标记）才报 error。
    if ((inputs.permissionStatus as { idle?: true }).idle === true) return "idle";
    return "error";
  }

  // 权限是否可用需要实测，但常驻入口只能走只读刷新：主动截图探针必须是显式
  // 用户意图（上游 shouldRunCuaScreenCaptureProbe 要求 includeFunctionalProbes），
  // 后台刷新拿到的 screenCaptureProbeOk 恒为 false。若拿它判就绪，已完成授权的用户会永远
  // 停在「缺少 macOS 权限」黄点。这里与设置页权限行同源改用 TCC 口径；真正不可用时工具
  // 返回普通错误，由模型按原始原因恢复，Renderer 不自动触发权限引导。
  return isCuaPermissionTccGranted(inputs.permissionStatus) ? "ready" : "permission-required";
}

export function resolveCuaComposerEntryView(inputs: CuaComposerEntryInputs): CuaComposerEntryView {
  if (!isEntryVisible(inputs)) return { visible: false };

  const uiState = resolveUiState(inputs);
  // session-busy 是可交互性覆盖：切换插件会让该 workspace 全部会话的工具集变化、
  // prompt 缓存失效，运行中代价最大。它不改 uiState / tone，全部 turn 结束后自动恢复。
  // 简化（用户决策）：输入框入口不再承载状态色点——固定可点、固定进设置页；
  // 状态展示职责完全交给设置页（打开即按需启动 Helper 并读真值）。sessionBusy 不再禁用点击。
  const interactionDisabled = false;

  return {
    visible: true,
    uiState,
    tone: "subtle",
    spinning: uiState === "starting",
    tooltipMessageId: interactionDisabled ? BUSY_TOOLTIP_MESSAGE_ID : TOOLTIP_MESSAGE_ID[uiState],
    // 过去只有「未启用」与
    // permission-required 可点，ready / starting / error 三态是纯状态灯。
    // 线上表现是用户走完授权、按钮变绿后再点毫无反应，
    // 读起来像坏了；而设置页 computerUse 区在任何状态下都有可做的事——插件开关、权限行、
    // 错误详情全在那儿。故取消可点态白名单，可见即可跳，只有 session-busy 覆盖时不响应
    // （那时按钮已置灰并换成「会话进行中」tooltip，再允许跳转会与视觉表现矛盾）。
    clickAction: interactionDisabled ? "none" : "open-settings",
    interactionDisabled,
  };
}
