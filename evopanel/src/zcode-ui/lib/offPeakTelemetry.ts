import {
  type IPlatformService,
  type OffPeakTaskCreateResult,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { legacyTelemetryProviderId } from "@/lib/providerTelemetryIdentity.js";

type OffPeakCreateEventRegion = "app.session" | "app.automations";

interface OffPeakCreateTelemetrySource {
  eventRegion: OffPeakCreateEventRegion;
  templateId: string;
}

interface OffPeakCreateTelemetrySnapshot extends OffPeakCreateTelemetrySource {
  modelName: string;
  modelProvider: string;
}

type TelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

/** submit 同步阶段冻结来源/模板/模型，后续导航或表单变化不得改写本次 attempt。 */
export function freezeOffPeakCreateTelemetrySnapshot(params: {
  source?: OffPeakCreateTelemetrySource;
  model?: string | null;
  providerId?: string | null;
}): OffPeakCreateTelemetrySnapshot {
  return {
    eventRegion: params.source?.eventRegion ?? "app.automations",
    templateId: params.source?.templateId ?? "",
    modelName: params.model?.trim() ?? "",
    modelProvider: legacyTelemetryProviderId(params.providerId?.trim() ?? ""),
  };
}

function buildOffPeakCreateResultTelemetryPayload(
  snapshot: OffPeakCreateTelemetrySnapshot,
  result: OffPeakTaskCreateResult,
): TelemetryEventPayload {
  const common = {
    result: result.ok ? "success" : "failure",
    template_id: snapshot.templateId,
    model_name: snapshot.modelName,
    model_provider: snapshot.modelProvider,
    provider_name: result.providerName,
  };
  return {
    elementName: "off_peak_task_create_result",
    eventRegion: snapshot.eventRegion,
    eventType: "result",
    eventText: "",
    eventExtraDetail: result.ok
      ? {
          ...common,
          off_peak_task_id: result.task.offPeakTaskId,
          ticket_initial_state: result.ticketInitialState,
          queue_position: result.queuePosition === undefined ? "" : String(result.queuePosition),
        }
      : {
          ...common,
          failure_stage: result.failureStage,
          error_category: result.errorCategory,
          error_code: result.errorCode,
        },
  };
}

export function reportOffPeakCreateResult(
  platform: TelemetryPlatform,
  snapshot: OffPeakCreateTelemetrySnapshot,
  result: OffPeakTaskCreateResult,
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    buildOffPeakCreateResultTelemetryPayload(snapshot, result),
    "off-peak-telemetry",
  );
}

/** 单次 submit 的业务结果与 exactly-once report 调度边界。 */
export async function createAndReportOffPeakTask(
  platform: TelemetryPlatform,
  snapshot: OffPeakCreateTelemetrySnapshot,
  create: () => Promise<OffPeakTaskCreateResult>,
): Promise<OffPeakTaskCreateResult> {
  const result = await create();
  void reportOffPeakCreateResult(platform, snapshot, result);
  return result;
}
