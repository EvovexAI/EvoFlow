import {
  resolveWorkspaceTelemetryDetail,
  type IPlatformService,
  type SessionCreateClientKind,
  type SessionCreateSource,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

interface SessionCreateInput {
  sessionId: string;
  messageId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  source: SessionCreateSource;
  clientKind: SessionCreateClientKind;
}

function createSessionCreateReporter() {
  const reported = new Set<string>();
  return async (
    platform: Pick<IPlatformService, "reportTelemetryEvent"> | null | undefined,
    input: SessionCreateInput,
  ): Promise<void> => {
    if (!platform) return;
    const key = JSON.stringify([
      input.workspaceIdentity?.trim() || input.workspacePath,
      input.sessionId,
    ]);
    // 创建回调和 pending 恢复可能指向同一个 session；按身份去重，不按路径合并远端。
    if (reported.has(key)) return;
    reported.add(key);
    if (reported.size > 4096) reported.delete(reported.values().next().value!);
    await reportAppTelemetryEvent(
      platform,
      {
        elementName: "session_create",
        eventRegion: "app",
        eventType: "result",
        talkId: input.sessionId,
        messageId: input.messageId,
        eventExtraDetail: {
          create_source: input.source,
          client_kind: input.clientKind,
          ...resolveWorkspaceTelemetryDetail(input),
        },
      },
      "session-create-telemetry",
    );
  };
}

export const reportSessionCreate = createSessionCreateReporter();
