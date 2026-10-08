import type { ProviderApiType } from "@zcode/provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_MODEL_PROVIDER_API_FORMAT_ITEM,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  testId,
} from "@zcode/shared";

const PROVIDER_CONNECTION_API_FORMATS: readonly ProviderApiType[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
];

const PROVIDER_CONNECTION_API_FORMAT_PATHS: Record<ProviderApiType, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-chat-completions": "/chat/completions",
  "openai-responses": "/responses",
};

const PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS: Record<ProviderApiType, string> = {
  "anthropic-messages": "settings.modelProvider.apiFormat.title.anthropicMessages",
  "openai-chat-completions": "settings.modelProvider.apiFormat.title.chatCompletions",
  "openai-responses": "settings.modelProvider.apiFormat.title.responses",
};

export function resolveProviderConnectionApiFormatOptions(): ProviderApiType[] {
  return [...PROVIDER_CONNECTION_API_FORMATS];
}

export function resolveProviderConnectionApiFormatDisplayLabel(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  format: ProviderApiType,
): string {
  const title = intl.formatMessage({
    id: PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS[format],
  });
  return `${title} (${PROVIDER_CONNECTION_API_FORMAT_PATHS[format]})`;
}

export function ProviderApiFormatSelect({
  apiFormatOptions = PROVIDER_CONNECTION_API_FORMATS,
  triggerId,
  value,
  onChange,
}: {
  apiFormatOptions?: readonly ProviderApiType[];
  triggerId?: string;
  value: ProviderApiType;
  onChange: (value: ProviderApiType) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Select value={value} onValueChange={(nextValue) => onChange(nextValue as ProviderApiType)}>
      <SelectTrigger
        id={triggerId}
        data-testid={TID_MODEL_PROVIDER_API_FORMAT_TRIGGER}
        size="lg"
        className="w-full justify-between"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {apiFormatOptions.map((format) => (
          <SelectItem
            key={format}
            value={format}
            data-testid={testId(TID_MODEL_PROVIDER_API_FORMAT_ITEM, format)}
          >
            {resolveProviderConnectionApiFormatDisplayLabel(intl, format)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
