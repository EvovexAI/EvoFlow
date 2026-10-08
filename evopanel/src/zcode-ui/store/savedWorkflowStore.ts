// 已保存工作流中枢的读缓存。
// 按 workspaceKey 分片；磁盘仍是唯一权威（不变式 2）——缓存只服务同一页内的重渲染，
// 变更后一律 `bypass` 刷新（skillStore 的同一条教训：复用 in-flight Promise 会拿到旧扫描）。
import { create } from "zustand";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowInvalidEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsListResult,
} from "@zcode/shared";
import type { IZCodeAgentService, ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import { logger } from "@/logger.js";

/** 一页里最多拉多少条 run 来算「上次运行」；一个项目的活跃工作流很少超过这个数。 */
const SAVED_WORKFLOW_RUNS_PAGE = 50;

/**
 * 声明输出需要：useSavedWorkflowGlobalGroup 的返回类型引用它，tsc -d 要求可命名；
 * knip 看不到这种用法，故标 public。
 * @public
 */
export interface SavedWorkflowWorkspaceState {
  entries: ZCodeSavedWorkflowEntry[];
  invalid: ZCodeSavedWorkflowInvalidEntry[];
  runs: ZCodeSavedWorkflowRun[];
  /** 扫过的目录（本地绝对路径），全局组据此 watch；未加载或列表未回时为 null。 */
  dir: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** 列表调用的 JSON-RPC 错误码（有则填）；全局组用 -32602 区分「旧 agent 不支持」与其他错误。 */
  errorCode: number | null;
}

const EMPTY_SAVED_WORKFLOW_STATE: SavedWorkflowWorkspaceState = {
  entries: [],
  invalid: [],
  runs: [],
  dir: null,
  loading: false,
  loaded: false,
  error: null,
  errorCode: null,
};

interface SavedWorkflowStoreState {
  byWorkspaceKey: Record<string, SavedWorkflowWorkspaceState>;
  load: (
    target: ZCodeAgentSavedWorkflowTarget,
    agentService: IZCodeAgentService,
    options?: { bypassCache?: boolean },
  ) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * 读缓存的分片键：全局档（`scope:"global"` 且不带 workspace）
 * 用固定键 `"global"`——它跨项目、由 services 自选载体，不该与任何项目的 workspaceKey 混淆；
 * 项目档仍按 `resolveWorkspaceKey` 分片。
 */
function savedWorkflowStoreKey(target: ZCodeAgentSavedWorkflowTarget): string {
  if (target.scope === "global" && !target.workspacePath) return "global";
  return resolveWorkspaceKey({
    workspacePath: target.workspacePath ?? "",
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  });
}

/** 从抛出的错误里取 JSON-RPC code（ChannelClient 保留 error.code）；取不到回 null。 */
function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

async function fetchWorkspace(
  target: ZCodeAgentSavedWorkflowTarget,
  agentService: IZCodeAgentService,
): Promise<{ list: ZCodeWorkflowsListResult; runs: ZCodeSavedWorkflowRun[] }> {
  // 列表与运行历史并行；运行历史失败不拖垮列表（journal 缺席时中枢照常能看、能管）。
  const [list, runs] = await Promise.all([
    agentService.listSavedWorkflows(target),
    agentService
      .listSavedWorkflowRuns({ ...target, limit: SAVED_WORKFLOW_RUNS_PAGE })
      .then((result) => result.runs)
      .catch((error: unknown) => {
        logger.warn("[savedWorkflowStore] 拉取运行历史失败，按无记录处理", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as ZCodeSavedWorkflowRun[];
      }),
  ]);
  return { list, runs };
}

export const useSavedWorkflowStore = create<SavedWorkflowStoreState>((set) => ({
  byWorkspaceKey: {},
  async load(target, agentService, options = {}) {
    const key = savedWorkflowStoreKey(target);
    if (!options.bypassCache) {
      const current = inFlight.get(key);
      if (current) return current;
    }
    set((state) => ({
      byWorkspaceKey: {
        ...state.byWorkspaceKey,
        [key]: { ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE), loading: true },
      },
    }));
    const request = fetchWorkspace(target, agentService)
      .then(({ list, runs }) => {
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              entries: list.workflows,
              invalid: list.invalid,
              runs,
              dir: list.dir,
              loading: false,
              loaded: true,
              error: null,
              errorCode: null,
            },
          },
        }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[savedWorkflowStore] 拉取已保存工作流失败", { error: message });
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE),
              loading: false,
              loaded: true,
              error: message,
              errorCode: extractErrorCode(error),
            },
          },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
}));

export function selectSavedWorkflowState(
  state: SavedWorkflowStoreState,
  target: ZCodeAgentSavedWorkflowTarget | null,
): SavedWorkflowWorkspaceState {
  if (!target) return EMPTY_SAVED_WORKFLOW_STATE;
  return state.byWorkspaceKey[savedWorkflowStoreKey(target)] ?? EMPTY_SAVED_WORKFLOW_STATE;
}
