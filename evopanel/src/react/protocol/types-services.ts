/**
 * Stub for ``@zcode/services`` — minimal placeholder.
 *
 * ZCode services layer holds: RPC client + per-workspace registry + automation runner.
 * v4_verbatim files use 26 imports; H2.5+ 才补齐完整。
 */

export interface ZCodeServiceDescriptor {
  name: string
  version: string
}

export interface ZCodeServiceRegistry {
  list(): Promise<ZCodeServiceDescriptor[]>
}

export interface ZCodeAutomationRunner {
  start(opts: { id: string; payload: unknown }): Promise<string>
  stop(id: string): Promise<void>
}

// ZCode uses ``useServices()`` React hook — minimal placeholder for H2.5.
export interface ZCodeServicesContext {
  registry: ZCodeServiceRegistry
  runner: ZCodeAutomationRunner
}

// Stub no-op client
export const zcodeServices: ZCodeServicesContext = {
  registry: {
    async list() {
      return []
    },
  },
  runner: {
    async start() {
      return ''
    },
    async stop() {
      // no-op
    },
  },
}