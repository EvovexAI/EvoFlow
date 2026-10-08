import { create } from "zustand";
import type { ISubagentsService } from "@zcode/services";
import {
  normalizeAgentProviderToZCodeAgent,
  type AgentSummary,
  type AgentsCapability,
  type ZCodeProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";

interface SubagentsContextSnapshot {
  workspacePath: string;
  workspaceIdentity: string | null;
  provider: ZCodeProvider;
  agents: AgentSummary[];
  capability: AgentsCapability | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

interface SubagentsContextStoreState {
  contexts: Record<string, SubagentsContextSnapshot>;
  initialize: (
    workspacePath: string,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (
    workspacePath: string,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  setEnabled: (
    workspacePath: string,
    provider: ZCodeProvider,
    agentId: string,
    enabled: boolean,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
}

const inFlightLoads = new Map<string, ReturnType<ISubagentsService["list"]>>();
const latestRequestIds = new Map<string, number>();
let nextRequestId = 0;

export function getSubagentsContextKey(
  workspacePath: string,
  provider: ZCodeProvider,
  workspaceIdentity?: string | null,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}::${normalizeAgentProviderToZCodeAgent(provider)}`;
}

function updateContext(
  state: SubagentsContextStoreState,
  key: string,
  update: SubagentsContextSnapshot,
): Pick<SubagentsContextStoreState, "contexts"> {
  return { contexts: { ...state.contexts, [key]: update } };
}

function loadAgents(
  key: string,
  workspacePath: string,
  provider: ZCodeProvider,
  subagentsService: ISubagentsService,
  workspaceIdentity?: string,
  bypassCache = false,
): ReturnType<ISubagentsService["list"]> {
  if (!bypassCache) {
    const current = inFlightLoads.get(key);
    if (current) return current;
  }
  const request = subagentsService
    .list({ workspacePath, workspaceIdentity, provider })
    .finally(() => {
      if (inFlightLoads.get(key) === request) inFlightLoads.delete(key);
    });
  inFlightLoads.set(key, request);
  return request;
}

async function loadContext(
  params: {
    workspacePath: string;
    provider: ZCodeProvider;
    subagentsService: ISubagentsService;
    workspaceIdentity?: string;
    bypassCache: boolean;
  },
  set: (
    updater: (state: SubagentsContextStoreState) => Partial<SubagentsContextStoreState>,
  ) => void,
  get: () => SubagentsContextStoreState,
): Promise<void> {
  const provider = normalizeAgentProviderToZCodeAgent(params.provider);
  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const key = getSubagentsContextKey(params.workspacePath, provider, workspaceIdentity);
  const existing = get().contexts[key];
  const requestId = ++nextRequestId;
  latestRequestIds.set(key, requestId);
  set((state) =>
    updateContext(state, key, {
      workspacePath: params.workspacePath,
      workspaceIdentity: workspaceIdentity ?? null,
      provider,
      agents: existing?.agents ?? [],
      capability: existing?.capability ?? null,
      loading: existing?.loaded !== true,
      loaded: existing?.loaded ?? false,
      error: null,
    }),
  );
  try {
    const result = await loadAgents(
      key,
      params.workspacePath,
      provider,
      params.subagentsService,
      workspaceIdentity,
      params.bypassCache,
    );
    if (latestRequestIds.get(key) !== requestId) return;
    set((state) =>
      updateContext(state, key, {
        workspacePath: params.workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
        provider,
        agents: result.agents,
        capability: result.capability,
        loading: false,
        loaded: true,
        error: null,
      }),
    );
  } catch (error) {
    if (latestRequestIds.get(key) !== requestId) return;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[subagents] workspace context load failed", {
      workspacePath: params.workspacePath,
      workspaceIdentity,
      provider,
      error: message,
    });
    set((state) =>
      updateContext(state, key, {
        ...(state.contexts[key] ?? {
          workspacePath: params.workspacePath,
          workspaceIdentity: workspaceIdentity ?? null,
          provider,
          agents: [],
          capability: null,
          loaded: false,
        }),
        loading: false,
        error: message,
      }),
    );
  }
}

export const useSubagentsContextStore = create<SubagentsContextStoreState>((set, get) => ({
  contexts: {},
  async initialize(workspacePath, provider, subagentsService, workspaceIdentity) {
    const key = getSubagentsContextKey(workspacePath, provider, workspaceIdentity);
    // 多个可见 pane 会各自挂载 Subagents 消费者。旧单例把“当前 workspace”
    // 当成全局可变字段，跨 workspace pane 会互相触发 initialize；按 workspaceKey+provider
    // 分桶后，每个 effect 只订阅自己的稳定快照。
    if (get().contexts[key]) return;
    await loadContext(
      { workspacePath, provider, subagentsService, workspaceIdentity, bypassCache: false },
      set,
      get,
    );
  },
  async refresh(workspacePath, provider, subagentsService, workspaceIdentity) {
    await loadContext(
      { workspacePath, provider, subagentsService, workspaceIdentity, bypassCache: true },
      set,
      get,
    );
  },
  async setEnabled(workspacePath, provider, agentId, enabled, subagentsService, workspaceIdentity) {
    try {
      await subagentsService.setEnabled({ agentId, enabled });
      await get().refresh(workspacePath, provider, subagentsService, workspaceIdentity);
    } catch (error) {
      const key = getSubagentsContextKey(workspacePath, provider, workspaceIdentity);
      const message = error instanceof Error ? error.message : String(error);
      set((state) => {
        const existing = state.contexts[key];
        return existing
          ? updateContext(state, key, { ...existing, loading: false, error: message })
          : {};
      });
    }
  },
}));
