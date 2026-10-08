export interface SessionMessageSendRequested {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
}

export interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}
