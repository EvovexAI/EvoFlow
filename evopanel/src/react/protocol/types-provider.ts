/**
 * Stub for ``@zcode/provider`` — minimal placeholder.
 *
 * ZCode provider types: model provider interfaces (Anthropic / OpenAI / etc).
 */

export interface ZCodeProviderDescriptor {
  id: string
  displayName: string
  kind: 'anthropic' | 'openai' | 'google' | 'bedrock' | 'local'
  baseUrl?: string
}

export interface ZCodeProviderContext {
  list(): Promise<ZCodeProviderDescriptor[]>
  resolve(id: string): ZCodeProviderDescriptor | null
}

export const zcodeProviders: ZCodeProviderContext = {
  list: async () => [],
  resolve: () => null,
}