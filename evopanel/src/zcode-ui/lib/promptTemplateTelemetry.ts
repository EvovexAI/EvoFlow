import type { IPlatformService, TelemetryEventPayload } from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

const PROMPT_TEMPLATE_CLICK_EVENT_NAME = "prompt_template_ck";
const PROMPT_TEMPLATE_EVENT_REGION = "app.session";
const PROMPT_TEMPLATE_EVENT_TYPE = "ck";

interface PromptTemplateClickTelemetryParams {
  templateId: string;
  templateName: string;
  templatePrompt: string;
}

function buildPromptTemplateClickTelemetryPayload(
  params: PromptTemplateClickTelemetryParams,
): TelemetryEventPayload {
  return {
    elementName: PROMPT_TEMPLATE_CLICK_EVENT_NAME,
    eventRegion: PROMPT_TEMPLATE_EVENT_REGION,
    eventType: PROMPT_TEMPLATE_EVENT_TYPE,
    eventText: params.templateName,
    eventExtraDetail: {
      template_id: params.templateId,
      template_prompt: params.templatePrompt,
    },
  };
}

export function reportPromptTemplateClick(
  platform: Pick<IPlatformService, "reportTelemetryEvent">,
  params: PromptTemplateClickTelemetryParams,
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    buildPromptTemplateClickTelemetryPayload(params),
    "prompt-template-telemetry",
  );
}
