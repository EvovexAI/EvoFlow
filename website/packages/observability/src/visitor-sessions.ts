export interface VisitorSessionEvent {
  visitorId: string;
  landingRoute?: string;
}

export function createVisitorSessionEvent(event: VisitorSessionEvent): VisitorSessionEvent {
  return event;
}

