type TaskLifecycleEventType = "archived" | "deleted";

interface TaskLifecycleEvent {
  type: TaskLifecycleEventType;
  taskId: string;
  workspaceKey: string;
}

type TaskLifecycleListener = (event: TaskLifecycleEvent) => void;

const listeners = new Set<TaskLifecycleListener>();

export function subscribeTaskLifecycle(listener: TaskLifecycleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyTaskLifecycle(event: TaskLifecycleEvent): void {
  for (const listener of listeners) listener(event);
}
