export interface UiActionEvent {
  actionName: string;
  source: 'user' | 'ai' | 'system';
}

export function createUiActionEvent(event: UiActionEvent): UiActionEvent {
  return event;
}

