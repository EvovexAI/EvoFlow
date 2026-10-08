export type PipSessionEvent =
  | {
      kind: "turn-started";
      sessionId: string;
      turnId: string;
      sequenceNumber?: number;
      eventId?: string;
    }
  | {
      kind: "focus-changed";
      sessionId: string | null;
      revision: number;
      sourceWindowId: string;
      sequenceNumber?: number;
      eventId?: string;
    }
  | {
      kind: "turn-ended" | "turn-completed" | "turn-failed" | "tool-scheduled" | "tool-started";
      sessionId: string;
      turnId?: string;
      sequenceNumber?: number;
      eventId?: string;
      outcome?: "completed" | "failed";
      toolCallId?: string;
    }
  | {
      kind: "session-closed";
      sessionId: string;
      turnId?: string;
      sequenceNumber?: number;
      eventId?: string;
    };
