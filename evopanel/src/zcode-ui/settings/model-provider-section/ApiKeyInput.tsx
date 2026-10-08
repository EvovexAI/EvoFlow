import { EyeIcon, EyeOffIcon } from "lucide-react";
import { TID_MODEL_PROVIDER_API_KEY_INPUT } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";

export function ApiKeyInput({
  value,
  visible,
  readOnly,
  onChange,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onToggleVisibility,
}: {
  value: string;
  visible: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  onToggleVisibility: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="relative">
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        type={visible && !readOnly ? "text" : "password"}
        size="lg"
        data-testid={TID_MODEL_PROVIDER_API_KEY_INPUT}
        className="pr-10 h-9"
        placeholder={intl.formatMessage({
          id: "settings.modelProvider.apiKeyPlaceholder",
        })}
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(event) => {
          if (!readOnly) {
            onChange(event.target.value);
          }
        }}
        onBlur={readOnly ? undefined : onBlur}
        onKeyDown={readOnly ? undefined : onKeyDown}
        onCompositionStart={readOnly ? undefined : onCompositionStart}
        onCompositionEnd={readOnly ? undefined : onCompositionEnd}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={readOnly}
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        onClick={onToggleVisibility}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
