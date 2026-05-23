export interface ToolCallEvent {
  toolName: string;
  status: 'success' | 'error';
}

export function createToolCallEvent(event: ToolCallEvent): ToolCallEvent {
  return event;
}

