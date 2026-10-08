import type { BuiltinModelProviderId, IPlatformService } from "@zcode/shared";
import {
  reportAppTelemetryEvent,
  resolvePresetModelProviderTelemetryLabel,
} from "@/lib/appTelemetry.js";

export async function reportPresetSubscriptionSuccess(params: {
  platform: IPlatformService;
  presetId: BuiltinModelProviderId;
}) {
  await reportAppTelemetryEvent(
    params.platform,
    {
      elementName: "add_model_success",
      eventRegion: "app_setting",
      eventType: "ck",
      eventExtraDetail: {
        login_default: "1",
        model_provider: resolvePresetModelProviderTelemetryLabel(params.presetId),
      },
    },
    "ModelProviderSection",
  );
}
