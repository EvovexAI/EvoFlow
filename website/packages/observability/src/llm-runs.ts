export interface LlmRunEvent {
  sessionId?: string;
  route?: string;
  model: string;
  promptType?: string;
  status: "success" | "error" | "cancelled";
  latencyMs?: number;
}

export function createLlmRunEvent(event: LlmRunEvent): LlmRunEvent {
  return event;
}
